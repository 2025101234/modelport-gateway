/**
 * 模型运行时：把渠道目录与降级链合成一份清单，并把一个回合派给正确的地方。
 *
 * 这里只认两类模型来源：
 *
 * - **渠道**（13 家账号渠道）——由 `app/channels` 的 Worker 提供，它自己负责登录、
 *   凭据、上游请求与用量记录。本模块只做派发。
 * - **降级链**——虚拟模型 `combo:<名称>`，把若干渠道模型串成一条链，前一环失败就
 *   换下一环。走法见 `src/core/combo.js`。
 *
 * 早先版本还有匿名免费车道、Kilo 免费池与自带 Key 的聚合车道；三者都已移除，
 * 连带去掉了可用性探测（渠道的可达性由「这次目录刷新有没有列出它」本身表达）。
 *
 * @module src/core/runtime.js
 */

import path from 'node:path'
import { buildComboCatalog, isComboEntry, normalizeCombos, pruneRotation } from '../combos.js'
import {
  JsonStore, SETTINGS_INITIAL, STATS_INITIAL, STATS_VERSION,
  migrateStats, pruneDays, recordTurn, isModelHidden,
} from '../store.js'
import { completeCombo } from './combo.js'

/** 渠道运行时的行本身就是 OpenAI 模型形状；这里只补目录需要的字段。 */
function entriesFor(rows) {
  return rows.map(row => ({
    id: row.id,
    name: row.name ?? row.id,
    channel: row.channel ?? row.owned_by ?? 'channel',
    contextWindow: row.context_window,
    maxOutput: row.max_tokens,
    vision: row.vision === true || (Array.isArray(row.input) && row.input.includes('image')),
    reasoning: row.reasoning !== false,
  }))
}

/** 路径由产品入口决定；核心不解析宿主目录，也不发现宿主服务。 */
export function createRuntimeStores({ dataDir, logger = console }) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new TypeError('dataDir must be an absolute path')
  }
  // 两份初始值都必须克隆：`STATS_INITIAL.days` 是嵌套对象，直接交给两个实例会
  // 让它们共享同一个 `days`，于是一个实例的用量会长进另一个实例的统计里。
  const settings = new JsonStore(path.join(dataDir, 'settings.json'), structuredClone(SETTINGS_INITIAL), {
    log: message => logger.warn?.(message),
  })
  const stats = new JsonStore(path.join(dataDir, 'stats.json'), structuredClone(STATS_INITIAL), {
    log: message => logger.warn?.(message),
  })
  if (stats.get().version !== STATS_VERSION) stats.edit(migrateStats)
  return {
    settings, stats,
    dispose() { settings.dispose(); stats.dispose() },
  }
}

/**
 * 创建一个模型运行时。创建本身不发起任何网络请求。
 *
 * @param {object} options
 * @param {object} options.settings - settings 存储
 * @param {object} options.stats - stats 存储
 * @param {object} options.channels - 渠道运行时（`app/channels/runtime.mjs`）
 * @param {object} [options.logger]
 * @param {() => void} [options.onTopology] - 清单变化后的通知（用于推动控制台）
 */
