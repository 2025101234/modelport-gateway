/**
 * 端到端验收：启动真实服务，验证三种协议都能真正出字。
 *
 *     node scripts/e2e-check.mjs
 *
 * 这不是离线套件的一部分（它要起监听、走完整启动流程），而是发布前手动跑一遍的
 * 验收脚本。它不访问外网、不消耗任何渠道额度，因为模型来源由替身渠道注入
 * （`scripts/lib/fake-channels.mjs`）——真实的 13 家渠道都需要人登录，那不是一个
 * 验收脚本该要求的前提。
 *
 * 这里曾经用本机替身上游模拟匿名免费车道与 Kilo 池，并检查 75 家聚合提供商。那三条
 * 车道都已移除，所以那些检查也随之删除；取而代之的是本次改造后真正需要端到端确认
 * 的东西：链路的故障转移确实跨渠道发生了。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-e2e-'))
process.env.MODELPORT_HOME = scratch
process.env.MODELPORT_TEST_UPSTREAM = '1'

const { startService } = await import('../app/service.mjs')
const { fakeChannelRuntime } = await import('./lib/fake-channels.mjs')

const fake = fakeChannelRuntime({ reply: 'E2E-OK' })
let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}

const service = await startService({
  port: 0, refresh: true,
  createChannels: options => { fake.attach(options.stats); return fake },
})
const key = JSON.parse(fs.readFileSync(service.keyFile, 'utf8')).forwardKey
const auth = { authorization: `Bearer ${key}` }
const json = body => ({ ...auth, 'content-type': 'application/json' })
const post = (route, body) => fetch(`${service.url}${route}`, { method: 'POST', headers: json(), body: JSON.stringify(body) })

try {
  // 1 — health needs no key and names no credential.
  const health = await (await fetch(`${service.url}/health`)).json()
  check('health answers without a key', health.ok === true && health.service === 'modelport')
  check('health advertises the account channels and chains, and no removed lane',
    health.capabilities.accountChannels === true && health.capabilities.combos === true
    && health.capabilities.aggregate === undefined && health.capabilities.anonymous === undefined,
    JSON.stringify(health.capabilities))

  // 2 — the key is required on every inference route.
  for (const route of ['/v1/models', '/v1/chat/completions', '/v1/messages']) {
    const response = await fetch(`${service.url}${route}`, { method: route === '/v1/models' ? 'GET' : 'POST', body: route === '/v1/models' ? undefined : '{}', headers: { 'content-type': 'application/json' } })
    check(`${route} refuses a keyless caller`, response.status === 401, `status ${response.status}`)
  }

  // 3 — the roster carries the channel's models and nothing else.
  const models = await (await fetch(`${service.url}/v1/models`, { headers: auth })).json()
  const ids = models.data.map(row => row.id)
  check('the roster lists the channel models', ids.includes('fakechan/basic') && ids.includes('fakechan/vision'), ids.join(','))
  check('the roster carries no lane that was removed', !ids.some(id => /-free$|^kilo|^deepseek\//.test(id)), ids.join(','))

  // 4 — Chat Completions answers.
  const chat = await (await post('/v1/chat/completions', { model: 'fakechan/basic', messages: [{ role: 'user', content: 'hi' }] })).json()
  check('chat completions answers', chat.choices?.[0]?.message?.content === 'E2E-OK', JSON.stringify(chat).slice(0, 200))

  // 5 — the same turn with stream:true comes back as SSE frames.
  const streamed = await (await post('/v1/chat/completions', { model: 'fakechan/basic', stream: true, messages: [{ role: 'user', content: 'hi' }] })).text()
  check('chat completions streams SSE', streamed.includes('data:') && streamed.includes('E2E-OK'), streamed.slice(0, 120))

  // 6 — Anthropic Messages answers on the same port.
  const messages = await (await post('/v1/messages', { model: 'fakechan/basic', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] })).json()
  check('anthropic messages answers', JSON.stringify(messages).includes('E2E-OK'), JSON.stringify(messages).slice(0, 200))

  // 7 — count_tokens is answered locally, with no channel request.
  const before = fake.calls.length
  const counted = await (await post('/v1/messages/count_tokens', { model: 'fakechan/basic', messages: [{ role: 'user', content: 'hi there' }] })).json()
  check('count_tokens answers locally', Number.isInteger(counted.input_tokens) && fake.calls.length === before, `${counted.input_tokens}`)

  // 8 — Responses answers too.
  const responses = await (await post('/v1/responses', { model: 'fakechan/basic', input: 'hi' })).json()
  check('responses answers', JSON.stringify(responses).includes('E2E-OK'), JSON.stringify(responses).slice(0, 200))

  // 9 — an unknown model is refused before any channel is called.
  const spentBefore = fake.calls.length
  const missing = await post('/v1/chat/completions', { model: 'nope/not-a-model', messages: [{ role: 'user', content: 'hi' }] })
  check('an unknown model is refused with 404 and spends nothing', missing.status === 404 && fake.calls.length === spentBefore, `status ${missing.status}`)

  // 10 — the management API is reachable with the same key.
  const summary = await (await fetch(`${service.url}/api/management/summary`, { headers: auth })).json()
  check('summary reports the sections that still exist',
    Array.isArray(summary.combos) && summary.tokenSaver?.enabled === true && summary.channels?.state === 'ready'
    && summary.aggregate === undefined, Object.keys(summary).join(','))
  check('summary lists every channel provider', Array.isArray(summary.channelProviders) && summary.channelProviders.includes('fakechan'))

  // 11 — a chain becomes a virtual model, and it really fails over.
  //
  // This is the whole point of keeping the chains after dropping the lanes they
  // were built for: their links are now channel models, and a link that refuses
  // must hand the turn to the next one without the caller ever seeing the seam.
  const combo = await (await post('/api/management/combos', {
    combos: [{ name: 'e2e chain', models: ['fakechan/broken', 'fakechan/basic'] }],
  })).json()
  check('a chain saves', combo.combos.length === 1 && combo.combos[0].models.length === 2, JSON.stringify(combo.combos))
  const chainId = combo.combos[0].id
  const withCombo = await (await fetch(`${service.url}/v1/models`, { headers: auth })).json()
  check('the chain appears as a model id', withCombo.data.some(row => row.id === chainId), chainId)

  const beforeChain = fake.calls.length
  const chained = await (await post('/v1/chat/completions', { model: chainId, messages: [{ role: 'user', content: 'hi' }] })).json()
  const tried = fake.calls.slice(beforeChain).map(call => call.model)
  check('the chain answers through its second link', chained.choices?.[0]?.message?.content === 'E2E-OK', JSON.stringify(chained).slice(0, 200))
  check('the refused link was tried first and then abandoned', tried.join(',') === 'fakechan/broken,fakechan/basic', tried.join(','))

  // 12 — the console is served, and its assets are all reachable.
  const page = await (await fetch(`${service.url}/`)).text()
  check('the console page is served', page.includes('app.js') && page.includes('id="root"'))
  const assets = JSON.parse(fs.readFileSync(new URL('../app/web/assets.json', import.meta.url), 'utf8'))
  let assetsOk = true
  for (const name of assets) {
    const response = await fetch(`${service.url}/assets/${name}`)
    if (response.status !== 200) { assetsOk = false; console.log(`       missing asset ${name}`) }
  }
  check(`all ${assets.length} console assets are served`, assetsOk)

  // 13 — the management UI refuses a cross-origin caller.
  const crossOrigin = await fetch(`${service.url}/api/management/summary`, { headers: { ...auth, origin: 'http://evil.example' } })
  check('a cross-origin management call is refused', crossOrigin.status === 403, `status ${crossOrigin.status}`)
} finally {
  await service.close()
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(`\ne2e: ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exitCode = failures === 0 ? 0 : 1