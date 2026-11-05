import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { createModelRuntime, createRuntimeStores } from '../src/core/runtime.js'
import { generateKey, rankLanAddresses, startForwardServer, startLanRelay } from '../src/forward.js'
import { isLoopbackHost } from '../src/trust.js'
import { createManagement } from './management.mjs'
import { createChannelRuntime } from './channels/runtime.mjs'

const PRODUCT = 'modelport'
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export function resolveDataDir(env = process.env, home = os.homedir()) {
  const configured = typeof env.MODELPORT_HOME === 'string' ? env.MODELPORT_HOME.trim() : ''
  return configured === '' ? path.join(home, '.modelport') : path.resolve(configured)
}

/** 内核自动释放的互斥端点，串行化同一数据目录的锁检查与回收。 */
async function acquireProcessGuard(dataDir) {
  // 其他平台保留原来的保守文件锁行为，不使用会遗留文件的 Unix Socket。
  if (process.platform !== 'win32' && process.platform !== 'linux') return null
  let canonical = fs.realpathSync.native(dataDir)
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  const id = crypto.createHash('sha256').update(canonical).digest('hex')
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\mp-service-lock-${id}` : `\0mp-service-lock-${id}`
  const server = net.createServer(socket => socket.destroy())
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(address, resolve)
    })
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      throw Object.assign(new Error('数据目录已被服务占用'), { code: 'EEXIST', cause: error })
    }
    throw error
  }
  server.unref()
  return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function acquireServiceLock(dataDir) {
  const releaseGuard = await acquireProcessGuard(dataDir)
  const lockFile = path.join(dataDir, 'service.lock')
  const token = crypto.randomUUID()
  let lock
  let ownedStat
  const removeOwnedLock = () => {
    try {
      const current = fs.lstatSync(lockFile)
      if (current.isFile() && current.dev === ownedStat.dev && current.ino === ownedStat.ino) {
        fs.unlinkSync(lockFile)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  try {
    try { lock = fs.openSync(lockFile, 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST' || !releaseGuard) throw error
      const previousStat = fs.lstatSync(lockFile)
      if (!previousStat.isFile()) throw error
      const previous = fs.readFileSync(lockFile, 'utf8')
      let owner
      try { owner = JSON.parse(previous) } catch { throw error }
      if (owner?.product !== PRODUCT || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw error
      // 只有 ESRCH 能证明进程已经退出；无权限、PID 复用等情况均保留原锁。
      let exited = false
      try { process.kill(owner.pid, 0) }
      catch (probeError) { exited = probeError.code === 'ESRCH' }
      if (!exited) throw error
      const current = fs.lstatSync(lockFile)
      if (current.dev !== previousStat.dev || current.ino !== previousStat.ino ||
          fs.readFileSync(lockFile, 'utf8') !== previous) throw error
      fs.unlinkSync(lockFile)
      lock = fs.openSync(lockFile, 'wx', 0o600)
    }
    ownedStat = fs.fstatSync(lock)
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, product: PRODUCT, token }))
  } catch (error) {
    try {
      if (lock !== undefined) {
        fs.closeSync(lock)
        if (ownedStat) removeOwnedLock()
      }
    } finally { await releaseGuard?.() }
    throw error
  }
  return async () => {
    try {
      // 在关闭文件句柄前核对归属，避免异常替换的锁被本实例清理。
      const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      if (current?.token === token && current.pid === process.pid && current.product === PRODUCT) removeOwnedLock()
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    } finally {
      try { fs.closeSync(lock) } finally { await releaseGuard?.() }
    }
  }
}

/** 直接创建核心和 HTTP 服务，不加载任何插件入口或宿主凭据。 */
export async function startService({
  dataDir = resolveDataDir(), host = '127.0.0.1', port,
  logger = console, refresh = true, lanEnabled, lanPort,
  startRelay = startLanRelay,
  /**
   * 渠道运行时的工厂。生产环境只有一个实现；测试注入替身，这样服务端与生命周期
   * 的覆盖（绑定、锁、密钥围栏、中继、**流式转发**）不必依赖某个真实渠道能登录。
   */
  createChannels = createChannelRuntime,
} = {}) {
  if (!isLoopbackHost(host)) throw new TypeError('the service binds a loopback address only')
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be an absolute path')
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new TypeError('port must be an integer between 0 and 65535')
  }
  if (lanEnabled !== undefined && typeof lanEnabled !== 'boolean') throw new TypeError('lanEnabled must be a boolean')
  if (lanPort !== undefined && (!Number.isInteger(lanPort) || lanPort < 0 || lanPort > 65535)) {
    throw new TypeError('lanPort must be an integer between 0 and 65535')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const releaseLock = await acquireServiceLock(dataDir)
  let stores
  let runtime
  let listener
  let management
  let channels
  let timer
  let refreshInFlight
  let closing
  let stopped = false
  let relay
  let relayTarget
  let relayRequestedPort
  let relayError = null
  let relayChanges = Promise.resolve()
  const lanState = () => {
    const value = stores.settings.get()
    const addresses = rankLanAddresses(os.networkInterfaces())
    return {
      enabled: value.lanEnabled === true,
      running: relay !== undefined,
      host: relay?.host ?? '0.0.0.0',
      requestedPort: value.lanPort ?? 0,
      port: relay?.port ?? null,
      addresses,
      baseUrls: relay ? addresses.map(address => `http://${address}:${relay.port}/v1`) : [],
      error: relayError,
    }
  }
  async function closeRelay() {
    const current = relay
    const target = relayTarget
    relay = undefined
    relayTarget = undefined
    relayRequestedPort = undefined
    await Promise.all([current?.close(), target?.close()])
  }
  function reconcileRelay() {
    relayChanges = relayChanges.then(async () => {
      const value = stores.settings.get()
      const wantedPort = value.lanPort ?? 0
      relayError = null
      if (stopped || value.enabled === false || value.lanEnabled !== true) {
        await closeRelay()
        return
      }
      if (relay && relayRequestedPort === wantedPort) return
      await closeRelay()
      try {
        if (typeof value.lanKey !== 'string' || value.lanKey === '' ||
            value.lanKey === value.forwardKey) {
          settingsPersist({ lanKey: generateKey() })
        }
        // The shared relay targets IPv4 loopback. An IPv6 management bind needs
        // a separate inference-only loopback target, with no management handler.
        if (listener.server.address().address !== '127.0.0.1') {
          relayTarget = await startForwardServer({
            config: () => ({
              host: '127.0.0.1', port: 0,
              enabled: !stopped && stores.settings.get().enabled !== false,
              key: stores.settings.get().forwardKey,
            }),
            complete: runtime.complete, modelRows: runtime.publicModelRows,
          })
        }
        const targetPort = relayTarget?.port ?? listener.port
        const started = await startRelay({
          config: () => ({
            enabled: !stopped && stores.settings.get().enabled !== false && stores.settings.get().lanEnabled === true,
            host: '0.0.0.0', port: wantedPort, targetPort,
            lanKey: stores.settings.get().lanKey,
            localKey: stores.settings.get().forwardKey,
          }),
          log: message => logger.warn?.(`modelport LAN: ${message}`),
        })
        relay = started
        relayRequestedPort = wantedPort
        if (stopped || stores.settings.get().enabled === false || stores.settings.get().lanEnabled !== true) await closeRelay()
      } catch (error) {
        await closeRelay()
        relayError = `LAN relay could not start (${/^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'START_FAILED'})`
        logger.warn?.(relayError)
      }
    })
    return relayChanges
  }
  function settingsPersist(patch) {
    const previous = stores.settings.get()
    stores.settings.update(patch)
    stores.settings.flush()
    if (stores.settings.writeFailed) {
      stores.settings.value = previous
      throw new Error('could not persist the LAN settings')
    }
  }
  try {
    stores = createRuntimeStores({ dataDir, logger })
    const { settings } = stores
    const savedPort = settings.get().port
    const requestedPort = port ?? (Number.isInteger(savedPort) && savedPort >= 0 && savedPort <= 65535 ? savedPort : 18900)
    const existingKey = settings.get().forwardKey
    const key = typeof existingKey === 'string' && existingKey !== '' ? existingKey : generateKey()
    const savedLanPort = settings.get().lanPort
    settings.update({
      forwardKey: key,
      lanEnabled: lanEnabled ?? settings.get().lanEnabled === true,
      lanPort: lanPort ?? (Number.isInteger(savedLanPort) && savedLanPort >= 0 && savedLanPort <= 65535 ? savedLanPort : 0),
    })
    settings.flush()
    if (settings.writeFailed) throw new Error('could not persist the API key')
    // 账号渠道跑在独立 Worker 里：它自带模块级单例与账号状态，和主运行时同进程
    // 会串目录、串账号。它先于运行时创建，因为运行时要把它的目录合进模型清单。
    channels = await createChannels({ dataDir, logger, stats: stores.stats })
    runtime = createModelRuntime({ ...stores, channels, logger })
    management = createManagement({
      stores, runtime, channels,
      // 反代部署：nginx 把 Host 改写成回环后，用 X-Forwarded-Host/Proto 判同源。
      // 默认关闭；只在确实由可信反代暴露时开启（见 README 的服务器部署一节）。
      trustProxy: process.env.MODELPORT_TRUST_PROXY === '1',
      info: () => ({
        product: PRODUCT, version: VERSION, dataDir,
        baseUrl: `http://${host === '::1' ? '[::1]' : host}:${listener?.port ?? requestedPort}`,
        automaticRefresh: refresh,
        networkMode: process.env.MODELPORT_TEST_UPSTREAM ? 'fixture' : 'live',
        capabilities: { accountChannels: true, combos: true, webUi: true, lan: true },
        lan: lanState(),
      }),
      onSettingsChanged: async () => {
        if (!refreshInFlight) scheduleRefresh()
        await reconcileRelay()
      },
    })
    listener = await startForwardServer({
      config: () => ({ host, port: requestedPort, enabled: settings.get().enabled !== false, key: settings.get().forwardKey }),
      complete: runtime.complete,
      modelRows: runtime.publicModelRows,
      health: () => ({
        ok: true, service: PRODUCT, product: 'gateway', version: VERSION,
        capabilities: { accountChannels: true, combos: true, webUi: true },
      }),
      handleRequest: management.handleRequest,
      log: message => logger.warn?.(`modelport: ${message}`),
    })
    management.setPort(listener.port)
    settings.update({ port: listener.port })
    settings.flush()
    await reconcileRelay()

    function scheduleRefresh() {
      clearTimeout(timer)
      if (stopped || !refresh) return
      const minutes = Number(settings.get().probeIntervalMinutes)
      timer = setTimeout(() => { void refreshModels() }, (Number.isFinite(minutes) && minutes > 0 ? Math.max(1, minutes) : 15) * 60_000)
      timer.unref?.()
    }
    function refreshModels(force = false) {
      if (refreshInFlight) return refreshInFlight
      refreshInFlight = runtime.refreshCatalog({ force })
        .catch(error => {
          if (!stopped) logger.warn?.(`modelport: catalog refresh failed (${error?.message ?? error})`)
        })
        .finally(() => { refreshInFlight = undefined; scheduleRefresh() })
      return refreshInFlight
    }
    // 启动可强制探测；后续周期刷新遵守核心的限流退避。
    const ready = refresh ? refreshModels() : Promise.resolve()
    return {
      product: PRODUCT, version: VERSION, dataDir,
      url: `http://${host === '::1' ? '[::1]' : host}:${listener.port}`,
      apiBase: `http://${host === '::1' ? '[::1]' : host}:${listener.port}/v1`,
      managementUrl: `http://${host === '::1' ? '[::1]' : host}:${listener.port}/${management.bootstrapFragment}`,
      port: listener.port,
      keyFile: path.join(dataDir, 'settings.json'),
      runtime, ready,
      get lan() { return lanState() },
      close() {
        if (closing !== undefined) return closing
        stopped = true
        clearTimeout(timer)
        management.dispose()
        runtime.dispose()
        closing = (async () => {
          try {
            await relayChanges
            await Promise.all([closeRelay(), listener.close(), channels.close()])
          } finally {
            try { stores.dispose() } finally { await releaseLock() }
          }
        })()
        return closing
      },
    }
  } catch (error) {
    stopped = true
    clearTimeout(timer)
    management?.dispose()
    runtime?.dispose()
    await relayChanges
    await closeRelay()
    if (listener) await listener.close()
    await channels?.close()
    try { stores?.dispose() } finally { await releaseLock() }
    throw error
  }
}
