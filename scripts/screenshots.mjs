/**
 * 用 Chrome DevTools Protocol 逐页截图（不是测试的一部分，是发布前的视觉验收）。
 *
 *     node scripts/screenshots.mjs <控制台URL> [输出目录]
 *
 * 它连一个带 --remote-debugging-port 的无头 Chrome，登录进控制台，
 * 依次点开每一页并截图。只用于人工核对渲染结果。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const consoleUrl = process.argv[2]
const outDir = path.resolve(process.argv[3] ?? '.shots')
const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9333
const WIDTH = 1440
const HEIGHT = 1100

fs.mkdirSync(outDir, { recursive: true })

const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--window-size=${WIDTH},${HEIGHT}`,
  '--user-data-dir=' + path.join(outDir, '.chrome-profile'), 'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function target() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find(row => row.type === 'page')
      if (page) return page
    } catch { /* not up yet */ }
    await sleep(250)
  }
  throw new Error('the browser never exposed a page target')
}

const page = await target()
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })

let sequence = 0
const pending = new Map()
socket.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id)
    pending.delete(message.id)
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result)
    return
  }
  for (const listener of listeners.splice(0)) listener(message)
}
const listeners = []
const once = method => new Promise(resolve => {
  const listener = message => { if (message.method === method) resolve(message.params); else listeners.push(listener) }
  listeners.push(listener)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: consoleUrl })
await sleep(4000)

const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

const capture = async name => {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  const file = path.join(outDir, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log(`captured ${name}.png`)
}

/** Click a sidebar item by its visible label and wait for the page to settle. */
const openPage = async (label) => {
  const clicked = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.console-nav-item')]
    const hit = buttons.find(node => node.textContent.replace(/\\d+$/, '').trim() === ${JSON.stringify(label)})
    if (!hit) return false
    hit.click()
    return true
  })()`)
  if (!clicked) throw new Error(`no nav item labelled ${label}`)
  await sleep(1200)
}

const pages = [
  ['02-models', '模型清单'],
  ['03-usage', '用量统计'],
  ['04-channels', '账号渠道'],
  ['05-routing', '路由链路'],
  ['06-connection', 'API 接入'],
  ['07-settings', '服务设置'],
]

for (const [name, label] of pages) {
  await openPage(label)
  await capture(name)
}

// Narrow viewport: the console must not overflow horizontally.
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
await sleep(900)
await openPage('模型清单')
await capture('07-narrow-models')
const overflow = await evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
console.log(`narrow overflow: ${overflow}px`)

socket.close()
chrome.kill()
console.log('done')
