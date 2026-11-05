/**
 * WorkBuddy 上游客户端：模型目录、聊天流式、token 刷新、错误分类。
 *
 * 按 dsh-connect-workbuddy（MIT, Copyright (c) 2026 LaoDing）的
 * `src/upstream.ts` 独立重写连接内核所需的子集；其 wire behavior 参照
 * corrinehu/dsh-workbuddy-connect（MIT）与 Sliverkiss/workbuddy2api（MIT）。
 * 逐条对齐的要点：
 *
 *   - 按凭据 `domain` 选 CN / global base；聊天与刷新都用 CLI 形态身份；
 *   - 目录必须以 **App 身份 UA** 读 `/v3/config`（CLI 身份的答复是严格子集，
 *     既不发布 modelPromotions 也不发布 modelTiers）；
 *   - 强制 `stream:true`、`developer`→`system`、会话头三元组（缺一个上游就
 *     回 11128 / conversation id missing）；
 *   - `tool_choice` 压平为字符串；**chat 请求绝不携带 refresh token**；
 *   - 系统提示词里的渠道指纹短语改写、首条消息中性化（11128 渠道校验）；
 *   - 刷新用 `X-Refresh-Token` + `X-Auth-Refresh-Source: workbuddy`；
 *   - 中英文额度不足 / 上下文过长 / 模型忙 / 11140 / 11128 的错误分类。
 *
 * 未移植：设备 turing token / machine id、积分倍率与活动徽标、生图与视频、
 * 每日签到、CLI 路线、loopback shim（见 NOTICE.md）。
 *
 * ⚠️ 这是非官方客户端接口：上游随时可能改协议或收紧限制，不提供长期可用承诺。
 *
 * @module app/channels/workbuddy-desktop/upstream
 */
import { randomBytes } from 'node:crypto'
import { regionOf } from './auth.mjs'
import { fallbackModels, selectCliModels } from './catalog.mjs'

export const CN_CHAT_BASE = 'https://copilot.tencent.com'
export const CN_BILLING_BASE = 'https://www.codebuddy.cn'
export const GLOBAL_BASE = 'https://www.workbuddy.ai'
export const GLOBAL_CONFIG_PATH = '/v3/config'
export const CN_MODELS_FALLBACK_PATH = '/v2/enterprises/personal/models'
export const CHAT_PATH = '/v2/chat/completions'
export const REFRESH_PATH = '/v2/plugin/auth/token/refresh'

/** 聊天通道的 UA；目录读取另用 {@link PRODUCT_UA}。 */
export const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
/** App 自己的 product UA（buildVlmGatewayHeaders 拼出的那个头）。 */
export const PRODUCT_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0'
export const APP_VERSION = /WorkBuddy\/([^\s]+)/.exec(PRODUCT_UA)?.[1] ?? '5.8.3'

/** 渠道闸门认可的中性开头；只用于 11128 的自愈重试，不替换用户自己的内容。 */
export const WORKBUDDY_FALLBACK_SYSTEM_PROMPT = 'You are a helpful assistant.'

/** 单次上游请求的兜底超时；调用方自己的 signal 仍优先。 */
const REQUEST_TIMEOUT_MS = 120_000
const CATALOG_TIMEOUT_MS = 20_000
const REFRESH_TIMEOUT_MS = 20_000

/** 把调用方 signal 与兜底超时合成一个 signal，避免上游挂住时整个网关卡死。 */
function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('WorkBuddy 上游请求超时')), timeoutMs)
  timer.unref?.()
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  return { signal: controller.signal, dispose: () => clearTimeout(timer) }
}

/** 上游实测会对这些「第三方 Agent 身份」开头返回 11128。 */
const UNAPPROVED_CHANNEL_OPENINGS = [
  'you are an ai agent powered by deepseek harness',
  'you are an ai agent running inside deepseek harness',
  'you are a coding agent powered by the ',
  'you are a coding agent running on the ',
  'you are claude code',
  'you are interacting with the user through the deepseek harness web gui',
  'you are working with the user inside the deepseek harness web gui',
]

