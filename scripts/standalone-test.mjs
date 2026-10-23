/**
 * The standalone service's own contract: isolation, lifecycle and the wire.
 *
 * What this suite is for — and what it must not become — is worth stating,
 * because it used to carry a second job. It drove the anonymous free lane and
 * the Kilo pool through a local stand-in, and asserted their request
 * fingerprint, their availability probing, their 429 backoff and their listing
 * cache. Those lanes are gone, and with them every one of those assertions:
 * fingerprinting, probing and backoff were properties of a lane, not of the
 * service.
 *
 * What remains is everything that is true of *the service itself*, which is why
 * the channel runtime is injected as a double (`scripts/lib/fake-channels.mjs`)
 * rather than exercised for real:
 *
 * - it keeps its own data directory and never reads the host's;
 * - it mints its own key, takes an exclusive lock, and cleans up on exit;
 * - it speaks all three wires on one port (Chat, Responses, Anthropic);
 * - an unknown model is refused before anything is spent;
 * - a channel that refuses is reported as a refusal, not as an empty success;
 * - usage and turns land in the stats store;
 * - a restart reuses its key and its port.
 *
 * Run: node scripts/standalone-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-standalone-'))
const dataDir = path.join(scratch, 'gateway')
const dshHome = path.join(scratch, 'dsh')
fs.mkdirSync(path.join(dshHome, 'modelport'), { recursive: true })
const sentinelPath = path.join(dshHome, 'modelport', 'settings.json')
const sentinel = JSON.stringify({ forwardKey: 'dsh-only-key', enabled: false, privateMarker: 'do-not-copy' })
fs.writeFileSync(sentinelPath, sentinel)
process.env.MODELPORT_HOME = dshHome

const model = 'fakechan/basic'
const broken = 'fakechan/broken'

const { startService, resolveDataDir } = await import('../app/service.mjs')
const { createRuntimeStores } = await import('../src/core/runtime.js')
const { fakeChannelRuntime } = await import('./lib/fake-channels.mjs')

const fake = fakeChannelRuntime({ reply: 'core-ok' })
const channels = options => { fake.attach(options.stats); return fake }

let failures = 0
let checks = 0
let service
const check = async (name, run) => {
  checks++
  try { await run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`) }
}
const jsonRequest = (url, body, key, extra = {}) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extra },
  body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
})
async function child(args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd: root, env: { ...process.env, ...env }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', chunk => { stdout += chunk })
    proc.stderr.on('data', chunk => { stderr += chunk })
    const deadline = setTimeout(() => { proc.kill(); reject(new Error('child timed out')) }, 10000)
    proc.once('error', error => { clearTimeout(deadline); reject(error) })
    proc.once('exit', code => { clearTimeout(deadline); resolve({ code, stdout, stderr }) })
  })
}

try {
  await check('default data path ignores an unrelated host home', () => {
    assert.equal(resolveDataDir({}, scratch), path.join(scratch, '.modelport'))
    assert.equal(resolveDataDir({ MODELPORT_HOME: dataDir }, scratch), dataDir)
  })

  await check('different runtimes own independent settings and statistics', () => {
    const first = createRuntimeStores({ dataDir: path.join(scratch, 'one') })
    const second = createRuntimeStores({ dataDir: path.join(scratch, 'two') })
    try {
      first.settings.get().port = 12345
      first.stats.get().days.privateDay = { total: 1 }
      assert.notEqual(second.settings.get().port, 12345)
      assert.equal(second.stats.get().days.privateDay, undefined)
    } finally { first.dispose(); second.dispose() }
  })

  await check('routable binds and invalid ports fail before creating data', async () => {
    const invalidDir = path.join(scratch, 'invalid')
    await assert.rejects(startService({ dataDir: invalidDir, host: '0.0.0.0' }), /loopback/)
    await assert.rejects(startService({ dataDir: invalidDir, port: -1 }), /port/)
    await assert.rejects(startService({ dataDir: invalidDir, port: 65536 }), /port/)
    assert.equal(fs.existsSync(invalidDir), false)
  })

  await check('退出时保留已被替换的其他锁，不清理无法确认归属的文件', async () => {
    const directory = path.join(scratch, 'replaced-lock')
    const isolated = await startService({ dataDir: directory, port: 0, refresh: false, logger: { warn() {} }, createChannels: channels })
    const lockFile = path.join(directory, 'service.lock')
    const replacement = JSON.stringify({ pid: process.pid, product: 'modelport', token: 'another-owner' })
    fs.unlinkSync(lockFile)
    fs.writeFileSync(lockFile, replacement)
    await isolated.close()
    assert.equal(fs.readFileSync(lockFile, 'utf8'), replacement)
  })

  await check('启动中途失败会同时释放文件锁与进程互斥端点，修复配置后可重启', async () => {
    const directory = path.join(scratch, 'failed-boot')
    const settingsFile = path.join(directory, 'settings.json')
    fs.mkdirSync(settingsFile, { recursive: true })
    await assert.rejects(startService({ dataDir: directory, port: 0, refresh: false, logger: { warn() {} }, createChannels: channels }), /persist/)
    assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false)
    fs.rmdirSync(settingsFile)
    const recovered = await startService({ dataDir: directory, port: 0, refresh: false, logger: { warn() {} }, createChannels: channels })
    await recovered.close()
  })

  if (process.platform === 'win32' || process.platform === 'linux') {
    await check('没有权限检查进程时保留锁，不把 EPERM 当成进程退出', async () => {
      const directory = path.join(scratch, 'permission-lock')
      const lockFile = path.join(directory, 'service.lock')
      fs.mkdirSync(directory)
      const original = JSON.stringify({ pid: process.pid, product: 'modelport' })
      fs.writeFileSync(lockFile, original)
      const nativeKill = process.kill
      process.kill = () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }) }
      try {
        await assert.rejects(startService({ dataDir: directory, port: 0, refresh: false, createChannels: channels }), { code: 'EEXIST' })
        assert.equal(fs.readFileSync(lockFile, 'utf8'), original)
      } finally { process.kill = nativeKill }
    })
  }

  await check('the listener serves health and advertises the channel lane', async () => {
    service = await startService({ dataDir, port: 0, logger: { warn() {} }, createChannels: channels })
    const response = await fetch(`${service.url}/health`, { signal: AbortSignal.timeout(5000) })
    const health = await response.json()
    assert.equal(response.status, 200)
    assert.equal(health.product, 'gateway')
    assert.equal(health.capabilities.accountChannels, true)
    assert.equal(health.capabilities.combos, true)
    // 免费车道与聚合车道已经不存在，能力表里也不该再宣称它们。
    assert.equal(health.capabilities.anonymous, undefined)
    assert.equal(health.capabilities.aggregate, undefined)
  })
  if (!service) throw new Error('standalone did not start')
  const key = JSON.parse(fs.readFileSync(service.keyFile)).forwardKey

  await check('standalone generates its own API key without copying DSH data', () => {
    assert.match(key, /^mp-/)
    assert.notEqual(key, 'dsh-only-key')
    assert.equal(JSON.parse(fs.readFileSync(service.keyFile)).privateMarker, undefined)
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), sentinel)
  })

  await check('another instance cannot write the same data directory', async () => {
    await assert.rejects(startService({ dataDir, port: 0, refresh: false, createChannels: channels }), { code: 'EEXIST' })
    assert.equal(JSON.parse(fs.readFileSync(service.keyFile)).forwardKey, key)
  })

  await check('model list requires the standalone key and rejects the DSH key', async () => {
    assert.equal((await fetch(`${service.url}/v1/models`)).status, 401)
    assert.equal((await fetch(`${service.url}/v1/models`, { headers: { authorization: 'Bearer dsh-only-key' } })).status, 401)
    const response = await fetch(`${service.url}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
    assert.equal(response.status, 200)
    const rows = (await response.json()).data
    assert.ok(rows.some(row => row.id === model), 'the channel rows must be in the roster')
  })

  await check('non-streaming Chat Completions uses the shared core', async () => {
    const response = await jsonRequest(`${service.url}/v1/chat/completions`, {
      model, messages: [{ role: 'user', content: 'hello' }],
    }, key)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.choices[0].message.content, 'core-ok')
    assert.equal(body.usage.prompt_tokens, 12)
    assert.equal(body.usage.completion_tokens, 'core-ok'.length)
  })

  await check('streaming completions preserve deltas, usage and terminal frames', async () => {
    const response = await jsonRequest(`${service.url}/v1/chat/completions`, {
      model, messages: [{ role: 'user', content: 'hello' }], stream: true,
    }, key)
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /core-ok/)
    assert.match(body, /completion_tokens/)
    assert.match(body, /\[DONE\]/)
  })

  await check('the Responses wire answers on the same port', async () => {
    const response = await jsonRequest(`${service.url}/v1/responses`, { model, input: 'hello' }, key)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.ok(JSON.stringify(body.output).includes('core-ok'))
  })

  await check('the Anthropic wire and count_tokens answer on the same port', async () => {
    const response = await jsonRequest(`${service.url}/v1/messages`, {
      model, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }],
    }, key)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.ok(JSON.stringify(body.content).includes('core-ok'))
    const counted = await jsonRequest(`${service.url}/v1/messages/count_tokens`, {
      model, messages: [{ role: 'user', content: 'hello' }],
    }, key)
    assert.equal(counted.status, 200)
    assert.ok((await counted.json()).input_tokens > 0)
  })

  await check('a channel that refuses is reported, not answered with an empty success', async () => {
    const response = await jsonRequest(`${service.url}/v1/chat/completions`, {
      model: broken, messages: [{ role: 'user', content: 'hello' }],
    }, key)
    assert.ok(response.status >= 400, `a refusal must not arrive as ${response.status}`)
    assert.match(JSON.stringify(await response.json()), /refused this turn/)
  })

  await check('unknown models are refused before spending a channel call', async () => {
    const before = fake.calls.length
    const response = await jsonRequest(`${service.url}/v1/chat/completions`, {
      model: 'missing-model', messages: [{ role: 'user', content: 'hello' }],
    }, key)
    assert.equal(response.status, 404)
    assert.equal(fake.calls.length, before, 'a 404 must not reach the channel')
  })

  await check('statistics persist and repeated shutdown releases the listener and lock', async () => {
    assert.equal(service.runtime.state().settings.forwardKey, key)
    assert.equal(fs.existsSync(path.join(dataDir, 'service.lock')), true)
    await Promise.all([service.close(), service.close()])
    assert.equal(fs.existsSync(path.join(dataDir, 'service.lock')), false)
    const stats = JSON.parse(fs.readFileSync(path.join(dataDir, 'stats.json')))
    assert.ok(stats.requests >= 4, `expected the turns above to be recorded, got ${stats.requests}`)
    await assert.rejects(fetch(`${service.url}/health`))
    await assert.rejects(service.runtime.complete({ model, openAi: {} }), { statusCode: 503 })
  })

  await check('restart reuses its own key and port and re-lists the channel', async () => {
    const previousPort = service.port
    service = await startService({ dataDir, refresh: false, logger: { warn() {} }, createChannels: channels })
    assert.equal(service.port, previousPort)
    assert.equal(JSON.parse(fs.readFileSync(service.keyFile)).forwardKey, key)
    assert.deepEqual(service.runtime.catalog.map(entry => entry.id), ['fakechan/basic', 'fakechan/vision', 'fakechan/broken'])
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), sentinel)
  })

  await check('a separate process boots with plugin and DSH imports forbidden', async () => {
    const result = await child([
      '--experimental-loader', './scripts/lib/standalone-isolation-loader.mjs',
      '--input-type=module', '--eval',
      `import { startService } from './app/service.mjs';
       const service = await startService({ port: 0, refresh: false });
       try {
         const response = await fetch(service.url + '/health');
         if ((await response.json()).product !== 'gateway') throw new Error('wrong product');
         if (globalThis[Symbol.for('modelport.generation')] !== undefined) throw new Error('plugin loaded');
         console.log('standalone-only');
       } finally { await service.close() }`,
    ], { MODELPORT_HOME: path.join(scratch, 'isolated-child') })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /standalone-only/)
  })

  await check('CLI help and invalid arguments do not start a service', async () => {
    const help = await child(['app/cli.mjs', '--help'])
    assert.equal(help.code, 0)
    assert.match(help.stdout, /--data-dir/)
    for (const flag of ['--unknown', '--port', '--port=-1']) {
      assert.notEqual((await child(['app/cli.mjs', flag])).code, 0)
    }
    assert.notEqual((await child(['app/cli.mjs', '--port', '65536'])).code, 0)
  })
} finally {
  await service?.close()
  const target = fs.realpathSync(scratch)
  assert.ok(target.startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(target, { recursive: true, force: true })
}

console.log(`\nstandalone: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1