export function createModelRuntime({ settings, stats, channels, logger = console, onTopology = () => {} }) {
  let disposed = false
  let catalog = []
  let comboRows = []
  const lifetime = new AbortController()

  const rebuild = () => {
    const combos = normalizeCombos(settings.get().combos)
    const entries = entriesFor(channels.publicModelRows())
    comboRows = buildComboCatalog(combos, entries)
    pruneRotation(combos)
    catalog = [...entries, ...comboRows]
  }
  rebuild()

  const notify = () => { if (!disposed) onTopology() }

  /** 当前生效的设置；被隐藏的模型不参与派发。 */
  const visible = () => {
    const value = settings.get()
    return {
      settings: value,
      rows: channels.publicModelRows().filter(row => !isModelHidden({ id: row.id, channel: row.channel ?? row.owned_by }, value)),
    }
  }

  /**
   * 跑一个回合。
   *
   * `onChunk` 是可选的：非流式的 Responses 路径只读返回值里的折叠结果，不订阅
   * 分块。所以这里必须容忍它缺席，而不是把 undefined 一路传到渠道那里。
   */
  async function complete(request, onChunk = () => {}) {
    if (disposed || lifetime.signal.aborted) {
      throw Object.assign(new Error('the model runtime is stopped'), { statusCode: 503 })
    }
    if (settings.get().enabled === false) {
      throw Object.assign(new Error('the gateway is switched off in its settings page'), { statusCode: 503 })
    }
    // 清单会在两次回合之间变化（渠道刚登录、链路刚编辑），所以每次派发都按当前
    // 的清单解析，而不是沿用创建时的那一份。
    rebuild()
    const entry = catalog.find(row => row.id === request.model)
    if (entry === undefined) {
      throw Object.assign(new Error(`model "${request.model}" not found`), { statusCode: 404 })
    }
    const signal = request.signal === undefined
      ? lifetime.signal
      : AbortSignal.any([request.signal, lifetime.signal])
    if (isComboEntry(entry)) {
      return completeCombo({ channels, entry, catalog, request: { ...request, signal }, onChunk, logger })
    }
    return channels.complete({ ...request, signal }, onChunk)
  }

  /**
   * 清单刷新：渠道目录是唯一会变的部分。
   *
   * `probe` 参数保留在签名里只为兼容调用方——已经没有任何车道需要「探测」，
   * 渠道的一次目录刷新成功本身就说明它可达。
   */
  async function refreshCatalog() {
    if (disposed) return catalog
    await channels.refresh()
    rebuild()
    settings.update({ catalogSyncedAt: Date.now() })
    notify()
    return catalog
  }

  /** 收到一条链路编辑后重建清单，不必等下一轮目录刷新。 */
  function syncCombos() {
    if (disposed) return catalog
    rebuild()
    notify()
    return catalog
  }

  /**
   * 用一次真实的最小回合检验某个模型是否可用。
   *
   * 这会真的花掉该渠道一次调用——控制台上的「测试」按钮正是这个语义。
   */
  async function testModel(model, _effort, { signal } = {}) {
    const started = Date.now()
    let firstDeltaAt
    let text = ''
    const outcome = await complete({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      maxTokens: 32,
      signal,
    }, chunk => {
      if (firstDeltaAt === undefined) firstDeltaAt = Date.now()
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    })
    if (outcome?.error !== undefined) {
      throw Object.assign(new Error(String(outcome.error)), { statusCode: outcome.failure?.status ?? 502 })
    }
    return {
      model,
      ok: true,
      text: text.trim(),
      latencyMs: Date.now() - started,
      ttftMs: firstDeltaAt === undefined ? undefined : firstDeltaAt - started,
    }
  }

  /** `/v1/models` 的答复：渠道行原样透出，链路行补上 OpenAI 外壳。 */
  function publicModelRows() {
    const { settings: value, rows } = visible()
    const combos = comboRows
      .filter(row => !isModelHidden(row, value))
      .map(row => ({
        id: row.id,
        object: 'model',
        created: 0,
        owned_by: 'combo',
        name: row.name,
        ...row.contextWindow === undefined ? {} : { context_window: row.contextWindow },
        ...row.maxOutput === undefined ? {} : { max_tokens: row.maxOutput },
        ...row.vision === true ? { input: ['text', 'image'] } : {},
      }))
    return [...rows, ...combos]
  }

  return {
    complete,
    refreshCatalog,
    syncCombos,
    testModel,
    publicModelRows,
    /** 控制台读的那一份：目录行 + 当前设置。 */
    state: () => ({ catalog, settings: settings.get() }),
    get catalog() { return catalog },
    get stats() { return stats },
    dispose() {
      if (disposed) return
      disposed = true
      lifetime.abort()
    },
  }
}

/** 记录一次物理渠道调用（渠道运行时已经记过用量，这里只补回合计数）。 */
export function noteTurn(stats, record) {
  recordTurn(stats, record)
}

/** 把统计里的日线裁到窗口内。 */
export function pruneStats(stats) {
  stats.edit(value => pruneDays(value, 120))
}