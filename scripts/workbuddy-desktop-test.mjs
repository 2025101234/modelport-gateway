/**
 * WorkBuddy / CodeBuddy 桌面登录态反代的离线回归。
 *
 *     node scripts/workbuddy-desktop-test.mjs
 *
 * 全部注入式：不访问外网、不花渠道额度、不启动真实桌面 App。加密解密用注入的
 * keyProvider 与本地自造的 AES 信封验证；fetch 用替身；凭据文件落在临时目录。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, randomBytes } from 'node:crypto'

import {
  deriveAtRestKey, deriveAtRestKeyId, openEncryptedField, fieldAad,
  isEncryptedFieldWrapper, hasEncryptedCredentialFields, normalizeAtRestKey,
  ENCRYPTED_CREDENTIAL_CODE,
} from '../app/channels/workbuddy-desktop/at-rest.mjs'
import {
  defaultDesktopAuthDirs, credentialCandidates, parseWorkBuddyAuth,
  regionOf, preferredAccountName, scanCredentials, ownAuthPath,
  OWN_AUTH_PREFIX,
} from '../app/channels/workbuddy-desktop/auth.mjs'
import {
  selectCliModels, parseUpstreamModel, parseCreditMultiplier,
  fallbackModels, isRouterModelId,
} from '../app/channels/workbuddy-desktop/catalog.mjs'
import {
  chatHeaders, configHeaders, refreshHeaders, prepareChatBody,
  classifyUpstreamError, toChunks, finalizeChunks, newStreamState,
  uuidv7, isUnapprovedChannelOpening, rewriteChannelFingerprintPhrases,
  chatStream, fetchModels, refreshToken, CLIENT_UA, PRODUCT_UA,
} from '../app/channels/workbuddy-desktop/upstream.mjs'
import { ownDocument, writeOwnCredential } from '../app/channels/workbuddy-desktop/store.mjs'
import {
  saveAccount, listAccountFiles, accountSummary, exportVault, deleteAccount,
  vaultDir, isAccountId,
} from '../app/channels/workbuddy-desktop/vault.mjs'
import { createOAuthSessions, oauthBillingBase, expiryMs, OAUTH_LOGIN_TIMEOUT_MS } from '../app/channels/workbuddy-desktop/oauth.mjs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WorkBuddyDesktopAdapter, providerForRegion } from '../app/channels/workbuddy-desktop/adapter.mjs'

let failures = 0
const check = async (name, body) => {
  try { await body(); console.log(`ok   ${name}`) }
  catch (error) { failures += 1; console.log(`FAIL ${name} — ${error.stack ?? error.message}`) }
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wb-desktop-'))
const quiet = { info() {}, warn() {}, error() {} }
const credential = (over = {}) => ({
  accessToken: 'access-token', refreshToken: 'refresh-token',
  expiresAtMs: Date.now() + 3600_000, domain: 'www.workbuddy.ai',
  uid: 'u-1', enterpriseId: '', nickname: '测试账号', ...over,
})

/** 用与插件一致的算法自造一个加密字段，验证解密链路。 */
function makeEncryptedField(plain, key) {
  const keyId = deriveAtRestKeyId(key)
  const suite = 1
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(fieldAad(keyId, suite))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()])
  const envelope = {
    suite, keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(envelope)).toString('base64') }
}

// ── 1. 加密信封 ────────────────────────────────────────────────────────────────
await check('encrypted field wrapper is recognized', () => {
  const key = deriveAtRestKey(JSON.stringify({ atRestSecretKey: 'secret' }))
  const field = makeEncryptedField('plain-token', key)
  assert.equal(isEncryptedFieldWrapper(field), true)
  assert.equal(isEncryptedFieldWrapper({ accessToken: 'plain' }), false)
  assert.equal(isEncryptedFieldWrapper({ $wbEncrypted: 2, envelope: 'x' }), false)
})

await check('AES-256-GCM envelope round-trips with the right key', () => {
  const key = deriveAtRestKey(JSON.stringify({ atRestSecretKey: 'secret' }))
  const field = makeEncryptedField('plain-token', key)
  assert.equal(openEncryptedField(field, key), 'plain-token')
})

await check('a wrong key is rejected, never degraded to a partial token', () => {
  const key = deriveAtRestKey(JSON.stringify({ atRestSecretKey: 'secret' }))
  const wrong = deriveAtRestKey(JSON.stringify({ atRestSecretKey: 'other' }))
  const field = makeEncryptedField('plain-token', key)
  assert.throws(() => openEncryptedField(field, wrong), /belongs to key/)
})

await check('normalizeAtRestKey accepts a Buffer or a payload string', () => {
  const key = deriveAtRestKey(JSON.stringify({ atRestSecretKey: 'secret' }))
  assert.equal(normalizeAtRestKey(key), key)
  assert.equal(normalizeAtRestKey(undefined), undefined)
  assert.deepEqual(normalizeAtRestKey(JSON.stringify({ atRestSecretKey: 'secret' })), key)
})

// ── 2. 凭据发现与解析 ──────────────────────────────────────────────────────────
await check('regionOf splits the two regions by credential domain', () => {
  assert.equal(regionOf('www.workbuddy.ai'), 'global')
  assert.equal(regionOf('codebuddy.ai'), 'global')
  assert.equal(regionOf('copilot.tencent.com'), 'cn')
  assert.equal(regionOf('www.codebuddy.cn'), 'cn')
  assert.equal(regionOf('codebuddy.cn.evil.com'), 'cn', 'lookalike domain must not become global')
  assert.equal(regionOf(''), 'cn')
})

