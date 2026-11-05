/**
 * WorkBuddy 桌面端「静态加密凭据」解密。
 *
 * 5.6.0 起，新版桌面端把 auth 文件里的 `accessToken` / `refreshToken`（以及
 * `nickname` 等身份字段）从纯字符串改成字段信封：
 *
 *   { "$wbEncrypted": 1, "envelope": "<base64 of a JSON envelope>" }
 *
 * envelope 是 `{suite, keyId, nonce, authTag, ciphertext}`，AES-256-GCM，
 * 12 字节 nonce、16 字节 tag。附加认证数据（AAD）是一段对 scheme / suite /
 * keyId / framing 的长度前缀转录，因此密文只能按它被封存的那种字段形状打开。
 *
 * 字段密钥不是用户密钥：它是编译进 App 自身 Electron 原生模块
 * （`electron_browser_workbuddy_storage`）的构建期常量。App 通过 `loggerGet()`
 * 取回它，并对返回的 **base64 字符串本身**（不是解码后的字节）做 SHA-256 得到
 * 32 字节密钥；`keyId` 是该密钥 SHA-256 的前 16 个十六进制字符。
 *
 * 本实现按 dsh-connect-workbuddy（MIT, Copyright (c) 2026 LaoDing）的
 * `src/at-rest.ts` 独立重写，算法与常量逐项对齐；不内置任何密钥副本——密钥在
 * 需要时向「写下这个文件的那个构建」询问，只在进程内存中缓存。纯字符串文件
 * （macOS 与旧版 Windows）走原路径，一次子进程都不会启动。
 *
 * ⚠️ 这是非官方客户端接口的一部分：上游随时可能改协议，本模块不提供长期可用承诺。
 *
 * @module app/channels/workbuddy-desktop/at-rest
 */
import { execFile } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** App 可执行文件与加密凭据文件的环境变量覆盖名，与插件保持一致，便于按其文档排障。 */
export const WORKBUDDY_APP_EXECUTABLE_ENV = 'WORKBUDDY_APP_EXECUTABLE'
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

/** 明确的可诊断错误：凭据是加密的，但当前机器上取不到解开它的密钥。 */
export const ENCRYPTED_CREDENTIAL_CODE = 'WORKBUDDY_ENCRYPTED_CREDENTIAL'

const KEY_FETCH_TIMEOUT_MS = 10_000
const AT_REST_KEY_FAILURE_TTL_MS = 60_000

const FRAMING_CODE = Object.freeze({ file: 1, field: 2, record: 3, stream: 4 })
const STANDARD_FORMAT_ID = Object.freeze({ file: 'WBEF1', field: 'WBEV1', record: 'WBER1', stream: 'WBES1' })
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii')
const SYMMETRIC_SCHEME = 'sym-v1'

/** 通过 App 的原生绑定向「写下这个文件的构建」询问密钥载荷。 */
const KEY_SOURCE = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exit(3)}"

function encodeUint32(value) {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value >>> 0)
  return bytes
}

/** uint32 大端长度 + UTF-8 字节。 */
function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeUint32(bytes.length), bytes])
}

/** 只实现 field framing：桌面端凭据字段用的就是它，且不会与整文件信封混淆。 */
export function fieldAad(keyId, suite, scheme = SYMMETRIC_SCHEME) {
  if (!/^[0-9a-f]{16}$/.test(keyId)) throw new Error('workbuddy: envelope keyId is malformed')
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(STANDARD_FORMAT_ID.field),
    encodeLengthPrefixed(scheme),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_CODE.field]),
    Buffer.from([0]), // encodeOptionalUint64(undefined)：field framing 无序列号
    Buffer.from([0]), // final === undefined
  ])
}

export function isEncryptedFieldWrapper(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  return keys.length === 2 && keys[0] === '$wbEncrypted' && keys[1] === 'envelope'
    && value.$wbEncrypted === 1 && typeof value.envelope === 'string'
}