/** 同义改写表：句子级匹配，避免整段字面量一改就失效。 */
const FINGERPRINT_REWRITES = [
  ['You are an AI agent powered by DeepSeek Harness', 'You are a helpful coding assistant'],
  ['You are an AI agent running inside DeepSeek Harness', 'You are a helpful coding assistant'],
  ['You are a coding agent powered by the ', 'You are a helpful coding assistant running with '],
  ['You are a coding agent running on the ', 'You are a helpful coding assistant running with '],
  ['You are interacting with the user through the DeepSeek Harness Web GUI', 'You are interacting with the user through a coding assistant'],
  ['You are working with the user inside the DeepSeek Harness Web GUI', 'You are working with the user inside a coding assistant'],
  ['You are Claude Code', 'You are a coding assistant'],
]

export function globalBase(domain) {
  const lowered = String(domain ?? '').trim().toLowerCase()
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'https://www.codebuddy.ai'
  return GLOBAL_BASE
}

export function chatBase(credential) {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_CHAT_BASE
}

function originReferer(credential) {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE
}

function acceptLanguageOf(credential) {
  return regionOf(credential.domain) === 'global' ? 'en-US,en;q=0.9' : 'zh-CN,zh;q=0.9,en;q=0.8'
}

/** 32 位小写 UUIDv7：官方客户端的请求 id 形状（上游会把 message id 回显成 SSE id）。 */
export function uuidv7(nowMs = Date.now()) {
  const bytes = randomBytes(16)
  for (let index = 0; index < 6; index++) {
    bytes[index] = Math.floor(nowMs / 2 ** (8 * (5 - index))) & 0xff
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes.toString('hex')
}

export function isUnapprovedChannelOpening(text) {
  const opening = String(text ?? '').replace(/^\s+/, '').toLowerCase()
  return UNAPPROVED_CHANNEL_OPENINGS.some(prefix => opening.startsWith(prefix))
}

export function rewriteChannelFingerprintPhrases(text) {
  let out = String(text ?? '')
  for (const [from, to] of FINGERPRINT_REWRITES) out = out.replaceAll(from, to)
  return out
}

/** 基础公共头（5.16.0 形态）。 */
export function legacyCommonHeaders(credential) {
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: originReferer(credential),
    Referer: `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/** 会话身份三元组：三者缺一，国际网关就回 11128。 */
export function conversationHeaders() {
  const id = uuidv7
  const messageId = id()
  const conversationRequestId = id()
  return {
    'X-Conversation-ID': id(),
    'X-Conversation-Request-ID': conversationRequestId,
    'X-Root-Request-ID': conversationRequestId,
    'X-Conversation-Message-ID': messageId,
    'X-Request-ID': messageId,
  }
}

export function attributionHeaders() {
  return {
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': APP_VERSION,
    'X-Product': 'WorkBuddy',
  }
}

/** 聊天请求头。安全红线：这里绝不出现 refresh token。 */
export function chatHeaders(credential) {
  return {
    ...legacyCommonHeaders(credential),
    'Content-Type': 'application/json',
    'X-CodeBuddy-Request': '1',
    'Accept-Language': acceptLanguageOf(credential),
    Authorization: `Bearer ${credential.accessToken}`,
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' } : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    ...attributionHeaders(),
    ...conversationHeaders(),
  }
}

/** 目录读取头：App 身份，不是 CLI 身份。 */
export function configHeaders(credential) {
  return {
    ...legacyCommonHeaders(credential),
    'User-Agent': PRODUCT_UA,
    Authorization: `Bearer ${credential.accessToken}`,
    ...credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
    ...credential.domain === '' ? {} : { 'X-Domain': credential.domain },
  }
}

/** 刷新端点头：X-Refresh-Token 只在这里出现。 */
export function refreshHeaders(credential) {
  return {
    ...legacyCommonHeaders(credential),
    'Content-Type': 'application/json',
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? {} : { 'X-Enterprise-Id': credential.enterpriseId },
  }
}

/** 会话必须以 system 开头，且 developer 要改写成 system（否则 11128）。 */
function ensureSystemHead(obj) {
  const messages = Array.isArray(obj.messages) ? obj.messages : []
  for (const message of messages) {
    if (message && typeof message === 'object' && message.role === 'developer') message.role = 'system'
  }
  if (messages.length === 0 || messages[0]?.role !== 'system') {
    obj.messages = [{ role: 'system', content: WORKBUDDY_FALLBACK_SYSTEM_PROMPT }, ...messages]
  }
}

function textPartOf(part) {
  if (typeof part === 'string') return part
  if (part && typeof part === 'object' && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text')) {
    return String(part.text ?? '')
  }
  return undefined
}

function rewriteMessages(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    if (typeof message.content === 'string') {
      message.content = rewriteChannelFingerprintPhrases(message.content)
    } else if (Array.isArray(message.content)) {
      message.content = message.content.map(part => {
        const text = textPartOf(part)
        return text === undefined ? part : { ...part, text: rewriteChannelFingerprintPhrases(text) }
      })
    }
  }
}

/** 把 OpenAI `tool_choice` 的对象写法压平为上游接受的字符串。 */
function normalizeToolChoice(obj) {
  if (!('tool_choice' in obj)) return
  const choice = obj.tool_choice
  if (choice === undefined || choice === null) { delete obj.tool_choice; return }
  if (typeof choice === 'string') { obj.tool_choice = choice.trim() || 'auto'; return }
  if (typeof choice === 'object' && typeof choice.type === 'string') {
    const name = choice.function?.name
    obj.tool_choice = choice.type === 'function' && typeof name === 'string' && name !== '' ? name : 'auto'
    return
  }
  delete obj.tool_choice
}

/**
 * 把网关交来的 OpenAI 请求体加工成上游要的形态。
 *
 * 这是通过 11128 渠道校验的必需项：强制流式、会话以 system 开头、指纹短语
 * 改写、`tool_choice` 压平。`neutralHead` 用于 11128 自愈重试（把系统提示词
 * 换成中性开头），不改动用户自己的消息内容。
 */
export function prepareChatBody(source, { neutralHead = false } = {}) {
  let obj
  try { obj = typeof source === 'string' ? JSON.parse(source) : structuredClone(source) } catch { return source }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return source
  obj.stream = true
  if (Array.isArray(obj.messages)) {
    for (const message of obj.messages) {
      if (message && typeof message === 'object' && message.role === 'developer') message.role = 'system'
    }
  }
  ensureSystemHead(obj)
  rewriteMessages(obj.messages)
  normalizeToolChoice(obj)
  if (neutralHead) {
    const first = obj.messages?.[0]
    if (first && first.role === 'system') {
      first.content = typeof first.content === 'string'
        ? `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n${first.content}`
        : [{ type: 'text', text: WORKBUDDY_FALLBACK_SYSTEM_PROMPT }, ...(Array.isArray(first.content) ? first.content : [])]
    }
  }
  return JSON.stringify(obj)
}

/** 上游业务码 / 文案 → 带 status 与 code 的错误，供 src/route/classify.js 分类。 */
export function classifyUpstreamError(status, bodyText) {
  const text = String(bodyText ?? '').toLowerCase()
  const codes = []
  try {
    const parsed = JSON.parse(bodyText)
    for (const candidate of [parsed, parsed?.error, parsed?.data]) {
      if (candidate && typeof candidate === 'object') {
        for (const key of ['code', 'businessCode', 'type']) if (candidate[key] !== undefined) codes.push(String(candidate[key]))
      }
    }
  } catch { /* 非 JSON 错误体，只按文案判 */ }
  const has = marker => codes.includes(marker) || text.includes(marker)
  let message = 'WorkBuddy 上游调用失败'
  try {
    const parsed = JSON.parse(bodyText)
    const detail = parsed?.error?.message ?? parsed?.msg ?? parsed?.message ?? parsed?.displayMsg
    if (typeof detail === 'string' && detail !== '') message = detail
  } catch { /* 保留默认 */ }
  const isCredit = ['insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted',
    'out of credit', 'quota exceeded', 'quota exhaust', 'payment required', '积分不足', '额度不足'].some(marker => text.includes(marker))
  if (has('11128') || text.includes('unapproved channel') || text.includes('conversation id missing')) {
    return Object.assign(new Error(`${message}（渠道校验 11128）`), { status: 400, statusCode: 400, code: 'CHANNEL_REJECT', channelGate: true })
  }
  if (has('11140') || text.includes('request illegal')) {
    return Object.assign(new Error(`${message}（策略拒绝 11140）`), { status: 400, statusCode: 400, code: 'CLIENT_ERROR' })
  }
  if (isCredit || status === 402) {
    return Object.assign(new Error(`${message}（额度不足）`), { status: 402, statusCode: 402, code: 'QUOTA_EXHAUSTED' })
  }
  if (status === 401) return Object.assign(new Error(`${message}（凭据失效）`), { status: 401, statusCode: 401, code: 'INVALID_CREDENTIAL' })
  if (status === 403) return Object.assign(new Error(`${message}（权限拒绝）`), { status: 403, statusCode: 403, code: 'PERMISSION_DENIED' })
  if (has('14003') || text.includes('model busy') || text.includes('less busy model')) {
    return Object.assign(new Error(`${message}（模型忙）`), { status: 429, statusCode: 429, code: 'RATE_LIMIT' })
  }
  if (status === 429 || has('6004')) {
    return Object.assign(new Error(`${message}（限流）`), { status: 429, statusCode: 429, code: 'RATE_LIMIT' })
  }
  if (text.includes('context') && (text.includes('too long') || text.includes('exceed') || text.includes('window'))) {
    return Object.assign(new Error(`${message}（上下文过长）`), { status: 400, statusCode: 400, code: 'CLIENT_ERROR' })
  }
  const effective = Number.isInteger(status) && status >= 400 ? status : 502
  return Object.assign(new Error(`${message}（HTTP ${effective}）`), { status: effective, statusCode: effective, code: effective >= 500 ? 'EAC_UPSTREAM_FAILED' : 'CLIENT_ERROR' })
}

/** 读模型目录：App 身份读 /v3/config，国内可降级到 /v2/enterprises/personal/models。 */
export async function fetchModels(credential, { signal, fetchImpl = fetch } = {}) {
  const base = chatBase(credential)
  const paths = [GLOBAL_CONFIG_PATH]
  if (regionOf(credential.domain) === 'cn') paths.push(CN_MODELS_FALLBACK_PATH)
  let lastError
  for (const configPath of paths) {
    const timed = withTimeout(signal, CATALOG_TIMEOUT_MS)
    try {
      const response = await fetchImpl(`${base}${configPath}`, {
        method: 'GET', headers: configHeaders(credential), signal: timed.signal,
      })
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`)
        if (response.status === 401 || response.status === 403) break
        continue
      }
      const payload = await response.json()
      const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload
      const models = selectCliModels(data)
      if (models.length > 0) return models
      lastError = new Error('workbuddy model catalog resolved to an empty list')
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
    } finally {
      timed.dispose()
    }
  }
  return fallbackModels(regionOf(credential.domain)).map(row => ({ ...row, fallback: true, ...lastError === undefined ? {} : { catalogError: lastError.message } }))
}