await check('platform default auth dirs are injectable and correct', () => {
  const win = defaultDesktopAuthDirs({ platform: 'win32', home: 'C:\\Users\\me', env: { LOCALAPPDATA: 'C:\\Local', APPDATA: 'C:\\Roam' } })
  assert.equal(win.length, 2)
  assert.ok(win[0].includes('CodeBuddyExtension'))
  const linux = defaultDesktopAuthDirs({ platform: 'linux', home: '/home/me', env: { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' } })
  assert.equal(linux.length, 2)
  // path.join 在 Windows 上用反斜杠，所以比较的是包含关系而不是字符串前缀。
  assert.ok(linux[0].includes('CodeBuddyExtension'))
  assert.ok(linux[1].includes('CodeBuddyExtension'))
  assert.notEqual(linux[0], linux[1], 'XDG config and data must be two distinct candidates')
  const mac = defaultDesktopAuthDirs({ platform: 'darwin', home: '/Users/me', env: {} })
  assert.ok(mac[0].includes('Application Support'))
})

await check('WORKBUDDY_AUTH_FILE is the highest-priority candidate', () => {
  const file = path.join(temp, 'explicit', 'workbuddy-desktop.info')
  const list = credentialCandidates({ env: { WORKBUDDY_AUTH_FILE: file }, platform: 'linux', home: temp, storeDir: temp })
  assert.equal(list[0].file, file)
  assert.equal(list[0].tier, 'explicit')
  assert.ok(list.some(row => row.tier === 'store'))
})

await check('parseWorkBuddyAuth reads both document layouts and skips phoneNumber', () => {
  const wrapped = JSON.stringify({
    auth: { accessToken: 'tok', refreshToken: 'ref', expiresAt: 1700000000, domain: 'copilot.tencent.com' },
    account: { uid: 'u1', nickname: '昵称', phoneNumber: '13800000000' },
  })
  const a = parseWorkBuddyAuth(wrapped, '/tmp/auth.info')
  assert.equal(a.accessToken, 'tok')
  assert.equal(a.refreshToken, 'ref')
  assert.equal(a.uid, 'u1')
  assert.equal(a.nickname, '昵称')
  assert.equal(a.phoneNumber, undefined)
  const flat = parseWorkBuddyAuth(JSON.stringify({ accessToken: 'tok2' }), '/tmp/flat.info')
  assert.equal(flat.accessToken, 'tok2')
  assert.equal(flat.domain, '')
})

await check('parseWorkBuddyAuth rejects malformed documents instead of half-reading', () => {
  assert.equal(parseWorkBuddyAuth('not json', 'x'), undefined)
  assert.equal(parseWorkBuddyAuth('null', 'x'), undefined)
  assert.equal(parseWorkBuddyAuth('[]', 'x'), undefined)
  assert.equal(parseWorkBuddyAuth('{"refreshToken":"only"}', 'x'), undefined)
})

await check('scanCredentials reads a plain desktop auth file and splits both regions', async () => {
  const dir = path.join(temp, 'desktop', 'Data', 'Public', 'auth')
  fs.mkdirSync(dir, { recursive: true })
  const cn = path.join(dir, 'workbuddy-desktop.info')
  const global = path.join(dir, 'workbuddy-desktop-ai.info')
  fs.writeFileSync(cn, JSON.stringify({ auth: { accessToken: 'cn-tok', domain: 'copilot.tencent.com' }, account: { uid: 'cn-1' } }))
  fs.writeFileSync(global, JSON.stringify({ auth: { accessToken: 'gl-tok', domain: 'www.workbuddy.ai' }, account: { uid: 'gl-1' } }))
  const result = await scanCredentials({ env: { WORKBUDDY_AUTH_FILE: cn }, platform: 'linux', home: temp, storeDir: temp })
  assert.equal(result.accounts.length, 2)
  assert.deepEqual(result.accounts.map(row => row.region).sort(), ['cn', 'global'])
  assert.equal(result.diagnostics.encryptedCredentialUnsupported, false)
})

await check('headless: an encrypted file with no app gives an actionable diagnostic', async () => {
  const key = deriveAtRestKey(JSON.stringify({ atRestSecretKey: 'secret' }))
  const doc = JSON.stringify({
    auth: { accessToken: makeEncryptedField('tok', key), refreshToken: 'plain', domain: 'www.workbuddy.ai' },
    account: { uid: 'enc-1' },
  })
  const file = path.join(temp, 'encrypted', 'workbuddy-desktop.info')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, doc)
  assert.equal(hasEncryptedCredentialFields(doc), true)
  const result = await scanCredentials({
    env: { WORKBUDDY_AUTH_FILE: file }, platform: 'linux', home: temp, storeDir: temp,
    keyProvider: async () => undefined,
  })
  assert.equal(result.accounts.length, 0)
  assert.equal(result.diagnostics.encryptedCredentialUnsupported, true)
  assert.equal(result.code, ENCRYPTED_CREDENTIAL_CODE)
  assert.ok(result.diagnostics.unreadableEncryptedFiles.length > 0)
})

await check('headless: injected keyProvider decrypts the same file', async () => {
  const key = deriveAtRestKey(JSON.stringify({ atRestSecretKey: 'secret' }))
  const doc = JSON.stringify({
    auth: { accessToken: makeEncryptedField('tok', key), refreshToken: 'plain', domain: 'www.workbuddy.ai' },
    account: { uid: 'enc-2' },
  })
  const file = path.join(temp, 'encrypted2', 'workbuddy-desktop.info')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, doc)
  const result = await scanCredentials({
    env: { WORKBUDDY_AUTH_FILE: file }, platform: 'linux', home: temp, storeDir: temp,
    keyProvider: async () => key,
  })
  assert.equal(result.accounts.length, 1)
  assert.equal(result.accounts[0].credential.accessToken, 'tok')
  assert.equal(result.accounts[0].region, 'global')
  assert.equal(result.diagnostics.encryptedCredentialUnsupported, false)
})

await check('WORKBUDDY_AUTH_FILE missing is reported, not silent', async () => {
  const result = await scanCredentials({ env: { WORKBUDDY_AUTH_FILE: path.join(temp, 'nope.info') }, platform: 'linux', home: temp, storeDir: temp })
  assert.equal(result.diagnostics.explicitFileMissing, true)
})

await check('preferredAccountName never falls back to a bare uin as a nickname', () => {
  assert.equal(preferredAccountName({ nickname: '昵称' }), '昵称')
  assert.equal(preferredAccountName({ displayName: '展示名' }), '展示名')
  assert.ok(preferredAccountName({ uin: '12345' }).startsWith('账号'))
})

// ── 3. 目录 ────────────────────────────────────────────────────────────────────
await check('parseUpstreamModel parses the /v3/config shape without inventing fields', () => {
  const model = parseUpstreamModel({
    id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1e6, maxOutputTokens: 64000,
    credits: 'x0.79 credits', supportsImages: true,
    reasoning: { supportedEfforts: ['low', 'high', 'max'] },
  })
  assert.equal(model.contextWindow, 1e6)
  assert.equal(model.maxOutput, 64000)
  assert.equal(model.supportsImages, true)
  assert.equal(model.creditMultiplier, 0.79)
  assert.deepEqual(model.reasoningEfforts, ['low', 'high', 'max'])
  const sparse = parseUpstreamModel({ id: 'x' })
  assert.equal(sparse.contextWindow, undefined)
  assert.equal(sparse.maxOutput, undefined)
})

await check('parseCreditMultiplier and router ids', () => {
  assert.equal(parseCreditMultiplier('x0.05'), 0.05)
  assert.equal(parseCreditMultiplier('x0.00 credits'), 0)
  assert.equal(parseCreditMultiplier('n/a'), undefined)
  assert.equal(isRouterModelId('auto'), true)
  assert.equal(isRouterModelId('glm-5.3'), false)
})

await check('selectCliModels honours the cli agent whitelist and drops routers', () => {
  const data = {
    models: [
      { id: 'auto', name: 'Auto' },
      { id: 'glm-5.3', name: 'GLM' },
      { id: 'hidden', name: 'Hidden' },
    ],
    agents: [{ name: 'cli', models: ['glm-5.3', 'auto'] }],
  }
  const rows = selectCliModels(data)
  assert.deepEqual(rows.map(row => row.id), ['glm-5.3'])
})

await check('fallback catalogues are non-empty for both regions', () => {
  assert.ok(fallbackModels('cn').length > 0)
  assert.ok(fallbackModels('global').length > 0)
  for (const id of ['default-model', 'fast-model', 'balanced-model']) {
    assert.ok(fallbackModels('global').some(row => row.id === id), `global fallback is missing ${id}`)
  }
})

// ── 4. 请求头与请求体 ──────────────────────────────────────────────────────────
await check('chatHeaders carry the conversation triple and never the refresh token', () => {
  const headers = chatHeaders(credential())
  for (const key of ['X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID']) {
    assert.equal(typeof headers[key], 'string', `missing ${key}`)
    assert.ok(headers[key].length > 0)
  }
  assert.equal(headers.Authorization, 'Bearer access-token')
  assert.equal(headers['X-Refresh-Token'], undefined)
  assert.equal(JSON.stringify(headers).includes('refresh-token'), false, 'refresh token must never appear in chat headers')
  assert.equal(headers['User-Agent'], CLIENT_UA)
  assert.equal(headers['X-No-Enterprise-Id'], '1')
  assert.equal(headers['X-No-User-Id'], undefined)
})

await check('chatHeaders use X-No-* when uid/enterprise/domain are empty', () => {
  const headers = chatHeaders(credential({ uid: '', domain: '' }))
  assert.equal(headers['X-No-User-Id'], '1')
  assert.equal(headers['X-No-Enterprise-Id'], '1')
  assert.equal(headers['X-No-Department-Info'], '1')
})

await check('configHeaders use the App PRODUCT_UA, chat uses CLIENT_UA', () => {
  assert.equal(configHeaders(credential())['User-Agent'], PRODUCT_UA)
  assert.equal(chatHeaders(credential())['User-Agent'], CLIENT_UA)
})

await check('refreshHeaders carry X-Refresh-Token and no Authorization', () => {
  const headers = refreshHeaders(credential())
  assert.equal(headers['X-Refresh-Token'], 'refresh-token')
  assert.equal(headers['X-Auth-Refresh-Source'], 'workbuddy')
  assert.equal(headers.Authorization, undefined)
})

await check('uuidv7 produces 32 lowercase hex with version 7', () => {
  const id = uuidv7()
  assert.match(id, /^[0-9a-f]{32}$/)
  assert.equal(id[12], '7')
})

await check('prepareChatBody forces stream, ensures a system head, flattens tool_choice', () => {
  const prepared = JSON.parse(prepareChatBody(JSON.stringify({
    model: 'glm-5.3',
    messages: [{ role: 'developer', content: 'you are a dev' }, { role: 'user', content: 'hi' }],
    tool_choice: { type: 'function', function: { name: 'read' } },
  })))
  assert.equal(prepared.stream, true)
  assert.equal(prepared.messages[0].role, 'system', 'conversation must open with a system row')
  assert.equal(prepared.messages[0].content, 'you are a dev', 'developer became the system head')
  assert.equal(prepared.messages[1].role, 'user')
  assert.equal(prepared.tool_choice, 'read')
})

await check('prepareChatBody rewrites channel-fingerprint phrases', () => {
  const text = 'You are an AI agent powered by DeepSeek Harness. Do the task.'
  assert.equal(isUnapprovedChannelOpening(text), true)
  const prepared = JSON.parse(prepareChatBody(JSON.stringify({
    model: 'x', messages: [{ role: 'system', content: text }, { role: 'user', content: 'hi' }],
  })))
  assert.equal(prepared.messages[0].content.includes('DeepSeek Harness'), false)
  assert.ok(prepared.messages[0].content.includes('helpful'))
})

await check('neutralHead retry prepends the neutral system head', () => {
  const prepared = JSON.parse(prepareChatBody(JSON.stringify({
    model: 'x', messages: [{ role: 'system', content: 'You are Claude Code.' }, { role: 'user', content: 'hi' }],
  }), { neutralHead: true }))
  assert.ok(prepared.messages[0].content.startsWith('You are a helpful assistant.'))
})

// ── 5. 错误分类 ────────────────────────────────────────────────────────────────
await check('error classification maps the 11128 channel gate and 11140 policy', () => {
  const channel = classifyUpstreamError(400, JSON.stringify({ code: 11128, msg: 'conversation id missing' }))
  assert.equal(channel.code, 'CHANNEL_REJECT')
  assert.equal(channel.channelGate, true)
  const policy = classifyUpstreamError(400, JSON.stringify({ code: 11140, msg: 'request illegal' }))
  assert.equal(policy.code, 'CLIENT_ERROR')
})

await check('error classification maps credit, auth, rate limit and context', () => {
  assert.equal(classifyUpstreamError(402, 'insufficient credit').code, 'QUOTA_EXHAUSTED')
  assert.equal(classifyUpstreamError(401, 'unauthorized').code, 'INVALID_CREDENTIAL')
  assert.equal(classifyUpstreamError(429, '{"code":14003}').code, 'RATE_LIMIT')
  assert.equal(classifyUpstreamError(400, 'maximum context length exceeded').status, 400)
  assert.equal(classifyUpstreamError(503, 'upstream down').code, 'EAC_UPSTREAM_FAILED')
})

// ── 6. SSE → 归一化 chunk ──────────────────────────────────────────────────────
await check('toChunks maps text, reasoning, tool calls and usage', () => {
  const state = newStreamState()
  const chunks = toChunks({
    choices: [{ delta: { content: 'hello', reasoning_content: 'think', tool_calls: [
      { index: 0, id: 'call_1', function: { name: 'read', arguments: '{"a":' } },
    ] }, finish_reason: null }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }, state)
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'hello'))
  assert.ok(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'think'))
  assert.ok(chunks.some(chunk => chunk.type === 'tool-call-delta' && chunk.name === 'read'))
  assert.ok(chunks.some(chunk => chunk.type === 'usage'))
  const tail = finalizeChunks(state)
  assert.equal(tail.at(-1).type, 'finish')
  assert.ok(tail.some(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call'))
})

await check('finalizeChunks reports an error for an empty response', () => {
  const tail = finalizeChunks(newStreamState())
  assert.equal(tail.at(-1).reason.kind, 'error')
  assert.equal(tail.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
})

/** 构造一个返回 SSE 流的替身 fetch。 */
function sseResponse(frames, { status = 200 } = {}) {
  const body = frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
  const encoder = new TextEncoder()
  let sent = false
  return {
    ok: status >= 200 && status < 300, status,
    text: async () => body,
    json: async () => JSON.parse(body),
    body: {
      getReader() {
        return {
          read: async () => sent ? { done: true, value: undefined } : (sent = true, { done: false, value: encoder.encode(body) }),
          releaseLock() {}, cancel: async () => {},
        }
      },
    },
  }
}

await check('chatStream yields normalized chunks from a stubbed SSE response', async () => {
  const chunks = []
  for await (const chunk of chatStream({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }, {
    credential: credential(),
    fetchImpl: async () => sseResponse([
      { choices: [{ delta: { content: 'OK' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]),
  })) chunks.push(chunk)
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'OK'))
  assert.equal(chunks.at(-1).type, 'finish')
})

await check('chatStream retries the 11128 channel gate once with a neutral head', async () => {
  let calls = 0
  const bodies = []
  const fetchImpl = async (_url, init) => {
    calls += 1
    bodies.push(JSON.parse(init.body))
    if (calls === 1) return {
      ok: false, status: 400,
      text: async () => JSON.stringify({ code: 11128, msg: 'conversation id missing' }),
    }
    return sseResponse([{ choices: [{ delta: { content: 'OK' } }] }])
  }
  const chunks = []
  for await (const chunk of chatStream({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, {
    credential: credential(), fetchImpl,
  })) chunks.push(chunk)
  assert.equal(calls, 2)
  assert.ok(bodies[1].messages[0].content.startsWith('You are a helpful assistant.'))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta'))
})

await check('chatStream does not retry a non-gate error', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: false, status: 401, text: async () => 'unauthorized' }
  }
  await assert.rejects(async () => {
    for await (const _chunk of chatStream({ model: 'x', messages: [] }, { credential: credential(), fetchImpl })) { /* drain */ }
  }, /401|凭据失效/)
  assert.equal(calls, 1)
})

// ── 7. 目录读取与刷新 ──────────────────────────────────────────────────────────
await check('fetchModels reads /v3/config with the App UA', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, ua: init.headers['User-Agent'] }
    return { ok: true, status: 200, json: async () => ({ data: { models: [{ id: 'glm-5.3', name: 'GLM' }], agents: [{ name: 'cli', models: ['glm-5.3'] }] } }) }
  }
  const rows = await fetchModels(credential(), { fetchImpl })
  assert.ok(seen.url.endsWith('/v3/config'))
  assert.equal(seen.ua, PRODUCT_UA)
  assert.deepEqual(rows.map(row => row.id), ['glm-5.3'])
})

