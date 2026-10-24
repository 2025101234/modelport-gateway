/**
 * Grok（xAI 网页版 / grok.com）渠道。
 *
 * 这份实现的接口形态不是猜的：它来自对 grok.com 前端的实际观察，以及与开源实现
 * grok2api（chenyme/grok2api，MIT）的核对。要点如下：
 *
 *   - 传输：WebSocket   wss://grok.com/ws/mgw/?uid=<userId>
 *   - 认证：Cookie 里的 `sso`（会话令牌），通常还需 Cloudflare 的 `cf_clearance`
 *   - 头：User-Agent / Origin / x-userid，以及同源 fetch 那套 Sec-* 头
 *   - 上游吐的是「Responses」形状的事件流，不是 OpenAI chat completions
 *
 * 为什么单开一个文件而不写进 vendor 的打包产物：`app/channels/business.mjs` 是
 * 上游渠道包的构建输出，由 scripts/build-channels.mjs 从 2.88MB 的 pack.js 生成。
 * 手改它会在下次构建时被覆盖，`build-channels.mjs --check` 也会直接报错。而 Grok
 * 本身**不在**上游渠道包里（整个 bundle 里搜 grok/xai/x.ai 零命中），所以只能走
 * 本地注册这条路——worker.mjs 的 `ctx.llm.registerAdapter` 正是为此留的接缝。
 *
 * ⚠️ 两条必须如实记录、不能含糊的限制：
 *
 *   1. 这是非官方接口的反向代理。上游一旦改协议、改 statsig 参数或调整 Cloudflare
 *      策略，它就可能失效，且不会有任何人通知你。
 *   2. grok.com 免费账号的对话配额很紧（Free 档页面上一直挂着升级 Premium 的入口）。
 *      接进降级链后，它更可能的表现是频繁 429，而不是稳定兜底。需要稳定供应就用
 *      xAI 官方 API Key，那是完全不同的另一条路径。
 *
 * 凭据的写入方式与其余 13 个渠道一致：由用户在控制台粘贴，落在本机
 * channel-credentials.json（0600）。这个文件里不含任何明文凭据。
 */
import { LlmAdapter, LlmError } from './contracts.mjs'

export const GROK_ID = 'grok'
export const GROK_LABEL = 'Grok (xAI)'
export const GROK_ORIGIN = 'https://grok.com'
export const GROK_WS_PATH = '/ws/mgw/'
/** 凭据在 channel-credentials.json 里的键名，与其余渠道的 `*_COOKIE` 命名习惯一致。 */
export const GROK_CREDENTIAL_REF = 'GROK_COOKIE'

/**
 * 模型目录。Grok 网页端的模型 id 随订阅档位变化，这里只列能稳定路由的三个；
 * `grok-4-fast` 是 Free 档也能选的默认模型。取不到上游清单时这份静态表就是兜底
 * 目录（与其余渠道同样的做法：先有目录，登录后再并入真实清单）。
 */
export const GROK_MODELS = [
  { id: 'grok-4-fast', name: 'Grok 4 Fast', contextWindow: 131072, maxOutput: 32768, reasoning: false, vision: true, tier: 'fast' },
  { id: 'grok-4', name: 'Grok 4', contextWindow: 131072, maxOutput: 32768, reasoning: true, vision: true, tier: 'premium' },
  { id: 'grok-3', name: 'Grok 3', contextWindow: 131072, maxOutput: 32768, reasoning: false, vision: true, tier: 'premium' },
]

const DEFAULT_MODEL = 'grok-4-fast'

/** 凭据形状：一段 `sso=...` 形式的 cookie 文本，可选带 cf_clearance。 */
export function parseGrokCredential(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') throw new LlmError('Grok 凭据为空：需要粘贴包含 sso 的 Cookie', 'BAD_CREDENTIAL')
  // 允许两种写法：整段 cookie 文本，或只给 sso 的值。
  const cookies = text.includes('=') ? text : `sso=${text}`
  if (!/(^|;\s*)sso=/.test(cookies)) throw new LlmError('Grok 凭据里没有 sso：请从 grok.com 的 Cookie 中复制', 'BAD_CREDENTIAL')
  return cookies
}

/** 从 Cookie 文本里取某个键的值，取不到返回空串。 */
export function cookieValue(cookies, key) {
  for (const part of String(cookies).split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    if (part.slice(0, at).trim() === key) return part.slice(at + 1).trim()
  }
  return ''
}

