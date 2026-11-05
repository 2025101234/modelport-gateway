import { parentPort, workerData } from 'node:worker_threads'
import { createCredentials } from './credentials.mjs'
import { attachments } from './images.mjs'
import { toChatMessages, toToolDefs } from '../../src/messages.js'
import {
  apply, toGenerateOptions, toResponsesGenerateOptions, normalizeReasoningEffort,
  responsesReasoningEffort, normalizeMaxTokens, responsesMaxOutputTokens, markGatewayChannel,
  collectGatewayModels, collectGatewayEffortViews, toOpenAiModels,
} from './business.mjs'
import { GrokAdapter, GROK_ID, GROK_CREDENTIAL_REF, GROK_MODELS, parseGrokCredential, resolveUserId } from './grok.mjs'
import { WorkBuddyDesktopAdapter, providerForRegion } from './workbuddy-desktop/adapter.mjs'

/**
 * WorkBuddy / CodeBuddy 由本仓库自己实现（见 workbuddy-desktop/ 的模块头）。
 *
 * 这两个 provider 原本由上游渠道包的 `BuddyAuth` + `registerBuddyLlm` 提供，
 * 走「自己弹窗 OAuth 登录 + 按模型族猜 UA」的旧反代方式，现已失效，改为复用
 * 本机 / 搬运来的 WorkBuddy 桌面端登录态。
 *
 * ⚠️ 注册必须发生在 `apply(ctx)` **之前**：渠道包内部的
 * `registerAdapterIdempotent()` 在 provider id 重复时会「保留先注册者并跳过」，
 * 而 worker 自己的 registerAdapter 对重复 id 是**抛错**。所以先把新适配器登记
 * 进 `adapters`，再让渠道包尝试注册时命中下面这个能被它识别的重复错误文本，
 * 它就会安静地跳过 buddy/workbuddy，其余 12 家照常注册。
 *
 * 代价：渠道包里那两套旧 BuddyAuth 实例仍会被创建（无凭据、空账号池，定时
 * 刷新是 no-op），并且不会发起任何网络请求——这是不动 2.88MB pack.js 与
 * build-channels.mjs 的既定取舍，记录在此以免日后误以为它们还在工作。
 */
const desktopAdapters = new Map()
for (const region of ['cn', 'global']) {
  const provider = providerForRegion(region)
  const adapter = new WorkBuddyDesktopAdapter({
    region, provider, storeDir: workerData.dataDir,
    logger: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, message =>
      parentPort.postMessage({ type: 'log', level, message: String(message) })])),
  })
  desktopAdapters.set(provider, adapter)
}

const cleanups = []
const adapters = new Map()
const routes = new Map()
const controllers = new Map()
let closed = false
const send = message => parentPort.postMessage(message)
const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, message => send({ type: 'log', level, message: String(message) })]))
const credentials = createCredentials(workerData.dataDir)
const ctx = {
  platform: { channelHome: workerData.dataDir }, credentials, logger, attachments,
  connection: { fetch: { register(route) { routes.set(route.path, route) } } },
  get(name) { return this[name] },
  provide(name, value) {
    if (Object.hasOwn(this, name)) throw new Error(`服务重复注册：${name}`)
    this[name] = value
  },
  effect(body) {
    const cleanup = body()
    if (typeof cleanup === 'function') {
      if (closed) void cleanup()
      else cleanups.push(cleanup)
    }
    return cleanup
  },
  inject(names, body) { if (names.every(name => this[name] !== undefined)) return body(this) },
  emit() { send({ type: 'changed' }) },
  llm: {
    registerAdapter(providers, adapter) {
      for (const provider of providers) {
        if (adapters.has(provider)) {
          // 文本必须带 "already registered"：渠道包的 isDuplicateRegistrationError
          // 只认这类措辞，命中后它才会跳过而不是把整个 apply() 抛掉。
          throw new Error(`渠道 ${provider} already registered（保留先注册者）`)
        }
        adapters.set(provider, adapter)
      }
    },
    listProviders() { return [...adapters.keys()].map(id => ({ id })) },
    async listModels(provider) { return await adapters.get(provider)?.listModels(provider) ?? [] },
    async resolveModel(provider, model, signal) {
      const adapter = adapters.get(provider)
      if (!adapter) throw Object.assign(new Error('渠道不存在'), { statusCode: 404 })
      return adapter.resolveModel(provider, model, signal)
    },
    async resolveModelInfo(provider, model, signal) { return this.resolveModel(provider, model, signal) },
    async *stream(options) {
      const adapter = adapters.get(options.provider)
      if (!adapter) throw Object.assign(new Error('渠道不存在'), { statusCode: 404 })
      const call = await adapter.prepareCall(options.provider, options.model, options.signal)
      yield* call.stream(options)
    },
  },
}