await check('fetchModels falls back to the static catalogue when the remote fails', async () => {
  const rows = await fetchModels(credential(), { fetchImpl: async () => ({ ok: false, status: 503 }) })
  assert.ok(rows.length > 0)
  assert.equal(rows[0].fallback, true)
})

await check('refreshToken posts X-Refresh-Token and returns a merged credential', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, headers: init.headers }
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { accessToken: 'new-tok', refreshToken: 'new-ref', expiresIn: 3600 } }) }
  }
  const refreshed = await refreshToken(credential(), { fetchImpl })
  assert.ok(seen.url.endsWith('/v2/plugin/auth/token/refresh'))
  assert.equal(seen.headers['X-Refresh-Token'], 'refresh-token')
  assert.equal(refreshed.accessToken, 'new-tok')
  assert.equal(refreshed.refreshToken, 'new-ref')
})

await check('refreshToken refuses a credential with no refresh token', async () => {
  await assert.rejects(refreshToken(credential({ refreshToken: '' }), { fetchImpl: async () => { throw new Error('should not fetch') } }), /没有 refresh token/)
})

// ── 8. 自有 store ──────────────────────────────────────────────────────────────
await check('ownAuthPath and ownDocument round-trip through scanCredentials', () => {
  const storeDir = path.join(temp, 'store')
  fs.mkdirSync(storeDir, { recursive: true })
  const file = ownAuthPath(storeDir, 'global')
  assert.ok(file.endsWith(`${OWN_AUTH_PREFIX}.global.json`))
  const doc = ownDocument(credential())
  assert.equal(doc.auth.accessToken, 'access-token')
  assert.equal(doc.account.nickname, '测试账号')
  writeOwnCredential(storeDir, 'global', credential())
  // Windows 不实现 POSIX chmod；只在 POSIX 上断言 0600。文件内容的往返两边都验。
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const result = parseWorkBuddyAuth(fs.readFileSync(file, 'utf8'), file)
  assert.equal(result.accessToken, 'access-token')
  assert.equal(result.source, 'store')
})

