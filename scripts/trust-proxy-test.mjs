/**
 * 反代部署的同源围栏回归。
 *
 *     node scripts/trust-proxy-test.mjs
 *
 * 默认（trustProxy 关闭）必须仍只认回环 Host；开启后，浏览器经由可信反代
 * 发来的 X-Forwarded-Host 成为同源判据。纯函数测试，不启动服务、不联网。
 */
import assert from 'node:assert/strict'
import { structuralRejection, rejectionFor } from '../src/trust.js'

let failures = 0
const check = (name, body) => {
  try { body(); console.log(`ok   ${name}`) }
  catch (error) { failures += 1; console.log(`FAIL ${name} — ${error.message}`) }
}

const req = (over = {}) => ({ headers: { host: '127.0.0.1:18900', ...over } })

check('default fence still requires a loopback Host', () => {
  assert.equal(structuralRejection(req()), undefined)
  assert.equal(structuralRejection(req({ host: 'evil.example' })), 403)
  assert.equal(structuralRejection(req({ host: '47.108.118.69' })), 403)
})

check('default fence rejects an Origin that does not match the loopback Host', () => {
  assert.equal(structuralRejection(req({ origin: 'http://47.108.118.69' })), 403)
  assert.equal(structuralRejection(req({ origin: 'http://127.0.0.1:18900' })), undefined)
  assert.equal(structuralRejection(req({ referer: 'http://127.0.0.1:18900/' })), undefined)
})

check('default fence keeps refusing cross-site fetches', () => {
  assert.equal(structuralRejection(req({ 'sec-fetch-site': 'cross-site' })), 403)
  assert.equal(structuralRejection(req({ 'sec-fetch-site': 'same-origin' })), undefined)
})

check('default fence ignores X-Forwarded-Host when trustProxy is off', () => {
  assert.equal(structuralRejection(req({
    'x-forwarded-host': '47.108.118.69', origin: 'http://47.108.118.69',
  })), 403)
})

check('trustProxy accepts the browser origin carried by X-Forwarded-Host', () => {
  assert.equal(structuralRejection(req({
    'x-forwarded-host': '47.108.118.69',
    'x-forwarded-proto': 'http',
    origin: 'http://47.108.118.69',
    referer: 'http://47.108.118.69/',
    'sec-fetch-site': 'same-origin',
  }), { trustProxy: true }), undefined)
})

check('trustProxy accepts https forwarded origin and default ports', () => {
  assert.equal(structuralRejection(req({
    'x-forwarded-host': 'gw.example.com',
    'x-forwarded-proto': 'https',
    origin: 'https://gw.example.com',
  }), { trustProxy: true }), undefined)
})

check('trustProxy still rejects a mismatched or forged Origin', () => {
  const base = { 'x-forwarded-host': '47.108.118.69', 'x-forwarded-proto': 'http' }
  assert.equal(structuralRejection(req({ ...base, origin: 'http://evil.example' }), { trustProxy: true }), 403)
  assert.equal(structuralRejection(req({ ...base, origin: 'https://47.108.118.69' }), { trustProxy: true }), 403)
  assert.equal(structuralRejection(req({ ...base, referer: 'http://evil.example/x' }), { trustProxy: true }), 403)
})

check('trustProxy still requires a loopback Host (proxy must not be able to widen the bind)', () => {
  assert.equal(structuralRejection(req({
    host: '0.0.0.0:18900', 'x-forwarded-host': '47.108.118.69',
  }), { trustProxy: true }), 403)
})

check('trustProxy still refuses cross-site fetches', () => {
  assert.equal(structuralRejection(req({
    'x-forwarded-host': '47.108.118.69', 'sec-fetch-site': 'cross-site',
  }), { trustProxy: true }), 403)
})

check('trustProxy takes the first value of a comma-joined forwarded header', () => {
  assert.equal(structuralRejection(req({
    'x-forwarded-host': '47.108.118.69, proxy.internal',
    origin: 'http://47.108.118.69',
  }), { trustProxy: true }), undefined)
})

check('trustProxy tolerates a repeated X-Forwarded-Proto header', () => {
  // A misconfigured proxy can emit the header twice ("http, http"); comparing
  // the raw joined value against the origin would reject every request.
  assert.equal(structuralRejection(req({
    'x-forwarded-host': '47.108.118.69',
    'x-forwarded-proto': 'http, http',
    origin: 'http://47.108.118.69',
  }), { trustProxy: true }), undefined)
  assert.equal(structuralRejection(req({
    'x-forwarded-host': '47.108.118.69',
    'x-forwarded-proto': 'http, http',
    origin: 'https://47.108.118.69',
  }), { trustProxy: true }), 403, 'the first value still decides the scheme')
})

check('trustProxy rejects a malformed forwarded header value', () => {
  assert.equal(structuralRejection(req({
    'x-forwarded-host': 'http://evil.example',
    origin: 'http://evil.example',
  }), { trustProxy: true }), 403)
})

check('rejectionFor passes the options through to the structural fence', () => {
  const proxied = req({
    'x-forwarded-host': '47.108.118.69', origin: 'http://47.108.118.69',
  })
  assert.equal(rejectionFor(proxied, undefined, undefined, { trustProxy: true }), undefined)
  assert.equal(rejectionFor(proxied, undefined, undefined), 403)
})

console.log(`\ntrust-proxy: ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exitCode = failures === 0 ? 0 : 1