/** 刷新 token。返回合并后的 credential（失败抛带 status 的错误）。 */
export async function refreshToken(credential, { signal, fetchImpl = fetch } = {}) {
  if (!credential.refreshToken) throw Object.assign(new Error('WorkBuddy 凭据没有 refresh token：请重新登录或重新搬运凭据'), { status: 401, statusCode: 401, code: 'INVALID_CREDENTIAL' })
  const timed = withTimeout(signal, REFRESH_TIMEOUT_MS)
  let response
  try {
    response = await fetchImpl(`${chatBase(credential)}${REFRESH_PATH}`, {
      method: 'POST', headers: refreshHeaders(credential), body: '{}', signal: timed.signal,
    })
  } finally {
    timed.dispose()
  }
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { throw classifyUpstreamError(response.status, text) }
  if (!response.ok) throw classifyUpstreamError(response.status, text)
  const payload = data?.data && typeof data.data === 'object' ? data.data : data
  const accessToken = payload?.accessToken ?? payload?.access_token
  if (typeof accessToken !== 'string' || accessToken === '') throw classifyUpstreamError(response.status, text)
  return {
    ...credential,
    accessToken,
    ...typeof payload?.refreshToken === 'string' && payload.refreshToken !== '' ? { refreshToken: payload.refreshToken } : {},
    ...Number.isFinite(payload?.expiresIn) ? { expiresAtMs: Date.now() + payload.expiresIn * 1000 } : {},
    ...Number.isFinite(payload?.expiresAt) ? { expiresAtMs: payload.expiresAt > 1e12 ? payload.expiresAt : payload.expiresAt * 1000 } : {},
    lastRefreshAtMs: Date.now(),
  }
}