// ── 9. 适配器契约 ──────────────────────────────────────────────────────────────
await check('providerForRegion maps to the existing provider ids', () => {
  assert.equal(providerForRegion('cn'), 'buddy')
  assert.equal(providerForRegion('global'), 'workbuddy')
})

await check('adapter contributes no routable models without a credential', async () => {
  const storeDir = path.join(temp, 'adapter-empty')
  fs.mkdirSync(storeDir, { recursive: true })
  const adapter = new WorkBuddyDesktopAdapter({
    region: 'global', provider: 'workbuddy', storeDir, logger: quiet,
    env: { WORKBUDDY_AUTH_FILE: path.join(storeDir, 'missing.info') },
    keyProvider: async () => undefined,
  })
  assert.deepEqual(await adapter.listModels(), [])
  assert.deepEqual(adapter.publicAccounts(), [])
  assert.equal(adapter.publicDiagnostics().explicitFileMissing, true)
  assert.ok((await adapter.publicCatalog()).length > 0, 'the console still gets a fallback catalogue')
})

await check('adapter reads a headless credential file and exposes only redacted accounts', async () => {
  const storeDir = path.join(temp, 'adapter-headless')
  fs.mkdirSync(storeDir, { recursive: true })
  const file = path.join(storeDir, 'workbuddy-desktop.info')
  fs.writeFileSync(file, JSON.stringify({
    auth: { accessToken: 'secret-access-token', refreshToken: 'secret-refresh', domain: 'www.workbuddy.ai' },
    account: { uid: 'u-2', nickname: '服务器账号' },
  }))
  const adapter = new WorkBuddyDesktopAdapter({
    region: 'global', provider: 'workbuddy', storeDir, logger: quiet,
    env: { WORKBUDDY_AUTH_FILE: file }, keyProvider: async () => undefined,
  })
  await adapter.rescan()
  const accounts = adapter.publicAccounts()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].region, 'global')
  assert.equal(accounts[0].nickname, '服务器账号')
  assert.equal(JSON.stringify(accounts).includes('secret-access-token'), false, 'no token may reach the management API')
  assert.equal(adapter.publicDiagnostics().accountCount, 1)
  assert.deepEqual(adapter.listProviders(), [{ id: 'workbuddy' }])
})

