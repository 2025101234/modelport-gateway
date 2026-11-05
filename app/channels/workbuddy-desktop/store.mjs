/**
 * 本仓库自有的 WorkBuddy 凭据副本（刷新结果 / 服务器搬运种子）。
 *
 * 与桌面 App 的 auth 文件严格分离：**只读桌面文件，永不回写**；刷新拿到的新
 * token 写进 `dataDir/workbuddy-auth.<region>.json`（0600、原子写）。
 *
 * 这份文件同时是「无桌面端服务器」的凭据入口之一：用户可以把已登录机器上的
 * 未加密凭据按同形状放到这里，`scanCredentials()` 会把它当作 store 级候选。
 * 因此它必须是可直接被 `parseWorkBuddyAuth()` 读回的形状（camelCase 运行字段
 * 原样序列化，不另造一套 schema）。
 *
 * @module app/channels/workbuddy-desktop/store
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import { ownAuthPath } from './auth.mjs'

/**
 * 把一个运行时 credential 写成文档。
 * 只写认证与身份字段；不写 source / filePath 这类扫描时才有的元数据。
 */
export function ownDocument(credential) {
  const auth = {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken ?? '',
    domain: credential.domain ?? '',
  }
  if (Number.isFinite(credential.expiresAtMs)) auth.expiresAt = credential.expiresAtMs
  if (Number.isFinite(credential.refreshExpiresAtMs)) auth.refreshExpiresAt = credential.refreshExpiresAtMs
  if (Number.isFinite(credential.lastRefreshAtMs)) auth.lastRefreshTime = credential.lastRefreshAtMs
  const account = {}
  for (const key of ['uid', 'enterpriseId', 'nickname', 'displayName', 'enterpriseUserName', 'uin']) {
    if (typeof credential[key] === 'string' && credential[key] !== '') account[key] = credential[key]
  }
  return { auth, account }
}

/** 同步原子写入；失败冒泡（调用方据此回滚内存态，绝不谎报保存成功）。 */
export function writeOwnCredential(storeDir, region, credential) {
  const file = ownAuthPath(storeDir, region)
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(ownDocument(credential), null, 2), { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
  return file
}

/** 删除自有副本（凭据失效且刷新也失败时，避免旧 token 一直被反复读取）。 */
export function removeOwnCredential(storeDir, region) {
  const file = ownAuthPath(storeDir, region)
  try { fs.unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
}