/**
 * 把上游 SSE 的一帧翻成网关的归一化 chunk（见 src/core/completion.js）。
 * 只认含义明确的字段，其余忽略——猜错会把结构化数据当正文灌进用户对话。
 */
export function toChunks(data, state) {
  const out = []
  const choice = data?.choices?.[0]
  const delta = choice?.delta
  if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') state.finishReason = choice.finish_reason
  const text = typeof delta?.content === 'string' ? delta.content : ''
  if (text !== '') {
    if (state.textBlock === undefined) {
      state.textBlock = state.nextIndex++
      out.push({ type: 'block-start', index: state.textBlock, blockType: 'text' })
    }
    state.text += text
    out.push({ type: 'text-delta', index: state.textBlock, text })
  }
  const reasoning = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content
    : typeof delta?.reasoning === 'string' ? delta.reasoning : ''
  if (reasoning !== '') {
    if (state.reasoningBlock === undefined) {
      state.reasoningBlock = state.nextIndex++
      out.push({ type: 'block-start', index: state.reasoningBlock, blockType: 'reasoning' })
    }
    state.thinking += reasoning
    out.push({ type: 'reasoning-delta', index: state.reasoningBlock, text: reasoning })
  }
  for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
    const wireIndex = call.index ?? 0
    if (typeof call.id === 'string' && call.id !== '') state.toolIds.set(wireIndex, call.id)
    const callId = state.toolIds.get(wireIndex) ?? `call_${wireIndex}`
    let block = state.toolCalls.get(wireIndex)
    if (block === undefined) {
      block = { index: state.nextIndex++, callId, text: '', announced: false }
      state.toolCalls.set(wireIndex, block)
      state.toolOrder.push(block.index)
    }
    block.callId = callId
    if (typeof call.function?.name === 'string' && call.function.name !== '') block.name = call.function.name
    const fragment = call.function?.arguments ?? ''
    block.text += fragment
    if (!block.announced) {
      if (typeof block.name !== 'string' || block.name === '') continue
      block.announced = true
      out.push({ type: 'block-start', index: block.index, blockType: 'tool-call' })
      out.push({ type: 'tool-call-delta', index: block.index, id: callId, name: block.name, argumentsDelta: block.text })
      continue
    }
    out.push({
      type: 'tool-call-delta', index: block.index, id: callId,
      ...block.name !== undefined ? { name: block.name } : {},
      argumentsDelta: fragment,
    })
  }
  if (data?.usage && typeof data.usage === 'object') {
    const usage = data.usage
    const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
    const prompt = usage.prompt_tokens ?? 0
    out.push({
      type: 'usage',
      usage: {
        inputTokens: cached > 0 ? prompt - cached : prompt,
        outputTokens: usage.completion_tokens ?? 0,
        ...cached > 0 ? { cacheReadTokens: cached } : {},
        ...usage.completion_tokens_details?.reasoning_tokens > 0
          ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens } : {},
      },
    })
  }
  return out
}

