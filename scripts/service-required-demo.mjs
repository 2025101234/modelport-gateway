/**
 * 演示：服务停止后控制台是否还能进；会话是否跨重启存活。
 *
 *     node scripts/service-required-demo.mjs
 *
 * 结论会打印在最后。不访问外网。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-demo-'))
process.env.MODELPORT_HOME = scratch
process.env.MODELPORT_TEST_UPSTREAM = '1'

const { startService } = await import('../app/service.mjs')
const quiet = { warn: () => {}, info: () => {}, error: () => {} }

const reach = async url => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return `HTTP ${r.status}`
  } catch (error) {
    return `无法连接（${error.cause?.code ?? error.name}）`
  }
}

// ── 第一次启动 ──────────────────────────────────────────────────────────────
let service = await startService({ port: 0, refresh: false, logger: quiet })
const key = JSON.parse(fs.readFileSync(service.keyFile, 'utf8')).forwardKey
const base = service.url
const token = service.managementUrl.split('#login=')[1]
console.log(`服务地址        ${base}`)
console.log(`API Key        ${key.slice(0, 12)}…（永久）`)

console.log('\n--- 服务运行中 ---')
console.log(`控制台首页     ${await reach(`${base}/`)}`)
const session = await fetch(`${base}/api/management/session`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key }),
})
const cookie = session.headers.get('set-cookie').split(';')[0]
console.log(`用 Key 登录     HTTP ${session.status}`)
console.log(`带会话读摘要   ${await reach2(`${base}/api/management/summary`, { cookie })}`)

async function reach2(url, headers) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(3000) })
    return `HTTP ${r.status}`
  } catch (error) {
    return `无法连接（${error.cause?.code ?? error.name}）`
  }
}

// ── 停掉服务 ────────────────────────────────────────────────────────────────
await service.close()
console.log('\n--- 服务已停止 ---')
console.log(`控制台首页     ${await reach(`${base}/`)}`)
console.log(`带会话读摘要   ${await reach2(`${base}/api/management/summary`, { cookie })}`)
console.log(`推理接口       ${await reach(`${base}/v1/models`)}`)

// ── 再启动一次 ──────────────────────────────────────────────────────────────
service = await startService({ port: 0, refresh: false, logger: quiet, dataDir: scratch })
const base2 = service.url
console.log('\n--- 重新启动后 ---')
console.log(`端口是否相同   ${base2 === base ? '相同' : `不同：${base} → ${base2}`}`)
console.log(`API Key 是否相同 ${JSON.parse(fs.readFileSync(service.keyFile, 'utf8')).forwardKey === key ? '相同（永久有效）' : '变了'}`)
console.log(`带旧会话读摘要 ${await reach2(`${base2}/api/management/summary`, { cookie })}`)
const again = await fetch(`${base2}/api/management/session`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key }),
})
console.log(`用同一个 Key 再登录 HTTP ${again.status}`)
console.log(`旧链接是否还能用 ${(await (await fetch(`${base2}/api/management/session`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ bootstrapToken: token }),
})).status) === 200 ? '能' : '不能（已被消费或已过期）'}`)

await service.close()
fs.rmSync(scratch, { recursive: true, force: true })

console.log(`
结论：
  服务是控制台本身。服务一停，端口就没人监听，浏览器连不上——登录状态救不了这一点。
  会话只活在内存里，服务重启即失效，所以每次启动都要重新「登录」一次（用 Key 或新链接）。
  永久有效的是 API Key：它省掉的是「重新拿链接」，不是「重新启动服务」。`)