await check('adapter resolveModel returns the effort/context shape', async () => {
  const storeDir = path.join(temp, 'adapter-resolve')
  fs.mkdirSync(storeDir, { recursive: true })
  const adapter = new WorkBuddyDesktopAdapter({
    region: 'global', provider: 'workbuddy', storeDir, logger: quiet,
    env: { WORKBUDDY_AUTH_FILE: path.join(storeDir, 'missing.info') },
    keyProvider: async () => undefined,
  })
  const info = await adapter.resolveModel('workbuddy', 'workbuddy/fast-model')
  assert.equal(info.id, 'default-model', 'unknown ids fall back to the first catalogue row')
  assert.ok(Array.isArray(info.inputModalities))
  assert.ok(info.reasoning === undefined || Array.isArray(info.reasoning.efforts))
})

await check('adapter streamBody streams normalized chunks through a stubbed fetch', async () => {
  const storeDir = path.join(temp, 'adapter-stream')
  fs.mkdirSync(storeDir, { recursive: true })
  const file = path.join(storeDir, 'workbuddy-desktop.info')
  fs.writeFileSync(file, JSON.stringify({
    auth: { accessToken: 'tok', domain: 'www.workbuddy.ai' }, account: { uid: 'u-3' },
  }))
  const adapter = new WorkBuddyDesktopAdapter({
    region: 'global', provider: 'workbuddy', storeDir, logger: quiet,
    env: { WORKBUDDY_AUTH_FILE: file }, keyProvider: async () => undefined,
    fetchImpl: async () => sseResponse([{ choices: [{ delta: { content: 'OK' } }] }]),
  })
  const chunks = []
  for await (const chunk of adapter.streamBody({ model: 'workbuddy/fast-model', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'OK'))
  assert.equal(chunks.at(-1).type, 'finish')
})

// ── 10. 导出脚本：本机登录 → 明文 store 文件 → 服务器可读 ─────────────────────
await check('export script turns a plain desktop sign-in into a server-ready credential file', () => {
  const signInDir = path.join(temp, 'export-src')
  const outDir = path.join(temp, 'export-out')
  fs.mkdirSync(signInDir, { recursive: true })
  const authFile = path.join(signInDir, 'workbuddy-desktop.info')
  fs.writeFileSync(authFile, JSON.stringify({
    auth: { accessToken: 'export-token', refreshToken: 'export-refresh', domain: 'www.workbuddy.ai', expiresAt: 1900000000 },
    account: { uid: 'u-export', nickname: '导出账号' },
  }))
  const script = fileURLToPath(new URL('./export-workbuddy-auth.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--out', outDir], {
    env: { ...process.env, WORKBUDDY_AUTH_FILE: authFile, WORKBUDDY_APP_EXECUTABLE: '' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `export failed: ${result.stderr}`)
  const file = path.join(outDir, 'workbuddy-auth.global.json')
  assert.ok(fs.existsSync(file), 'global credential file must be written')
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(doc.auth.accessToken, 'export-token')
  assert.equal(doc.auth.refreshToken, 'export-refresh', 'refresh token must travel so the server can renew')
  assert.equal(doc.auth.domain, 'www.workbuddy.ai')
  assert.ok(result.stdout.includes('workbuddy-auth.global.json'))
  // 服务器侧：把导出物放进数据目录，scanCredentials 必须能读到且按 global 分流。
  const serverDir = path.join(temp, 'export-server')
  fs.mkdirSync(serverDir, { recursive: true })
  fs.copyFileSync(file, path.join(serverDir, 'workbuddy-auth.global.json'))
  return scanCredentials({
    env: { WORKBUDDY_AUTH_FILE: '' }, platform: 'linux', home: temp, storeDir: serverDir,
    keyProvider: async () => undefined,
  }).then(server => {
    assert.equal(server.accounts.length, 1, 'server reads the exported credential with no desktop app')
    assert.equal(server.accounts[0].region, 'global')
    assert.equal(server.accounts[0].credential.accessToken, 'export-token')
    assert.equal(server.diagnostics.encryptedCredentialUnsupported, false)
  })
})

await check('export script reports an actionable error when there is no sign-in', () => {
  const outDir = path.join(temp, 'export-empty')
  const script = fileURLToPath(new URL('./export-workbuddy-auth.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--out', outDir], {
    env: { ...process.env, WORKBUDDY_AUTH_FILE: path.join(temp, 'definitely-missing.info'), WORKBUDDY_APP_EXECUTABLE: '' },
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /没有检测到可用的 WorkBuddy 登录态/)
  assert.match(result.stderr, /WORKBUDDY_AUTH_FILE/)
})

// ── 11. 网页 / 扫码登录（OAuth 三步端点） ─────────────────────────────────────
/** 构造一个按顺序应答 auth/state → auth/token → login/account 的替身 fetch。 */
function oauthFetch({ pendingFirst = true, snakeCase = false, profile = true } = {}) {
  const calls = []
  let pollCount = 0
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method })
    const json = (obj, status = 200) => ({
      ok: status >= 200 && status < 300, status,
      text: async () => JSON.stringify(obj),
    })
    if (url.includes('/auth/state')) {
      return json({ code: 0, data: { state: 'ST-1', authUrl: 'https://www.workbuddy.ai/login?state=ST-1' } })
    }
    if (url.includes('/auth/token')) {
      pollCount += 1
      if (pendingFirst && pollCount === 1) return json({ code: 11217, msg: 'token not ready' })
      return json({ code: 0, data: snakeCase
        ? { access_token: 'web-access', refresh_token: 'web-refresh', domain: 'www.workbuddy.ai', expires_in: 3600 }
        : { accessToken: 'web-access', refreshToken: 'web-refresh', domain: 'www.workbuddy.ai', expiresIn: 3600 } })
    }
    if (url.includes('/login/account')) {
      if (!profile) throw new Error('profile endpoint down')
      return json({ code: 0, data: { uid: 'web-uid', nickname: '网页账号', uin: '12345', domain: 'www.workbuddy.ai' } })
    }
    throw new Error(`unexpected oauth url: ${url}`)
  }
  return { fetchImpl, calls, get pollCount() { return pollCount } }
}

await check('oauthBillingBase pins the region and honours the international brand domain', () => {
  assert.equal(oauthBillingBase('cn'), 'https://www.codebuddy.cn')
  assert.equal(oauthBillingBase('global'), 'https://www.workbuddy.ai')
  assert.equal(oauthBillingBase('global', 'https://www.codebuddy.ai/'), 'https://www.codebuddy.ai')
  assert.ok(OAUTH_LOGIN_TIMEOUT_MS >= 600_000)
})

await check('expiryMs accepts seconds, milliseconds and relative TTL', () => {
  assert.equal(expiryMs({ expiresAt: 1700000000 }, ['expiresAt'], ['expiresIn']), 1700000000000)
  assert.equal(expiryMs({ expiresAt: 1700000000000 }, ['expiresAt'], ['expiresIn']), 1700000000000)
  const ttl = expiryMs({ expiresIn: 60 }, ['expiresAt'], ['expiresIn'])
  assert.ok(ttl >= Date.now() + 59_000 && ttl <= Date.now() + 61_000)
})

await check('oauth start -> pending poll -> success, with camelCase fields', async () => {
  const { fetchImpl, calls } = oauthFetch({ pendingFirst: true })
  const sessions = createOAuthSessions({ fetchImpl })
  const started = await sessions.start('global')
  assert.ok(started.loginId.startsWith('wbo_'))
  assert.equal(started.loginUrl, 'https://www.workbuddy.ai/login?state=ST-1')
  assert.equal(sessions.size, 1)
  const pending = await sessions.poll(started.loginId, 'global')
  assert.equal(pending.done, false, 'a 11217 busy answer must not end the login')
  const result = await sessions.poll(started.loginId, 'global')
  assert.equal(result.done, true)
  assert.equal(result.account.credential.accessToken, 'web-access')
  assert.equal(result.account.credential.refreshToken, 'web-refresh')
  assert.equal(result.account.account.nickname, '网页账号')
  assert.equal(result.account.region, 'global')
  assert.equal(sessions.size, 0, 'a finished session is removed')
  assert.ok(calls.some(call => call.url.includes('/login/account')))
})

await check('oauth tolerates snake_case token fields and a missing profile endpoint', async () => {
  const { fetchImpl } = oauthFetch({ pendingFirst: false, snakeCase: true, profile: false })
  const sessions = createOAuthSessions({ fetchImpl })
  const started = await sessions.start('global')
  const result = await sessions.poll(started.loginId, 'global')
  assert.equal(result.done, true)
  assert.equal(result.account.credential.accessToken, 'web-access')
  assert.equal(result.account.credential.refreshToken, 'web-refresh')
  assert.equal(result.account.account.uid, '', 'a failed profile call must not fail the login')
})

await check('oauth refuses a poll from the wrong region before any network call', async () => {
  const { fetchImpl, calls } = oauthFetch({ pendingFirst: false })
  const sessions = createOAuthSessions({ fetchImpl })
  const started = await sessions.start('global')
  const before = calls.length
  const result = await sessions.poll(started.loginId, 'cn')
  assert.equal(result.done, true)
  assert.match(result.error, /区域/)
  assert.equal(calls.length, before, 'no network request may happen on a wrong-region poll')
})

await check('oauth times out a stuck login', async () => {
  const { fetchImpl } = oauthFetch({ pendingFirst: true })
  let clock = 1_000_000
  const sessions = createOAuthSessions({ fetchImpl, now: () => clock })
  const started = await sessions.start('global')
  clock += OAUTH_LOGIN_TIMEOUT_MS + 1
  const result = await sessions.poll(started.loginId, 'global')
  assert.equal(result.done, true)
  assert.match(result.error, /超时/)
  assert.equal(sessions.size, 0)
})

await check('oauth start reports an upstream refusal instead of throwing', async () => {
  const sessions = createOAuthSessions({ fetchImpl: async () => { throw new Error('network down') } })
  const result = await sessions.start('cn')
  assert.match(result.error, /无法连接/)
})

// ── 12. vault：网页登录账号的存储、脱敏、删除与导出 ──────────────────────────
await check('vault saves a web-login account with 0600 and lists it redacted', () => {
  const storeDir = path.join(temp, 'vault-store')
  fs.mkdirSync(storeDir, { recursive: true })
  const { accountId } = saveAccount(storeDir, 'global', {
    accessToken: 'vault-token', refreshToken: 'vault-refresh', domain: 'www.workbuddy.ai',
    uid: 'vault-uid', nickname: 'Vault 账号', expiresAtMs: Date.now() + 3600_000,
  })
  assert.equal(isAccountId(accountId), true)
  assert.equal(listAccountFiles(storeDir).length, 1)
  if (process.platform !== 'win32') {
    const file = path.join(vaultDir(storeDir, 'global'), `${accountId}.json`)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  }
  const summary = accountSummary(storeDir)[0]
  assert.equal(summary.nickname, 'Vault 账号')
  assert.equal(summary.hasAccessToken, true)
  assert.equal(summary.hasRefreshToken, true)
  assert.equal(JSON.stringify(summary).includes('vault-token'), false, 'summary must never contain a token')
  assert.equal(isAccountId('../evil'), false)
})

await check('vault is merged into scanCredentials as a first-class credential source', async () => {
  const storeDir = path.join(temp, 'vault-scan')
  fs.mkdirSync(storeDir, { recursive: true })
  saveAccount(storeDir, 'global', {
    accessToken: 'merged-token', refreshToken: 'merged-ref', domain: 'www.workbuddy.ai', uid: 'merged-uid',
    expiresAtMs: Date.now() + 3600_000,
  })
  const result = await scanCredentials({ env: {}, platform: 'linux', home: temp, storeDir, keyProvider: async () => undefined })
  const vault = result.accounts.find(row => row.source === 'vault')
  assert.ok(vault, 'vault account must appear in the merged roster')
  assert.equal(vault.region, 'global')
  assert.equal(vault.credential.accessToken, 'merged-token')
  assert.ok(vault.vaultAccountId, 'vault accounts carry their own id for deletion')
  assert.equal(result.diagnostics.encryptedCredentialUnsupported, false)
})

await check('vault export produces a server-ready workbuddy-auth.global.json', () => {
  const storeDir = path.join(temp, 'vault-export')
  fs.mkdirSync(storeDir, { recursive: true })
  saveAccount(storeDir, 'global', {
    accessToken: 'export-token', refreshToken: 'export-ref', domain: 'www.workbuddy.ai', uid: 'e-uid',
    expiresAtMs: Date.now() + 3600_000,
  })
  const exported = exportVault(storeDir).global
  assert.equal(exported.filename, 'workbuddy-auth.global.json')
  const doc = JSON.parse(exported.content)
  assert.equal(doc.auth.accessToken, 'export-token')
  assert.equal(doc.auth.refreshToken, 'export-ref', 'refresh token must travel so the server can renew')
  assert.equal(doc.auth.domain, 'www.workbuddy.ai')
  assert.equal(exportVault(path.join(temp, 'vault-empty')).global, undefined)
})

await check('deleteAccount removes only the vault copy and never a desktop file', () => {
  const storeDir = path.join(temp, 'vault-delete')
  fs.mkdirSync(storeDir, { recursive: true })
  const { accountId } = saveAccount(storeDir, 'cn', {
    accessToken: 'del-token', refreshToken: 'del-ref', domain: 'copilot.tencent.com', uid: 'd-uid',
  })
  const desktopFile = path.join(storeDir, 'workbuddy-desktop.info')
  fs.writeFileSync(desktopFile, JSON.stringify({ auth: { accessToken: 'desktop-token', domain: 'copilot.tencent.com' }, account: { uid: 'desk-1' } }))
  assert.equal(deleteAccount(storeDir, 'cn', accountId), true)
  assert.equal(deleteAccount(storeDir, 'cn', accountId), false)
  assert.ok(fs.existsSync(desktopFile), 'deleting a vault account must not touch the desktop auth file')
})

// ── 13. adapter 的登录 / 账号管理接线 ────────────────────────────────────────
await check('adapter polls a web login, writes the vault and exposes a deletable account', async () => {
  const storeDir = path.join(temp, 'adapter-weblogin')
  fs.mkdirSync(storeDir, { recursive: true })
  const { fetchImpl } = oauthFetch({ pendingFirst: false })
  const adapter = new WorkBuddyDesktopAdapter({
    region: 'global', provider: 'workbuddy', storeDir, logger: quiet,
    env: { WORKBUDDY_AUTH_FILE: path.join(storeDir, 'missing.info') },
    keyProvider: async () => undefined, fetchImpl,
  })
  const started = await adapter.startLogin()
  assert.ok(started.loginId)
  const polled = await adapter.pollLogin(started.loginId)
  assert.equal(polled.success, true)
  assert.ok(polled.accountId)
  await adapter.rescanNow()
  const accounts = adapter.publicAccounts()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].source, 'vault')
  assert.equal(accounts[0].deletable, true)
  assert.equal(JSON.stringify(accounts).includes('web-access'), false)
  assert.equal(adapter.vaultAccounts().length, 1)
  const exported = adapter.exportAccounts()
  assert.equal(exported.filename, 'workbuddy-auth.global.json')
  assert.ok(exported.content.includes('web-access'))
  const removed = await adapter.removeAccount(polled.accountId)
  assert.equal(removed.removed, true)
  assert.equal(adapter.vaultAccounts().length, 0)
})

