/**
 * 集成测试用的渠道运行时替身。
 *
 * 服务的集成套件要覆盖的是**服务端本身**：绑定与退避、单实例锁、密钥围栏、
 * 局域网中继、以及流式转发会不会被缓冲。这些都不该依赖某个真实渠道能登录成功，
 * 所以这里提供一个符合渠道运行时契约的替身，由 `startService({ createChannels })`
 * 注入。
 *
 * 它只做三件事：报出几个模型、按脚本流式吐字、以及在一个模型上模拟失败。
 * 不碰网络、不写凭据。
 *
 * @module scripts/lib/fake-channels
 */

// The real channel runtime folds its stream through `foldForwardOutcome`, which
// converts usage to the OpenAI spelling on the way out, and records the call in
// the stats store. The double goes through the same two paths so it cannot drift
// from the contract it stands in for.
import { toOpenAiUsage } from '../../src/forward.js'
import { recordTurn, recordUsage } from '../../src/store.js'

/** 模型清单：两个正常模型 + 一个必定失败的模型。 */
const MODELS = [
  { id: 'fakechan/basic', name: 'Basic', contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoning: false },
  { id: 'fakechan/vision', name: 'Vision', contextWindow: 200000, maxTokens: 8192, input: ['text', 'image'], reasoning: true },
  { id: 'fakechan/broken', name: 'Broken', contextWindow: 8000, maxTokens: 1024, input: ['text'], reasoning: false },
]

const rowOf = model => ({
  id: model.id,
  object: 'model',
  created: 0,
  owned_by: model.provider ?? 'fakechan',
  name: model.name,
  channel: model.provider ?? 'fakechan',
  vision: model.input.includes('image'),
  reasoning: model.reasoning,
  context_window: model.contextWindow,
  max_tokens: model.maxTokens,
  input: model.input,
})

/**
 * 创建一个替身渠道运行时。
 *
 * @param {object} [options]
 * @param {string} [options.reply] - 每个回合吐出的正文
 * @param {number} [options.chunkSize] - 每次 text-delta 的字符数。默认整段一次发出，
 *   这样原始 SSE 文本里能出现完整的标记字符串（调用方按文本断言时依赖这一点）；
 *   传 1 可以逐字验证增量转发。
 * @param {number} [options.chunkDelayMs] - 分块之间的间隔，用来验证「不缓冲」
 * @param {object[]} [options.models] - 覆盖默认模型清单
 * @param {() => Promise<void>} [options.gate] - 吐完正文后等待它，用来把一次流按住不放，
 *   以验证「网关不会先攒完整个答复再交给调用方」
 * @param {() => void} [options.onAbort] - 调用方中止时触发，用来验证中止真的传导了下来
 */
export function fakeChannelRuntime({ reply = '来自渠道替身的答复', chunkDelayMs = 0, chunkSize, models = MODELS, gate, onAbort, stats } = {}) {
  const rows = models.map(rowOf)
  const calls = []
  const aborts = []
  let closed = false
  // stats 是 startService 建好存储后才有的，所以可以由外部在这一刻交进来。
  let statsStore = stats

  /** 一个回合的真实逻辑：吐正文、必要时停在闸门、以 usage 与 finish 收尾。 */
  async function runTurn(request, onChunk) {
    const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
    const aborted = () => {
      aborts.push(request.model)
      onAbort?.()
      outcome.failure = { message: 'request aborted', code: 'ABORTED' }
      outcome.error = outcome.failure.message
      onChunk({ type: 'finish', reason: { kind: 'aborted', failure: outcome.failure } })
      return outcome
    }
    if (request.model === 'fakechan/broken') {
      outcome.failure = { message: 'the fake channel refused this turn', status: 502 }
      outcome.error = outcome.failure.message
      onChunk({ type: 'finish', reason: { kind: 'error', failure: outcome.failure } })
      return outcome
    }
    const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : Math.max(1, reply.length)
    const pieces = []
    for (let index = 0; index < reply.length; index += size) pieces.push(reply.slice(index, index + size))
    if (pieces.length === 0) pieces.push('')
    for (const piece of pieces) {
      if (request.signal?.aborted === true) return aborted()
      outcome.text += piece
      onChunk({ type: 'text-delta', text: piece })
      if (chunkDelayMs > 0) await new Promise(resolve => setTimeout(resolve, chunkDelayMs))
    }
    if (gate !== undefined) {
      // Hold the stream open. `gate` is read per turn, so a test can arm a
      // fresh barrier between turns and release it later.
      const barrier = gate()
      if (barrier !== undefined) {
        // An abort while parked here must still surface — that is exactly the
        // "cancelling really cancels" property under test.
        const parked = await Promise.race([
          barrier.then(() => 'released'),
          new Promise(resolve => {
            if (request.signal?.aborted === true) { resolve('aborted'); return }
            request.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
          }),
        ])
        if (parked === 'aborted' || request.signal?.aborted === true) return aborted()
      }
    }
    outcome.usage = toOpenAiUsage({ inputTokens: 12, outputTokens: reply.length })
    onChunk({ type: 'usage', usage: { inputTokens: 12, outputTokens: reply.length } })
    onChunk({ type: 'finish', reason: { kind: 'stop' } })
    return outcome
  }

  return {
    /** 测试可读：每一回合被调用的记录。 */
    calls,
    /** 测试可读：被中止的模型 id。 */
    aborts,
    /** 把 startService 建好的统计存储交进来，替身就会像真实渠道一样记账。 */
    attach(value) { statsStore = value } ,
    providers: ['fakechan'],
    state: () => (closed ? { state: 'closed' } : { state: 'ready' }),
    publicModelRows: () => rows,
    refresh: async () => rows,
    handles: model => models.some(entry => entry.id === model),
    rpc: async body => {
      if (body?.method === 'model.list') return { ok: true, value: { models: models.map(model => ({ id: model.id, name: model.name, disabled: false, dead: false })) } }
      if (body?.method === 'account.list') return { ok: true, value: { accounts: [] } }
      return { ok: false, error: { code: 'bad-request', message: `unknown method: ${body?.method}` } }
    },
    async complete(request, onChunk) {
      calls.push({ model: request.model, messages: request.messages })
      const started = Date.now()
      let firstDeltaAt
      const outcome = await runTurn(request, chunk => {
        if (firstDeltaAt === undefined && chunk.type === 'text-delta') firstDeltaAt = Date.now()
        onChunk(chunk)
      })
      // 真实的渠道运行时在这里记用量与回合；替身照做，否则「一次测试会写进统计」
      // 这类断言验证的就不是产品行为而是替身的行为。
      if (statsStore !== undefined) {
        const usage = outcome.usage
        recordUsage(statsStore, {
          model: request.model, at: Date.now(),
          input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0,
          reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
          cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? 0,
          ok: outcome.error === undefined, origin: 'forward',
          ttftMs: firstDeltaAt === undefined ? undefined : firstDeltaAt - started,
          decodeMs: firstDeltaAt === undefined ? 0 : Date.now() - firstDeltaAt,
          decodeTokens: usage?.completion_tokens ?? 0,
          noUsage: usage === undefined,
          elapsedMs: Date.now() - started,
          aborted: request.signal?.aborted === true,
        })
        recordTurn(statsStore, { model: request.model, ok: outcome.error === undefined, recovered: false })
      }
      return outcome
    },
    async close() { closed = true },
  }
}

export { MODELS as FAKE_CHANNEL_MODELS }