async function models() {
  const onError = (provider, error) => logger.warn(`${provider} 模型目录读取失败：${error.message}`)
  const groups = (await Promise.all([...adapters.keys()].map(provider => collectGatewayModels({
    listProviders: () => [{ id: provider }],
    listModels: id => ctx.llm.listModels(id),
  }, onError)))).flat()
  const infos = new Map()
  const views = await collectGatewayEffortViews({
    async resolveModelInfo(provider, model) {
      const info = await ctx.llm.resolveModel(provider, model)
      infos.set(`${provider}/${model}`, info)
      return info
    },
  }, groups, onError)
  return toOpenAiModels(groups, views).map(row => ({
    ...row, channel: row.owned_by, vision: row.input?.includes('image') === true,
    context_window: row.context_window ?? infos.get(row.id)?.context?.contextWindow,
    max_tokens: row.max_tokens ?? infos.get(row.id)?.defaultMaxTokens,
  }))
}

async function rpc(call, signal) {
  // Grok 由本仓库自己实现，不在上游渠道包里，所以它的凭据读写不能走渠道包的
  // RPC（那边会答 unknown provider: grok）。在转发给渠道包之前先拦下这两条，
  // 其余 method 原样透传。
  if (call.method === 'grok.credential.set') {
    const value = call.payload?.cookie
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, error: { code: 'bad-request', message: '需要粘贴 grok.com 的 Cookie' } }
    }
    let cookies
    let userId
    try {
      cookies = parseGrokCredential(value)
      // 先校验再落盘：存进去却解析不出 uid 的凭据，只会在下次调用时才暴露问题。
      userId = resolveUserId(cookies)
    } catch (error) {
      // 凭据格式错是用户可修的问题，回 400 级错误并带上原因；不要让它变成
      // 500「请查看服务日志」——那条日志里写的正是用户需要看到的这句话。
      return { ok: false, error: { code: 'bad-request', message: String(error?.message ?? error) } }
    }
    await credentials.set(GROK_CREDENTIAL_REF, cookies.trim())
    send({ type: 'changed' })
    return { ok: true, value: { userId } }
  }
  if (call.method === 'grok.credential.state') {
    const found = await credentials.resolve(GROK_CREDENTIAL_REF)
    const present = typeof found?.value === 'string' && found.value !== ''
    let userId
    if (present) { try { userId = resolveUserId(parseGrokCredential(found.value)) } catch { userId = undefined } }
    return { ok: true, value: { present, userId } }
  }
  // 管理面的模型目录：即使没登录也要给出目录，控制台才有东西可展示。
  // 这与 /v1/models 是两回事——后者只列「真能花掉一次回合」的模型，未登录的
  // 渠道不该出现在里面（listModels 在无凭据时返回空正是为此）。
  if (call.method === 'model.list' && call.payload?.provider === GROK_ID) {
    const models = GROK_MODELS.map(row => ({ id: row.id, name: row.name, contextWindow: row.contextWindow, maxOutput: row.maxOutput }))
    return { ok: true, value: { models } }
  }
  if (call.method === 'account.list' && call.payload?.provider === GROK_ID) {
    const found = await credentials.resolve(GROK_CREDENTIAL_REF)
    const present = typeof found?.value === 'string' && found.value !== ''
    // Grok 只有一个「账号」，就是那条 Cookie；没有就返回空列表而不是报错。
    return { ok: true, value: { accounts: present ? [{ id: 'grok-cookie', provider: GROK_ID, nickname: 'grok.com Cookie' }] : [] } }
  }
  // WorkBuddy / CodeBuddy 的凭据来自桌面 App 登录态（或服务器上搬运的凭据文件），
  // 不是 channel-credentials.json 里的 OAuth 账号。渠道包的 RPC 对它们一律不适用，
  // 必须在透传前拦下：能如实回答的只读操作就回答，写操作明确拒绝，绝不静默落入
  // 旧逻辑（那会去读空账号池、报一句与真实原因无关的「未配置凭据」）。
  const desktop = desktopAdapters.get(call.payload?.provider)
  if (desktop !== undefined) {
    const method = call.method
    if (method === 'account.list') {
      await desktop.rescanNow()
      return { ok: true, value: { accounts: desktop.publicAccounts(), diagnostics: desktop.publicDiagnostics() } }
    }
    if (method === 'model.list') {
      const models = await desktop.publicCatalog()
      return { ok: true, value: { models, diagnostics: desktop.publicDiagnostics() } }
    }
    if (method === 'workbuddy.desktop.rescan') {
      const result = await desktop.rescanNow()
      send({ type: 'changed' })
      return { ok: true, value: { accounts: result.accounts.length, diagnostics: desktop.publicDiagnostics() } }
    }
    if (method === 'credits.balances') return { ok: true, value: { accounts: [] } }
    if (/^(account|login|model|credits)\./.test(method)) {
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: 'WorkBuddy / CodeBuddy 的登录态由本机桌面 App 或搬运来的凭据文件管理，'
            + '无需在此添加账号；请在 WorkBuddy 桌面端登录，或设置 WORKBUDDY_AUTH_FILE 后点「重新检测登录态」。',
        },
      }
    }
  }
  const route = routes.get('/api/channel-pack')
  if (!route) throw new Error('渠道管理接口未注册')
  const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ type: 'client-request', rpcId: 'standalone', method: 'channel-pack', payload: call }),
  }))
  const reply = await response.json()
  return reply.result
}