export function newStreamState() {
  return {
    nextIndex: 0, textBlock: undefined, reasoningBlock: undefined,
    text: '', thinking: '', toolIds: new Map(), toolCalls: new Map(),
    toolOrder: [], finishReason: undefined,
  }
}

/** 流结束后补齐 block-end 与 finish，供非流式折叠与降级链判定使用。 */
export function finalizeChunks(state) {
  const out = []
  for (const index of state.toolOrder) {
    const block = [...state.toolCalls.values()].find(candidate => candidate.index === index)
    if (!block || typeof block.name !== 'string' || block.name === '') continue
    out.push({ type: 'block-end', index, block: { type: 'tool-call', id: block.callId ?? '', name: block.name, arguments: block.text } })
  }
  if (state.text !== '') out.push({ type: 'block-end', index: state.textBlock, block: { type: 'text', text: state.text } })
  if (state.thinking.trim() !== '') out.push({ type: 'block-end', index: state.reasoningBlock, block: { type: 'reasoning', text: state.thinking } })
  const blockCount = out.length
  const kind = state.toolOrder.length > 0 ? 'tool-calls' : state.finishReason === 'length' ? 'max-tokens' : 'stop'
  out.push({ type: 'finish', reason: blockCount === 0 ? { kind: 'error', failure: { message: 'WorkBuddy 返回了空响应', code: 'EMPTY_RESPONSE' } } : { kind } })
  return out
}

