/**
 * 账号渠道的离线回归：渠道运行时、渠道 RPC 与管理 API。
 *
 *     node scripts/channels-test.mjs
 *
 * 不访问任何上游：只验证「13 个渠道都被注册」「模型目录能读」「未登录时账号
 * 列表为空而不是报错」「管理面能透传渠道 RPC」。真正的登录要人去点浏览器，
 * 这里不碰。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createChannelRuntime } = await import('../app/channels/runtime.mjs')
const { startService } = await import('../app/service.mjs')

let failures = 0
const check = async (name, body) => {
  try {
    await body()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name} — ${error.message}`)
  }
}

/**
 * 渠道的 provider id 清单：十三家来自上游渠道包（按包内注册顺序），外加 grok。
 *
 * Grok 是本仓库自己注册的（见 app/channels/grok.mjs）而不是渠道包里的，所以它排在
 * 最后，且是唯一一个不走 `account.create` 登录流程的渠道——它的凭据靠用户粘贴
 * Cookie。别把这一行当成笔误删掉：删了这条断言就再也发现不了「grok 悄悄不见了」。
 */
const EXPECTED = [
  'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn',
  'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'gemini', 'zcode',
  'grok',
]

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-channels-'))
const quiet = { warn: () => {}, info: () => {}, error: () => {} }

// ── the runtime on its own ───────────────────────────────────────────────────
const runtime = await createChannelRuntime({ dataDir, logger: quiet })

await check('the runtime registers every channel, including the one it owns itself', () => {
  assert.deepEqual([...runtime.providers].sort(), [...EXPECTED].sort())
})

await check('WorkBuddy and CodeBuddy are both present', () => {
  assert.ok(runtime.providers.includes('workbuddy'), 'WorkBuddy must be registered')
  assert.ok(runtime.providers.includes('buddy'), 'CodeBuddy must be registered')
})

await check('every channel reports a model catalogue while signed out', async () => {
  for (const provider of EXPECTED) {
    const result = await runtime.rpc({ method: 'model.list', payload: { provider } })
    assert.equal(result.ok, true, `${provider} refused model.list: ${JSON.stringify(result.error)}`)
    assert.ok(Array.isArray(result.value.models), `${provider} returned no models array`)
    assert.ok(result.value.models.length > 0, `${provider} returned an empty catalogue`)
    for (const model of result.value.models) assert.equal(typeof model.id, 'string')
  }
})

await check('the fallback catalogues cover the documented models', async () => {
  const workbuddy = await runtime.rpc({ method: 'model.list', payload: { provider: 'workbuddy' } })
  const ids = workbuddy.value.models.map(model => model.id)
  // These four are the tiered aliases WorkBuddy itself uses.
  for (const id of ['default-model', 'fast-model', 'balanced-model']) {
    assert.ok(ids.includes(id), `WorkBuddy catalogue is missing ${id}`)
  }
})

await check('an account list is empty, not an error, while signed out', async () => {
  for (const provider of ['workbuddy', 'buddy', 'codearts']) {
    const result = await runtime.rpc({ method: 'account.list', payload: { provider } })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.accounts, [])
  }
})

await check('a channel turn is routed by its provider prefix', () => {
  assert.equal(runtime.handles('workbuddy/default-model'), true)
  assert.equal(runtime.handles('buddy/glm-5.2'), true)
  assert.equal(runtime.handles('deepseek-v4.1-flash-free'), false)
  assert.equal(runtime.handles('deepseek/deepseek-v4-pro'), false)
})

await check('the runtime reports itself ready', () => {
  assert.equal(runtime.state().state, 'ready')
})

await check('an unknown rpc method is refused, not guessed', async () => {
  // The worker answers a verdict rather than throwing: `ok:false` with a
  // bad-request code is the contract the management route relays verbatim.
  const result = await runtime.rpc({ method: 'channel-pack', payload: {} })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /unknown method|unsupported/i)
})

await runtime.close()

// ── the management surface ──────────────────────────────────────────────────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-channels-svc-'))
process.env.MODELPORT_HOME = scratch
process.env.MODELPORT_TEST_UPSTREAM = '1'

const service = await startService({ port: 0, refresh: false, logger: quiet })
const key = JSON.parse(fs.readFileSync(service.keyFile, 'utf8')).forwardKey
const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }

const call = async (route, body, headers = auth) => {
  const response = await fetch(service.url + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? { authorization: auth.authorization } : headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

try {
  await check('health advertises the account channels', async () => {
    const health = await (await fetch(`${service.url}/health`)).json()
    assert.equal(health.capabilities.accountChannels, true)
  })

  await check('summary carries the channel state and provider list', async () => {
    const { status, body } = await call('/api/management/summary')
    assert.equal(status, 200)
    assert.equal(body.channels.state, 'ready')
    assert.deepEqual([...body.channelProviders].sort(), [...EXPECTED].sort())
  })

  await check('the channel state route answers without the key', async () => {
    const response = await fetch(`${service.url}/api/management/channels/state`)
    assert.equal(response.status, 401, 'the management surface stays fenced')
  })

  await check('a channel rpc is forwarded to the worker', async () => {
    const { status, body } = await call('/api/management/channels/rpc', {
      method: 'model.list', payload: { provider: 'workbuddy' },
    })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.ok(body.value.models.length > 0)
  })

  await check('a malformed rpc body is refused with 400', async () => {
    const { status } = await call('/api/management/channels/rpc', { method: 'model.list' })
    assert.equal(status, 400)
  })

  await check('channel models do not leak into the roster before sign-in', async () => {
    const models = await (await fetch(`${service.url}/v1/models`, { headers: auth })).json()
    // The channel catalogues are known, but a signed-out channel contributes no
    // routable row: the roster is what a caller may actually spend a turn on.
    const channelIds = models.data.filter(row => EXPECTED.some(provider => row.id.startsWith(`${provider}/`)))
    assert.equal(channelIds.length, 0, `signed-out channels must not advertise turns: ${channelIds.map(r => r.id).join(', ')}`)
  })
} finally {
  await service.close()
  fs.rmSync(scratch, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log(`\nchannels: ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exitCode = failures === 0 ? 0 : 1