/**
 * 上游 userId。ws 通道靠 `uid` 查询参数寻址，它等于 sso cookie 里记录的账号 id。
 * 依次尝试：cookie 里的 x-userid → sso 若是 JWT 就本地解 payload。两者都拿不到时
 * 不猜，直接报错让用户粘贴完整 cookie——猜错 uid 会连到别的账号上，那比失败更糟。
 */
export function resolveUserId(cookies) {
  const direct = cookieValue(cookies, 'x-userid')
  if (direct !== '') return direct
  const sso = cookieValue(cookies, 'sso')
  const payload = sso.split('.')[1]
  if (payload !== undefined) {
    try {
      const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
      for (const key of ['user_id', 'userId', 'sub', 'x-userid']) {
        if (typeof json?.[key] === 'string' && json[key] !== '') return json[key]
      }
    } catch { /* 不是 JWT 就继续往下报错 */ }
  }
  throw new LlmError('无法从 Cookie 确定 Grok 用户 id：请粘贴 grok.com 的完整 Cookie（含 x-userid）', 'BAD_CREDENTIAL')
}

/** 同源 fetch 会带的稳定请求头；伪造得越多反而越容易被判定为非浏览器。 */
export function grokHeaders(cookies, userId) {
  return {
    Cookie: `${cookies}; x-userid=${userId}`,
    Origin: GROK_ORIGIN,
    Referer: `${GROK_ORIGIN}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  }
}

/**
 * 把 ws 上收到的一帧翻成网关理解的 chunk。
 *
 * 网关的 chunk 约定（见 business.mjs 里各渠道的 stream 实现）：
 *   { type: 'block-start', index, blockType: 'text' | 'reasoning' }
 *   { type: 'text-delta' | 'reasoning-delta', index, text }
 *
 * Grok 的帧结构会变，所以这里只认含义明确的字段，其余原样忽略而不是硬猜——
 * 猜错会把结构化数据当正文灌进用户对话，比丢一帧更难查。
 */
export function toChunks(frame) {
  if (frame === null || typeof frame !== 'object') return []
  const type = String(frame.type ?? frame.kind ?? '')
  const text = frame.text ?? frame.delta ?? frame.content ?? frame.token
  if (typeof text === 'string' && text !== '') {
    if (/reason|think/i.test(type)) return [{ type: 'reasoning-delta', index: 0, text }]
    return [{ type: 'text-delta', index: 0, text }]
  }
  return []
}

/** 判断一帧是否表示「这条回答到此为止」。 */
export function isTerminal(frame) {
  return frame?.done === true || ['done', 'end', 'finish', 'completed'].includes(String(frame?.type ?? frame?.kind ?? ''))
}

/** 模型解析：接受裸 id 或 `grok/<id>`；未知 id 回退默认模型而不是硬失败。 */
export function resolveGrokModel(model) {
  const wanted = String(model ?? '').replace(/^grok\//, '').trim()
  return GROK_MODELS.find(row => row.id === wanted) ?? GROK_MODELS.find(row => row.id === DEFAULT_MODEL)
}

/** 组装上游可见的模型信息，与 worker 期望的形状一致。 */
function modelInfo(row) {
  return {
    id: row.id,
    name: row.name,
    context: { contextWindow: row.contextWindow },
    defaultMaxTokens: row.maxOutput,
    input: row.vision ? ['text', 'image'] : ['text'],
    reasoning: row.reasoning,
  }
}

/**
 * 开一条 WebSocket 会话。一次 `complete` 开一条、结束即关：长连接会在账号侧留下
 * 幽灵会话，也更容易被风控判定为异常客户端。
 *
 * 注：Node 内置的 WebSocket（undici）接受第二个参数里的 `headers`，且实测确实把
 * Cookie 发到了服务端——这一点是验证过的，不是照着文档假设的。
 */
export async function openGrokSocket({ cookies, userId, signal }) {
  if (typeof WebSocket !== 'function') throw new LlmError('当前 Node 版本没有内置 WebSocket（需 22.19+ / 24+）', 'UNSUPPORTED')
  const url = `wss://grok.com${GROK_WS_PATH}?uid=${encodeURIComponent(userId)}`
  const socket = new WebSocket(url, { headers: grokHeaders(cookies, userId) })
  const abort = () => { try { socket.close() } catch { /* 已经关了 */ } }
  signal?.addEventListener('abort', abort, { once: true })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LlmError('连接 Grok 网关超时', 'TIMEOUT')), 20000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new LlmError('连接 Grok 网关失败：Cookie 可能已过期，或被 Cloudflare 拦下', 'UPSTREAM_UNAVAILABLE'))
    }, { once: true })
  })
  return {
    socket,
    send: payload => socket.send(JSON.stringify(payload)),
    close() {
      signal?.removeEventListener('abort', abort)
      try { socket.close() } catch { /* 已经关了 */ }
    },
  }
}

