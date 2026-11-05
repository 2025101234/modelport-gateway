/**
 * 网页登录账号的凭据库（vault）。
 *
 * 桌面 App 的 auth 文件**只读、永不写入**；网页/扫码登录拿到的凭据由本仓库自己
 * 保管，一账号一文件，落在 `dataDir/workbuddy-vault/<region>/<accountId>.json`
 * （目录 0700、文件 0600、原子写）。`scanCredentials()` 会把它与桌面文件、
 * 搬运来的 store 文件合并成同一份账号清单，按区域分流，共同换号。
 *
 * 参考 dsh-connect-workbuddy（MIT）的 vault 语义：删除只删本仓库自己的副本，
 * 不动桌面 App 登录；账号按 region 隔离；导出时对 token 脱敏预览。
 *
 * ⚠️ vault 里是**可直接使用的明文登录态**，等同账号，不落日志、不进管理 API。
 *
 * @module app/channels/workbuddy-desktop/vault
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ownDocument } from './store.mjs'
import { preferredAccountName } from './auth.mjs'

export const VAULT_DIRNAME = 'workbuddy-vault'
/** 账号 id：24 位小写十六进制，避免路径穿越。 */
export const ACCOUNT_ID_RE = /^[0-9a-f]{24}$/

export function vaultDir(storeDir, region) {
  return path.join(storeDir, VAULT_DIRNAME, region)
}

export function isAccountId(value) {
  return typeof value === 'string' && ACCOUNT_ID_RE.test(value)
}

function accountPath(storeDir, region, accountId) {
  if (!isAccountId(accountId)) throw new TypeError('账号 id 非法')
  return path.join(vaultDir(storeDir, region), `${accountId}.json`)
}

function atomicWrite(file, text) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}

/** 把一个已登录的 credential 存进 vault；返回 { accountId, region }。 */
export function saveAccount(storeDir, region, credential) {
  if (region !== 'cn' && region !== 'global') throw new TypeError('region must be cn or global')
  const dir = vaultDir(storeDir, region)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const accountId = crypto.randomBytes(12).toString('hex')
  const document = {
    ...ownDocument(credential),
    // 网页登录的凭据由本仓库签发，标记来源便于诊断与导出。
    source: 'web-login',
    savedAt: Date.now(),
  }
  atomicWrite(accountPath(storeDir, region, accountId), JSON.stringify(document, null, 2))
  return { accountId, region }
}

/** 列出 vault 里的账号文档（不含 token 的完整路径信息由调用方决定）。 */
export function listAccountFiles(storeDir) {
  const out = []
  for (const region of ['cn', 'global']) {
    const dir = vaultDir(storeDir, region)
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.json') || !isAccountId(name.slice(0, -'.json'.length))) continue
      const file = path.join(dir, name)
      try {
        const document = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (document && typeof document === 'object') out.push({ region, accountId: name.slice(0, -5), file, document })
      } catch { /* 坏文件跳过，不让一个坏账号拖垮整个清单 */ }
    }
  }
  return out
}

/** 删除本仓库自己的账号副本；不动任何桌面 App 文件。 */
export function deleteAccount(storeDir, region, accountId) {
  try { fs.unlinkSync(accountPath(storeDir, region, accountId)); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

/**
 * 导出所有 vault 账号成服务器可用的 `workbuddy-auth.<region>.json` 内容。
 * 每区域取到期最晚的账号（与 scanCredentials 的选择口径一致）。
 */
export function exportVault(storeDir) {
  const byRegion = new Map()
  for (const entry of listAccountFiles(storeDir)) {
    const auth = entry.document.auth ?? {}
    const credential = {
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken ?? '',
      domain: auth.domain ?? '',
      uid: entry.document.account?.uid ?? '',
      nickname: entry.document.account?.nickname,
      expiresAtMs: Number.isFinite(auth.expiresAt) ? auth.expiresAt : 0,
    }
    if (typeof credential.accessToken !== 'string' || credential.accessToken === '') continue
    const previous = byRegion.get(entry.region)
    if (previous === undefined || credential.expiresAtMs > previous.credential.expiresAtMs) {
      byRegion.set(entry.region, { credential, accountId: entry.accountId })
    }
  }
  const out = {}
  for (const [region, entry] of byRegion) {
    out[region] = { filename: `workbuddy-auth.${region}.json`, content: JSON.stringify(ownDocument(entry.credential), null, 2) }
  }
  return out
}

/** 脱敏摘要：只报字段是否齐全，绝不回显 token。 */
export function accountSummary(storeDir) {
  return listAccountFiles(storeDir).map(entry => {
    const auth = entry.document.auth ?? {}
    const account = entry.document.account ?? {}
    return {
      accountId: entry.accountId,
      region: entry.region,
      nickname: preferredAccountName({ ...account, uid: account.uid }),
      hasAccessToken: typeof auth.accessToken === 'string' && auth.accessToken !== '',
      hasRefreshToken: typeof auth.refreshToken === 'string' && auth.refreshToken !== '',
      domain: typeof auth.domain === 'string' ? auth.domain : '',
      expiresAt: Number.isFinite(auth.expiresAt) ? auth.expiresAt : undefined,
      source: 'web-login',
    }
  })
}
