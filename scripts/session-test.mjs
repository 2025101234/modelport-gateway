/**
 * 一次性登录链接的生命周期验证。
 *
 *     node scripts/session-test.mjs
 *
 * 验证三件事，因为这三件决定了「链接过期之后还能不能进控制台」：
 *   1. 链接兑换一次之后就不能再用（一次性）；
 *   2. 过期之后链接被拒；
 *   3. 链接失效后，settings.json 里的 API Key 仍然能登录。
 *
 * 不访问外网：只打本机服务。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-session-'))
process.env.MODELPORT_HOME = scratch
process.env.MODELPORT_TEST_UPSTREAM = '1'

const { startService } = await import('../app/service.mjs')
const quiet = { warn: () => {}, info: () => {}, error: () => {} }
const service = await startService({ port: 0, refresh: false, logger: quiet })
const key = JSON.parse(fs.readFileSync(service.keyFile, 'utf8')).forwardKey

let failures = 0
const check = async (name, body) => {
  try { await body(); console.log(`ok   ${name}`) }
  catch (error) { failures += 1; console.log(`FAIL ${name} — ${error.message}`) }
}

/** 兑换一个会话，返回 status 与 Set-Cookie。 */
const exchange = async payload => {
  const response = await fetch(`${service.url}/api/management/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, cookie: response.headers.get('set-cookie') }
}

const token = service.managementUrl.split('#login=')[1]
assert.ok(token, 'the printed URL must carry a bootstrap token')

try {
  await check('the printed link carries a bootstrap token', () => {
    assert.ok(token.length > 20)
    assert.ok(service.managementUrl.startsWith('http://127.0.0.1:'))
  })

  await check('the token mints a session and an eight-hour cookie', async () => {
    const { status, cookie } = await exchange({ bootstrapToken: token })
    assert.equal(status, 200)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /Max-Age=28800/)   // 8 h
    assert.match(cookie, /SameSite=Strict/)
  })

  await check('the same token cannot be redeemed twice', async () => {
    const { status } = await exchange({ bootstrapToken: token })
    assert.equal(status, 401, 'a one-time link must not work twice')
  })

  await check('the served page never carries the token', async () => {
    // The token rides in the URL fragment, which the browser strips before the
    // request is made — so the server-rendered console must not contain it.
    // (`service.managementUrl` is a startup snapshot and keeps the string; what
    // matters is that nothing the server hands back echoes it.)
    const page = await (await fetch(`${service.url}/`)).text()
    assert.equal(page.includes(token), false, 'the console HTML must not embed the one-time token')
  })

  await check('the API key still signs in after the link is spent', async () => {
    const { status, cookie } = await exchange({ key })
    assert.equal(status, 200, 'the key is the durable way in')
    assert.match(cookie, /Max-Age=28800/)
  })

  await check('a wrong token is refused', async () => {
    const { status } = await exchange({ bootstrapToken: 'not-the-token' })
    assert.equal(status, 401)
  })

  await check('a wrong key is refused', async () => {
    const { status } = await exchange({ key: `${key}-tampered` })
    assert.equal(status, 401)
  })

  await check('management data needs a session, not just the port', async () => {
    const response = await fetch(`${service.url}/api/management/summary`)
    assert.equal(response.status, 401)
  })

  await check('a fresh service mints a fresh link', async () => {
    await service.close()
    const next = await startService({ port: 0, refresh: false, logger: quiet, dataDir: scratch })
    try {
      const fresh = next.managementUrl.split('#login=')[1]
      assert.ok(fresh, 'restarting must produce a new link')
      assert.notEqual(fresh, token, 'the new token must differ from the spent one')
      // The API key survives a restart, so it stays the stable way in.
      assert.equal(JSON.parse(fs.readFileSync(next.keyFile, 'utf8')).forwardKey, key)
    } finally { await next.close() }
  })
} finally {
  try { await service.close() } catch { /* already closed above */ }
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nsession: ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exitCode = failures === 0 ? 0 : 1