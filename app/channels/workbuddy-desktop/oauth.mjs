/**
 * WorkBuddy 网页 / 扫码登录，无需桌面 App。
 *
 * 端点与插件 dsh-connect-workbuddy（MIT）的 `src/oauth.ts` 一致，也与本仓库
 * 渠道包 `vendor/channel-pack/src/buddy.ts` 里 `fetchAuthState` / `loopGetToken` /
 * `getAccount` 用的是同一套协议：
 *
 *   1. POST {base}/v2/plugin/auth/state?platform=workbuddy  -> state + authUrl
 *   2. GET  {base}/v2/plugin/auth/token?state=...            -> 轮询换 token（未完成回业务码）
 *   3. GET  {base}/v2/plugin/login/account?state=...         -> 账号资料（Bearer + X-Domain）
 *
 * 关键约定（照插件）：
 *   - 会话必须**绑定 region 与 base**：国际版有 workbuddy.ai / codebuddy.ai 两个
 *     品牌域名，两边签发的 token 互不通用，选错就 401。
 *   - 字段双拼写容错（camelCase / snake_case / 首字母大写），data 信封可嵌套。
 *   - 会话只在进程内存中，不落盘；重启即作废，10 分钟超时。
 *   - 拿到凭据即由调用方写入 vault，这里不碰存储。
 *
 * ⚠️ 非官方客户端接口，上游随时可能改协议或收紧限制。
 *
 * @module app/channels/workbuddy-desktop/oauth
 */
import { randomUUID } from 'node:crypto'
import { regionOf } from './auth.mjs'
import { CN_BILLING_BASE, GLOBAL_BASE } from './upstream.mjs'

const API_PREFIX = '/v2/plugin'
export const OAUTH_LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000
/** 未完成的业务码；渠道包的 CODE_TOKEN_NOT_READY 也是 11217。 */
const CODE_TOKEN_NOT_READY = 11217

/** CN 单端点；国际版默认 workbuddy.ai，可用 explicitBase 固定到 codebuddy.ai。 */
export function oauthBillingBase(region, explicitBase) {
  if (region === 'cn') return CN_BILLING_BASE
  const trimmed = typeof explicitBase === 'string' ? explicitBase.trim().replace(/\/+$/, '') : ''
  return trimmed !== '' ? trimmed : GLOBAL_BASE
}

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function optionalString(source, keys) {
  const value = firstString(source, keys)
  return value === '' ? undefined : value
}

function envelopeData(document) {
  const data = document?.data
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

function responseCode(document) {
  for (const key of ['code', 'Code', 'businessCode']) {
    const value = document?.[key]
    if (typeof value === 'number') return value
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  }
  return -1
}

function responseMessage(document) {
  return firstString(document, ['msg', 'message', 'displayMsg', 'errorMsg'])
    || firstString(envelopeData(document), ['msg', 'message']) || '上游未给出原因'
}

async function readJson(response, fetchImpl) {
  try {
    const text = await response.text()
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* 非 JSON 由调用方决定严重程度 */ }
  void fetchImpl
  return undefined
}

/** 绝对时间戳（秒/毫秒）或相对 TTL（秒）都接受。 */
export function expiryMs(source, absoluteKeys, ttlKeys) {
  for (const key of absoluteKeys) {
    const value = source?.[key]
    if (typeof value === 'number' && value > 0) return value > 1e12 ? value : value * 1000
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      const parsed = Number(value)
      return parsed > 1e12 ? parsed : parsed * 1000
    }
  }
  for (const key of ttlKeys) {
    const value = source?.[key]
    if (typeof value === 'number' && value > 0) return Date.now() + value * 1000
  }
  return undefined
}

function parseCredential(data) {
  const accessToken = firstString(data, ['accessToken', 'access_token', 'AccessToken'])
  if (accessToken === '') return undefined
  return {
    accessToken,
    refreshToken: firstString(data, ['refreshToken', 'refresh_token', 'RefreshToken']),
    domain: firstString(data, ['domain', 'Domain']),
    expiresAtMs: expiryMs(data, ['expiresAt', 'expires_at'], ['expiresIn', 'expires_in']) ?? 0,
    ...expiryMs(data, ['refreshExpiresAt', 'refresh_expires_at'], ['refreshExpiresIn', 'refresh_expires_in']) !== undefined
      ? { refreshExpiresAtMs: expiryMs(data, ['refreshExpiresAt', 'refresh_expires_at'], ['refreshExpiresIn', 'refresh_expires_in']) } : {},
  }
}

/**
 * 创建一个登录会话管理器（每 Worker 一个实例）。
 *
 * 用工厂而不是模块级 Map，是为了让离线测试能各自隔离，且不把会话状态泄漏到
 * 全局。`fetchImpl` / `now` 可注入。
 */