await check('adapter rejects a web login whose account belongs to the other region', async () => {
  const storeDir = path.join(temp, 'adapter-wrongregion')
  fs.mkdirSync(storeDir, { recursive: true })
  const fetchImpl = async (url) => {
    const json = obj => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) })
    if (url.includes('/auth/state')) return json({ code: 0, data: { state: 'S', authUrl: 'https://www.codebuddy.cn/login?state=S' } })
    if (url.includes('/auth/token')) return json({ code: 0, data: { accessToken: 'cn-token', refreshToken: 'cn-ref', domain: 'copilot.tencent.com' } })
    return json({ code: 0, data: { uid: 'cn-uid', domain: 'copilot.tencent.com' } })
  }
  const adapter = new WorkBuddyDesktopAdapter({
    region: 'global', provider: 'workbuddy', storeDir, logger: quiet,
    env: {}, keyProvider: async () => undefined, fetchImpl,
  })
  const started = await adapter.startLogin()
  const polled = await adapter.pollLogin(started.loginId)
  assert.equal(polled.success, false)
  assert.match(polled.error, /国内版/)
  assert.equal(adapter.vaultAccounts().length, 0, 'a wrong-region login must not be saved')
})

fs.rmSync(temp, { recursive: true, force: true })
console.log(`\nworkbuddy-desktop: ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exitCode = failures === 0 ? 0 : 1
