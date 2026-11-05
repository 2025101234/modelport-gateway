/**
 * WorkBuddy 桌面端登录态的发现与解析（只读，绝不回写桌面 App 的文件）。
 *
 * 本模块按 dsh-connect-workbuddy（MIT, Copyright (c) 2026 LaoDing）的
 * `src/auth.ts` 与 `src/upstream.ts` 独立重写，覆盖连接内核所需的子集。
 *
 * 凭据解析有三级顺序，让「本机开发」与「无桌面端的服务器部署」共用同一份代码：
 *
 *   1. `WORKBUDDY_AUTH_FILE` 显式绝对路径（headless 首选）——指定时连同目录下的
 *      时间戳备份一起扫描；
 *   2. 平台默认的桌面 App auth 目录（本机自动发现）；
 *   3. `dataDir/workbuddy-auth.<region>.json` —— 本仓库自己保存的刷新结果，
 *      同时也是「从已登录机器搬运凭据到服务器」的种子文件。
 *
 * 扫描到的每个账号按 `regionOf(domain)` 分流：国际版 `workbuddy.ai` /
 * `codebuddy.ai` → `global`，其余 → `cn`。两个区域可同时在线。
 *
 * ⚠️ 这是非官方客户端接口的一部分，上游随时可能改协议或收紧限制。
 *
 * @module app/channels/workbuddy-desktop/auth
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import {
  credentialField, hasEncryptedCredentialFields, normalizeAtRestKey,
  ENCRYPTED_CREDENTIAL_CODE, WORKBUDDY_AUTH_FILE_ENV,
} from './at-rest.mjs'

/** App 当前登录文件（5.7.x 起国际版写 `-ai` 变体），按优先级排列。 */
export const WORKBUDDY_LIVE_FILENAMES = Object.freeze([
  'workbuddy-desktop.info',
  'workbuddy-desktop-ai.info',
])

/** 本仓库自有凭据文件名前缀（刷新结果 / 服务器搬运种子）。 */
export const OWN_AUTH_PREFIX = 'workbuddy-auth'

export function isLiveDesktopAuthFileName(name) {
  return WORKBUDDY_LIVE_FILENAMES.includes(name)
}

/** 时间戳备份：`workbuddy-desktop.<stamp>.info` / `workbuddy-desktop-ai.<stamp>.info`。 */
export function isBackupAuthFileName(name) {
  return /^workbuddy-desktop(?:-ai)?\.[\w-]+\.info$/.test(name)
}

export function ownAuthPath(storeDir, region) {
  return path.join(storeDir, `${OWN_AUTH_PREFIX}.${region}.json`)
}

/**
 * 平台默认的 auth 目录（按探测顺序）。
 * 环境变量与 home 可注入，平台分支因此能在任意机器上离线测试。
 */