/** keyId = 密钥 SHA-256 的前 16 个十六进制字符。 */
export function deriveAtRestKeyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** 从 App 的密钥载荷 JSON 派生 32 字节字段密钥：哈希的是 base64 字符串本身。 */
export function deriveAtRestKey(payloadJson) {
  let payload
  try { payload = JSON.parse(payloadJson) } catch { throw new Error('workbuddy: at-rest key payload is not valid JSON') }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('workbuddy: at-rest key payload is not an object')
  }
  const secret = payload.atRestSecretKey
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('workbuddy: at-rest key payload carries no atRestSecretKey')
  }
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** 打开一个加密字段，返回明文；任何形状/密钥/认证失败都抛错，绝不退化为残缺 token。 */
export function openEncryptedField(field, key) {
  let envelope
  try { envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8')) }
  catch { throw new Error('workbuddy: encrypted field envelope is not valid JSON') }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new Error('workbuddy: encrypted field envelope is not an object')
  }
  const { suite, keyId, nonce, authTag, ciphertext } = envelope
  if (typeof suite !== 'number' || typeof keyId !== 'string' || !/^[0-9a-f]{16}$/.test(keyId)) {
    throw new Error('workbuddy: encrypted field envelope is missing suite or keyId')
  }
  if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext')
  }
  const expectedKeyId = deriveAtRestKeyId(key)
  if (keyId !== expectedKeyId) {
    throw new Error(`workbuddy: encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`)
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 })
  decipher.setAAD(fieldAad(keyId, suite))
  decipher.setAuthTag(Buffer.from(authTag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/** 单个字符串字段：纯字符串直接返回；信封则用给定密钥打开。 */
export function credentialField(value, key) {
  if (typeof value === 'string') return value
  if (isEncryptedFieldWrapper(value)) {
    if (key === undefined) throw new Error('workbuddy: encrypted field needs an at-rest key')
    return openEncryptedField(value, key)
  }
  return undefined
}

/** 文档里是否存在必须解密才能读的字段（token 或身份字段）。 */
export function hasEncryptedCredentialFields(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { return false }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const auth = parsed.auth && typeof parsed.auth === 'object' ? parsed.auth : parsed
  const identity = parsed.account && typeof parsed.account === 'object' ? parsed.account : parsed
  for (const field of [auth.accessToken, auth.refreshToken, auth.domain,
    identity.nickname, identity.uin, identity.uid, identity.enterpriseId]) {
    if (isEncryptedFieldWrapper(field)) return true
  }
  return false
}

/** 桌面 App 可执行文件候选（按平台）。返回存在的文件路径列表。 */
export function appExecutableCandidates({ env = process.env, platform = process.platform, home = homedir(),
  fileExists = existsSync, listDir = readdirSync, readText = readFileSync } = {}) {
  const override = typeof env[WORKBUDDY_APP_EXECUTABLE_ENV] === 'string' ? env[WORKBUDDY_APP_EXECUTABLE_ENV].trim() : ''
  if (override !== '') return fileExists(override) ? [override] : []
  const out = []
  const add = candidate => { if (candidate && fileExists(candidate) && !out.includes(candidate)) out.push(candidate) }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    const programFiles = env.ProgramFiles || 'C:\\Program Files'
    const roots = [local, programFiles, path.join(local, 'Programs')]
    const layouts = [
      ['WorkBuddy', 'WorkBuddy.exe'], ['WorkBuddyAI', 'WorkBuddyAI.exe'],
      ['WorkBuddy', 'WorkBuddyAI.exe'], ['WorkBuddyAI', 'WorkBuddy.exe'],
    ]
    for (const root of roots) for (const [dir, exe] of layouts) {
      add(path.join(root, dir, exe))
      add(path.join(root, 'Programs', dir, exe))
    }
  } else if (platform === 'darwin') {
    const roots = ['/Applications', path.join(home, 'Applications')]
    for (const root of roots) {
      let entries = []
      try { entries = listDir(root) } catch { /* 目录不存在 */ }
      for (const entry of entries) {
        if (!/^WorkBuddy/i.test(entry) || !entry.endsWith('.app')) continue
        const macosDir = path.join(root, entry, 'Contents', 'MacOS')
        // 二进制名以 bundle 自述为准（实测是 Electron）；这里直接扫目录取可执行文件。
        let bins = []
        try { bins = listDir(macosDir) } catch { /* 无 MacOS 目录 */ }
        for (const bin of bins) add(path.join(macosDir, bin))
      }
    }
  }
  // 显式校验 plist 里的 CFBundleIdentifier 由插件负责；这里只按目录与文件名收敛，
  // 且 macOS 上每个 Electron 应用都叫 Electron，因此取到后仍需 loggerGet() 能成功
  // 才算数（取不到就当作没有密钥，不会误用别的产品）。
  void readText
  return out
}

/**
 * 创建一个「向已安装 App 询问密钥载荷」的 provider。
 *
 * 返回值是 `async () => payloadString | undefined`。带进程内缓存与 60s 失败 TTL：
 * 一次失败（App 未安装 / 旧构建无原生模块）在窗口内不再重复 spawn。测试通过
 * `keyProvider` 注入纯函数替代，不需要真的启动桌面 App。
 */
export function createAppKeyProvider(options = {}) {
  const { env = process.env, spawn = execFile, timeoutMs = KEY_FETCH_TIMEOUT_MS, now = () => Date.now() } = options
  let cached
  let failedAtMs = 0
  return async () => {
    if (cached !== undefined) return cached
    if (failedAtMs !== 0 && now() - failedAtMs < AT_REST_KEY_FAILURE_TTL_MS) return undefined
    const candidates = appExecutableCandidates({ ...options, env })
    for (const executable of candidates) {
      const payload = await new Promise(resolve => {
        let settled = false
        const finish = value => { if (!settled) { settled = true; resolve(value) } }
        try {
          spawn(executable, ['-e', KEY_SOURCE], {
            env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 256 * 1024,
          }, (error, stdout) => {
            if (error || typeof stdout !== 'string' || stdout === '') return finish(undefined)
            finish(stdout)
          })
        } catch { finish(undefined) }
      })
      if (payload !== undefined) {
        try { cached = deriveAtRestKey(payload); failedAtMs = 0; return cached } catch { /* 载荷无效，换下一个候选 */ }
      }
    }
    failedAtMs = now()
    return undefined
  }
}

/** 把 keyProvider 的返回值（Buffer 或载荷字符串）统一成 32 字节密钥。 */
export function normalizeAtRestKey(value) {
  if (value === undefined || value === null) return undefined
  if (Buffer.isBuffer(value)) return value.length === 32 ? value : undefined
  if (typeof value === 'string') {
    try { const derived = deriveAtRestKey(value); return derived } catch { return undefined }
  }
  return undefined
}