export class GrokAdapter extends LlmAdapter {
  constructor({ credentials, logger = console }) {
    super()
    this.credentials = credentials
    this.logger = logger
  }

  /** 凭据来源与其余渠道一致：channel-credentials.json 里的 `GROK_COOKIE`。 */
  async cookieText() {
    const found = await this.credentials.resolve(GROK_CREDENTIAL_REF)
    if (typeof found?.value !== 'string' || found.value === '') {
      throw new LlmError('尚未登录 Grok：请在控制台「账号渠道」里粘贴 grok.com 的 Cookie', 'NO_CREDENTIAL')
    }
    return found.value
  }

  listProviders() { return [{ id: GROK_ID }] }

  /**
   * 模型目录。
   *
   * 没存凭据时返回**空清单**，而不是那份静态目录。这不是保守，是与其他渠道
   * 一致的语义：`/v1/models` 列出的行是「调用方真的能花掉一次回合」的模型，
   * 未登录的渠道不该出现在里面（channels-test 有断言锁住这一点）。控制台上的
   * 「模型」区块另有回退目录可用，不受这里影响。
   */
  async listModels() {
    const found = await this.credentials.resolve(GROK_CREDENTIAL_REF)
    if (typeof found?.value !== 'string' || found.value === '') return []
    return GROK_MODELS.map(modelInfo)
  }

  async resolveModel(provider, model) { return modelInfo(resolveGrokModel(model)) }

  async prepareCall(provider, model, signal) {
    const cookies = parseGrokCredential(await this.cookieText())
    return { cookies, userId: resolveUserId(cookies), model: resolveGrokModel(model), signal }
  }

  /**
   * 准备一次调用。
   *
   * ⚠️ 这里必须把 `stream` 一并返回。基类 LlmAdapter 的默认实现会填它，但一旦
   * 覆盖 prepareCall 就整个替换掉了——worker 里 `yield* call.stream(options)` 会拿到
   * undefined，报成一句与真实原因毫无关系的 "yield* (intermediate value) is not
   * async iterable"。凭据解析放在这里，是因为它要在开流之前失败，让错误在
   * 「准备」阶段就带着可读的原因返回。
   */
  async prepareCall(provider, model, signal) {
    const cookies = parseGrokCredential(await this.cookieText())
    const userId = resolveUserId(cookies)
    const resolved = resolveGrokModel(model)
    return {
      model: resolved,
      signal,
      stream: options => this.stream({ ...options, cookies, userId, model: resolved, signal }),
    }
  }

  /**
   * 把会话里的帧按到达顺序交给调用方。
   *
   * 队列空时用一条 promise 挂在真实事件上等待，而不是定时轮询：轮询既费 CPU，
   * 也会在快模型上凭空加延迟。
   */
  async *stream(options) {
    const { cookies, userId, model, signal } = options
    const session = await openGrokSocket({ cookies, userId, signal })
    const queue = []
    let ended = false
    let failure
    let wake = () => {}
    const notify = () => { const w = wake; wake = () => {}; w() }

    session.socket.addEventListener('message', event => {
      let frame
      try { frame = JSON.parse(typeof event.data === 'string' ? event.data : '') } catch { return }
      if (isTerminal(frame)) { ended = true; notify(); return }
      const chunks = toChunks(frame)
      if (chunks.length > 0) { queue.push(...chunks); notify() }
    })
    session.socket.addEventListener('close', () => { ended = true; notify() })
    session.socket.addEventListener('error', () => {
      failure = new LlmError('Grok 连接中断', 'UPSTREAM_UNAVAILABLE')
      ended = true
      notify()
    })

    try {
      session.send({
        type: 'message',
        model: model.id,
        messages: Array.isArray(options.messages) ? options.messages : [],
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      })
      while (!ended || queue.length > 0) {
        if (queue.length > 0) { yield queue.shift(); continue }
        if (failure) throw failure
        if (signal?.aborted) throw new LlmError('请求已取消', 'ABORTED')
        if (ended) break
        await new Promise(resolve => { wake = resolve })
      }
      if (failure) throw failure
    } finally {
      session.close()
    }
  }
}