export function defaultDesktopAuthDirs({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  const nonEmpty = value => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  if (platform === 'win32') {
    const local = nonEmpty(env.LOCALAPPDATA) ?? path.join(home, 'AppData', 'Local')
    const roaming = nonEmpty(env.APPDATA) ?? path.join(home, 'AppData', 'Roaming')
    return [
      path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      path.join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ]
  }
  // Linux 同时看 XDG 的 config 与 data 两套；config 仍排在前面（插件既有行为）。
  const config = nonEmpty(env.XDG_CONFIG_HOME) ?? path.join(home, '.config')
  const data = nonEmpty(env.XDG_DATA_HOME) ?? path.join(home, '.local', 'share')
  return [
    path.join(config, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    path.join(data, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  ]
}

/**
 * 凭据文件候选（按优先级）：显式路径、其同级备份、平台默认 live 文件 + 备份、
 * 本仓库自有 store 文件。
 */
export function credentialCandidates({ env = process.env, platform = process.platform, home = homedir(), storeDir = '' } = {}) {
  const out = []
  const add = (file, tier) => { if (!out.some(row => row.file === file)) out.push({ file, tier }) }
  const explicit = typeof env[WORKBUDDY_AUTH_FILE_ENV] === 'string' ? env[WORKBUDDY_AUTH_FILE_ENV].trim() : ''
  const dirs = []
  if (explicit !== '') {
    add(explicit, 'explicit')
    dirs.push({ dir: path.dirname(explicit), tier: 'explicit' })
  }
  for (const dir of defaultDesktopAuthDirs({ env, platform, home })) dirs.push({ dir, tier: 'desktop' })
  for (const { dir, tier } of dirs) {
    for (const name of WORKBUDDY_LIVE_FILENAMES) add(path.join(dir, name), tier)
    // 时间戳备份按名字倒序（新的在前），同一目录下的 live 文件始终排在备份前面。
    let names = []
    try { names = fs.readdirSync(dir) } catch { /* 目录不存在 */ }
    for (const name of names.filter(isBackupAuthFileName).sort().reverse()) {
      add(path.join(dir, name), tier)
    }
  }
  if (storeDir !== '') {
    for (const region of ['cn', 'global']) add(ownAuthPath(storeDir, region), 'store')
  }
  return out
}

/** 过期时间可能以秒或毫秒给出。 */
export function expiryToMs(value) {
  if (typeof value !== 'number' || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

/**
 * 解析一份 auth 文档（桌面文件或本仓库自有 store 文件同形状）。
 *
 * 兼容两种布局：带 `{ auth, account }` 包装，以及字段直接铺在顶层。
 * 加密字段由 `key` 打开；**绝不读取 `account.phoneNumber`**。
 */
export function parseWorkBuddyAuth(text, filePath, key) {
  let parsed
  try { parsed = JSON.parse(text) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const auth = parsed.auth && typeof parsed.auth === 'object' ? parsed.auth : parsed
  const identity = parsed.account && typeof parsed.account === 'object' ? parsed.account : parsed
  let accessToken, refreshToken
  try {
    accessToken = credentialField(auth.accessToken, key)
    refreshToken = credentialField(auth.refreshToken, key)
  } catch {
    // 信封畸形、密钥不匹配、认证失败都等于「这份文档读不出来」，绝不半解密。
    return undefined
  }
  if (typeof accessToken !== 'string' || accessToken === '') return undefined
  const readOptional = value => {
    try { return credentialField(value, key) } catch { return undefined }
  }
  const credential = {
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
    expiresAtMs: expiryToMs(auth.expiresAt),
    domain: readOptional(auth.domain) ?? '',
    uid: readOptional(identity.uid) ?? '',
    source: filePath.includes(`${OWN_AUTH_PREFIX}.`) ? 'store' : 'desktop',
    filePath,
  }
  for (const [name, value] of Object.entries({
    enterpriseId: identity.enterpriseId, nickname: identity.nickname,
    displayName: identity.displayName, enterpriseUserName: identity.enterpriseUserName,
    uin: identity.uin,
  })) {
    const resolved = readOptional(value)
    if (typeof resolved === 'string' && resolved !== '') credential[name] = resolved
  }
  if (auth.refreshExpiresAt !== undefined) credential.refreshExpiresAtMs = expiryToMs(auth.refreshExpiresAt)
  if (auth.lastRefreshTime !== undefined) credential.lastRefreshAtMs = expiryToMs(auth.lastRefreshTime)
  return credential
}

/**
 * 凭据的 `domain` → 区域。国际版两个品牌域名都算 global，其余（含国内
 * `copilot.tencent.com` / `www.codebuddy.cn`）算 cn。末尾用点号边界判定，避免
 * `codebuddy.cn.evil.com` 之类的形近域名混进来。
 */
export function regionOf(domain) {
  const lowered = String(domain ?? '').trim().toLowerCase()
  for (const host of ['workbuddy.ai', 'codebuddy.ai']) {
    if (lowered === host || lowered.endsWith(`.${host}`)) return 'global'
  }
  return 'cn'
}

/** 账号展示名：不把加密字段解不开时的 uin 数字当成昵称。 */
export function preferredAccountName(credential) {
  for (const candidate of [credential.displayName, credential.enterpriseUserName, credential.nickname]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return typeof credential.uin === 'string' && credential.uin !== '' ? `账号 ${credential.uin}` : 'WorkBuddy 账号'
}

/** 账号去重键：优先 uin/uid，退回到 token 前缀（不落盘、不进日志）。 */
function accountKey(credential) {
  return credential.uin || credential.uid || credential.accessToken.slice(0, 24)
}

/**
 * 扫描全部候选文件，返回可路由账号与诊断信息。
 *
 * @param {object} options
 * @param {() => Promise<Buffer|string|undefined>} [options.keyProvider] 注入式密钥来源；
 *        不传时用「向已安装 App 询问」的 provider。
 * @returns {Promise<{accounts: Array, diagnostics: object}>}
 *
 * `accounts` 每项：`{ id, region, credential, filePath, source, refreshable }`。
 * `diagnostics` 记录 `explicitFileMissing` / `unreadableEncryptedFiles` /
 * `encryptedCredentialUnsupported` 等可诊断事实，供控制台如实展示。
 */
export async function scanCredentials(options = {}) {
  const {
    env = process.env, platform = process.platform, home = homedir(), storeDir = '',
    keyProvider, readFile = fs.readFileSync, fileExists = fs.existsSync,
    candidates = credentialCandidates,
  } = options
  const diagnostics = {
    explicitFileMissing: false,
    unreadableEncryptedFiles: [],
    encryptedCredentialUnsupported: false,
    candidates: [],
  }
  const explicit = typeof env[WORKBUDDY_AUTH_FILE_ENV] === 'string' ? env[WORKBUDDY_AUTH_FILE_ENV].trim() : ''
  if (explicit !== '' && !fileExists(explicit)) diagnostics.explicitFileMissing = true

  // 只在确实存在加密字段的文档上询问密钥：纯字符串文件一次子进程都不起。
  const list = candidates({ env, platform, home, storeDir })
  const readable = []
  for (const { file, tier } of list) {
    if (!fileExists(file)) continue
    let text
    try { text = readFile(file, 'utf8') } catch { continue }
    diagnostics.candidates.push({ file: tier === 'explicit' ? file : path.basename(file), tier })
    readable.push({ file, tier, text, encrypted: hasEncryptedCredentialFields(text) })
  }

  const needsKey = readable.some(row => row.encrypted)
  const key = needsKey && keyProvider ? normalizeAtRestKey(await keyProvider()) : undefined
  if (needsKey && key === undefined) diagnostics.encryptedCredentialUnsupported = true

  const seen = new Map()
  const accounts = []
  for (const row of readable) {
    let credential
    if (row.encrypted && key === undefined) {
      diagnostics.unreadableEncryptedFiles.push(path.basename(row.file))
      continue
    }
    try { credential = parseWorkBuddyAuth(row.text, row.file, key) } catch { credential = undefined }
    if (credential === undefined) {
      if (row.encrypted) diagnostics.unreadableEncryptedFiles.push(path.basename(row.file))
      continue
    }
    const id = accountKey(credential)
    const existing = seen.get(id)
    // 同一账号的多份文件：留 expiresAt 更晚的那份（插件既有语义：双凭据取到期更晚者）。
    if (existing !== undefined && existing.credential.expiresAtMs >= credential.expiresAtMs) continue
    const entry = {
      id,
      region: regionOf(credential.domain),
      credential,
      filePath: row.file,
      source: row.tier === 'store' ? 'store' : 'desktop',
      refreshable: typeof credential.refreshToken === 'string' && credential.refreshToken !== '',
      encrypted: row.encrypted,
    }
    seen.set(id, entry)
    const at = accounts.findIndex(candidate => candidate.id === id)
    if (at === -1) accounts.push(entry)
    else accounts[at] = entry
  }
  return { accounts, diagnostics, code: diagnostics.encryptedCredentialUnsupported ? ENCRYPTED_CREDENTIAL_CODE : undefined }
}