export function createOAuthSessions({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const sessions = new Map()

  /** 起一次登录：返回 { loginId, loginUrl, expiresIn } 或 { error }。上游拒绝不抛异常。 */
  async function start(region, { base } = {}) {
    const chosen = oauthBillingBase(region, base)
    let response
    try {
      response = await fetchImpl(`${chosen}${API_PREFIX}/auth/state?platform=workbuddy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      return { error: `无法连接 ${chosen} 申请登录（${error?.message ?? error}）` }
    }
    const document = await readJson(response, fetchImpl)
    if (document === undefined) return { error: `登录服务返回了非 JSON 内容（HTTP ${response.status}）` }
    const data = envelopeData(document)
    const state = firstString(data, ['state', 'State'])
    if (state === '') return { error: `登录服务没有下发 state（HTTP ${response.status}）：${responseMessage(document)}` }
    const loginUrl = firstString(data, ['authUrl', 'auth_url', 'url', 'Url'])
      || `${chosen}/login?state=${encodeURIComponent(state)}`
    const loginId = `wbo_${randomUUID().replaceAll('-', '')}`
    sessions.set(loginId, { region, base: chosen, state, expiresAtMs: now() + OAUTH_LOGIN_TIMEOUT_MS, done: false })
    return { loginId, loginUrl, expiresIn: OAUTH_LOGIN_TIMEOUT_MS / 1000 }
  }

  /** 单次轮询；只有 done===true 才表示结束（失败也结束）。 */
  async function poll(loginId, region) {
    const session = sessions.get(loginId)
    if (session === undefined) return { done: true, error: '登录会话不存在或已完成，请重新开始' }
    if (session.region !== region) return { done: true, error: '登录会话属于另一个区域，请在对应的渠道页操作' }
    if (session.done) return terminal(session)
    if (now() > session.expiresAtMs) {
      sessions.delete(loginId)
      return { done: true, error: '登录已超时（10 分钟），请重新开始' }
    }
    let response
    try {
      response = await fetchImpl(`${session.base}${API_PREFIX}/auth/token?state=${encodeURIComponent(session.state)}`, {
        method: 'GET', headers: { Accept: 'application/json', 'X-No-Authorization': 'true' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      // 网络抖动不等于登录失败，用户可能还在扫码；超时由上面的 deadline 兜底。
      return { done: false }
    }
    const document = await readJson(response, fetchImpl)
    if (document === undefined) return { done: false }
    const code = responseCode(document)
    if (code === CODE_TOKEN_NOT_READY || (code !== 0 && code !== 200)) return { done: false }
    const data = envelopeData(document)
    const credential = parseCredential(data)
    if (credential === undefined) return { done: false }
    try {
      const account = await collectAccount(session, credential, data)
      session.done = true
      session.result = { credential, account, region: regionOf(account.domain || credential.domain) }
      sessions.delete(loginId)
      return { done: true, account: session.result }
    } catch (error) {
      sessions.delete(loginId)
      return { done: true, error: `获取账号信息失败：${error?.message ?? error}` }
    }
  }

  /** 用 Bearer 拉账号资料；失败不致命，token 已到手即可用。 */
  async function collectAccount(session, credential, tokenData) {
    const headers = {
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: 'application/json',
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
    }
    const domain = credential.domain || firstString(tokenData, ['domain', 'Domain'])
    if (domain !== '') headers['X-Domain'] = domain
    let profile = {}
    try {
      const response = await fetchImpl(`${session.base}${API_PREFIX}/login/account?state=${encodeURIComponent(session.state)}`, {
        method: 'GET', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const document = await readJson(response, fetchImpl)
      if (document !== undefined) profile = envelopeData(document)
    } catch { /* 展示信息缺失不阻断登录 */ }
    return {
      uid: firstString(profile, ['uid', 'Uid', 'userId', 'UserID']),
      ...optionalString(profile, ['nickname', 'NickName', 'ScreenName']) !== undefined
        ? { nickname: optionalString(profile, ['nickname', 'NickName', 'ScreenName']) } : {},
      ...optionalString(profile, ['uin', 'Uin']) !== undefined
        ? { uin: optionalString(profile, ['uin', 'Uin']) } : {},
      ...optionalString(profile, ['enterpriseId', 'EnterpriseId']) !== undefined
        ? { enterpriseId: optionalString(profile, ['enterpriseId', 'EnterpriseId']) } : {},
      domain: domain || firstString(profile, ['domain', 'Domain']),
    }
  }

  function terminal(session) {
    if (session.result !== undefined) return { done: true, account: session.result }
    return { done: true, error: session.error ?? '登录已结束但没有结果' }
  }

  return { start, poll, get size() { return sessions.size } }
}