/**
 * WorkBuddy / CodeBuddy 桌面登录态渠道的受限直通分支。
 *
 * 这两个 provider 的上游本就是 OpenAI 形状的 `/v2/chat/completions`，插件的
 * `prepareChatBody` 也是直接在 OpenAI body 上加工。因此这里**不**走渠道包的
 * `toGenerateOptions` 二次投影（它会把消息转成 harness gateway 形状，丢工具调用
 * 与多模态信息），而是按请求来源拼出一份干净的 OpenAI chat body 交给新客户端。
 */
function desktopBody(request, provider, model) {
  const source = request.responsesBody ?? request.openAi
  let messages
  if (source && Array.isArray(source.messages)) messages = source.messages
  else if (source && Array.isArray(source.input)) messages = toChatMessages(source.input)
  else messages = toChatMessages(Array.isArray(request.messages) ? request.messages : [])
  const body = { model, messages }
  if (source && typeof source === 'object') {
    for (const key of ['tools', 'tool_choice', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'stream']) {
      if (source[key] !== undefined) body[key] = source[key]
    }
    if (typeof source.max_output_tokens === 'number' && body.max_tokens === undefined) body.max_tokens = source.max_output_tokens
    if (typeof source.reasoning_effort === 'string') body.reasoning_effort = source.reasoning_effort
    if (typeof source.instructions === 'string' && source.instructions !== '') {
      body.messages = [{ role: 'system', content: source.instructions }, ...body.messages]
    }
  } else {
    const harness = harnessBody(request)
    for (const key of ['tools', 'max_tokens', 'temperature', 'reasoning_effort']) {
      if (harness[key] !== undefined) body[key] = harness[key]
    }
  }
  return body
}

/**
 * Project the Anthropic/harness request shape onto the OpenAI body the channel
 * adapters parse. `/v1/messages` hands over harness messages and flat tools,
 * not an `openAi` body; without this the adapter rejects the turn for having no
 * messages and silently loses tools, max_tokens and temperature.
 */