/**
 * 一次聊天流式调用。
 *
 * 11128 渠道校验失败时按插件的两级阶梯自愈一次：先用中性系统头重试，仍失败
 * 才把错误交回给降级链。其余错误直接抛出（带 status/code，供 classify.js 判定）。
 */
export async function* chatStream(body, { credential, signal, fetchImpl = fetch, maxGateRetries = 1 } = {}) {
  let neutralHead = false
  let retriesLeft = maxGateRetries
  for (;;) {
    const payload = prepareChatBody(body, { neutralHead })
    const timed = withTimeout(signal, REQUEST_TIMEOUT_MS)
    let response
    try {
      response = await fetchImpl(`${chatBase(credential)}${CHAT_PATH}`, {
        method: 'POST', headers: chatHeaders(credential), body: payload, signal: timed.signal,
      })
    } finally {
      timed.dispose()
    }
    if (!response.ok) {
      const text = await response.text()
      const error = classifyUpstreamError(response.status, text)
      if (error.channelGate === true && retriesLeft > 0 && !signal?.aborted) {
        retriesLeft -= 1
        neutralHead = true
        continue
      }
      throw error
    }
    if (!response.body) throw Object.assign(new Error('WorkBuddy 未返回响应流'), { status: 502, statusCode: 502, code: 'EAC_UPSTREAM_FAILED' })
    const state = newStreamState()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let ended = false
    let retryPending = false
    try {
      while (!ended) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') { ended = true; break }
          let parsed
          try { parsed = JSON.parse(data) } catch { continue }
          if (parsed?.error !== undefined || typeof parsed?.code === 'number') {
            const error = classifyUpstreamError(response.status, data)
            if (error.channelGate === true && retriesLeft > 0 && !signal?.aborted) {
              retriesLeft -= 1
              neutralHead = true
              retryPending = true
              ended = true
              await reader.cancel().catch(() => {})
              break
            }
            throw error
          }
          for (const chunk of toChunks(parsed, state)) yield chunk
        }
      }
    } finally {
      reader.releaseLock()
    }
    // 自愈重试只在「任何正文都没交出」时发生，对调用方不可见。
    if (retryPending && state.text === '' && state.toolOrder.length === 0 && state.thinking === '') continue
    for (const chunk of finalizeChunks(state)) yield chunk
    return
  }
}