function harnessBody(request) {
  const body = { messages: toChatMessages(Array.isArray(request.messages) ? request.messages : []) }
  if (Array.isArray(request.tools) && request.tools.length > 0) body.tools = toToolDefs(request.tools)
  if (typeof request.maxTokens === 'number') body.max_tokens = request.maxTokens
  if (typeof request.temperature === 'number') body.temperature = request.temperature
  if (typeof request.reasoningEffort === 'string' && request.reasoningEffort !== '') body.reasoning_effort = request.reasoningEffort
  return body
}

async function complete(request, id, signal) {
  const slash = request.model.indexOf('/')
  const provider = request.model.slice(0, slash)
  const model = request.model.slice(slash + 1)
  // 禁用模型和供应商必须同时影响统一 API，不能只隐藏页面。
  if (!(await ctx.llm.listModels(provider)).some(row => row.id === model)) throw Object.assign(new Error('模型不存在或已停用'), { statusCode: 404 })
  // 桌面登录态渠道走直通：它的上游是 OpenAI 形状，绕过渠道包的二次投影。
  const desktop = desktopAdapters.get(provider)
  if (desktop !== undefined) {
    const body = desktopBody(request, provider, model)
    for await (const chunk of desktop.streamBody(body, signal)) {
      if (signal.aborted) throw new Error('请求已取消')
      send({ type: 'chunk', id, chunk })
    }
    return
  }
  const body = { ...(request.responsesBody ?? request.openAi ?? harnessBody(request)), model: request.model }
  const resolved = await ctx.llm.resolveModel(provider, model, signal)
  const effort = normalizeReasoningEffort(request.responses ? responsesReasoningEffort(body) : body.reasoning_effort, resolved, provider, model,
    notice => logger.info(`${request.model}：思考档位 ${notice.requested} ${notice.applied ? `映射为 ${notice.applied}` : '使用模型默认'}`))
  const requested = request.responses ? responsesMaxOutputTokens(body) : body.max_completion_tokens ?? body.max_tokens
  const maxTokens = typeof requested === 'number' ? normalizeMaxTokens(requested, provider, model) : undefined
  const convert = request.responses ? toResponsesGenerateOptions : toGenerateOptions
  const options = await convert(body, signal, effort, maxTokens, { bridge: attachments }, dropped => logger.warn(`忽略无法表达的工具类型：${dropped.type}`))
  options.sessionId = `standalone:${String(body.user ?? body.conversation ?? 'shared')}`
  for await (const chunk of ctx.llm.stream(markGatewayChannel(options))) {
    if (signal.aborted) throw new Error('请求已取消')
    send({ type: 'chunk', id, chunk })
  }
}

parentPort.on('message', async message => {
  if (message.type === 'cancel') { controllers.get(message.id)?.abort(); return }
  if (message.type === 'close') {
    closed = true
    for (const controller of controllers.values()) controller.abort()
    credentials.dispose()
    for (const cleanup of cleanups.reverse()) { try { await cleanup() } catch {} }
    send({ type: 'closed' })
    return
  }
  const { id, type } = message
  const controller = new AbortController()
  controllers.set(id, controller)
  try {
    if (closed) throw new Error('渠道已停止')
    if (type === 'models') send({ type: 'result', id, value: await models() })
    else if (type === 'rpc') send({ type: 'result', id, value: await rpc(message.call, controller.signal) })
    else if (type === 'complete') { await complete(message.request, id, controller.signal); send({ type: 'result', id }) }
    else throw new Error('未知渠道操作')
  } catch (error) {
    send({ type: 'error', id, message: error.message, statusCode: error.statusCode ?? error.status })
  } finally { controllers.delete(id) }
})

// 先注册本仓库自有的两个桌面登录态适配器，让渠道包跳过它俩（见文件头注释）。
for (const [provider, adapter] of desktopAdapters) ctx.llm.registerAdapter([provider], adapter)
apply(ctx, { disableOpencode: true })
/**
 * Grok 不在上游渠道包里，所以由本仓库自己注册进来（见 grok.mjs 的模块头）。
 * 注册位置放在 apply 之后：apply 内部会注册上游其余渠道，后注册才能共用同一个
 * ctx.llm —— 渠道目录、模型清单和降级链都按 provider 聚合。
 */
ctx.llm.registerAdapter([GROK_ID], new GrokAdapter({ credentials, logger }))
send({ type: 'ready', providers: [...adapters.keys()] })
