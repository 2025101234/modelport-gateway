/**
 * 降级链的执行：把一条链路走完，直到某一环真正产出答复。
 *
 * 这条规则是全部设计的关键，所以它被原样从旧的适配器里搬过来，只是换了个
 * 执行对象——现在是渠道，而不是免费车道：
 *
 * 链路的每一环都被整段缓冲，直到出现「承载答复」的分块才提交。在此之前失败
 * 的一环会被**整段丢弃**：调用方一个字节都没看到，换模型这件事因此不可见。
 * 思考增量刻意不算提交——「想了一分钟才撞上配额墙」正是最值得降级的情形，
 * 被丢掉的思考随那一环一起丢弃。
 *
 * 一旦答复增量交了出去，它就属于调用方了；此后再失败就按普通失败处理，不再
 * 换环——否则两个模型的正文会被接在一起给用户看。
 *
 * @module src/core/combo
 */

import { comboChain } from '../combos.js'
import { classifyFailure, describeVerdict, shouldAdvance } from '../route/classify.js'

/**
 * 这个分块是否承载了「调用方一旦看到就得作数」的答复？
 *
 * 文本与工具调用算；推理不算。
 *
 * @param {object} chunk - 归一化后的流分块
 * @returns {boolean}
 */
export function commitsAnswer(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== ''
  if (chunk.type === 'tool-call-delta') return true
  if (chunk.type !== 'block-end') return false
  if (chunk.block?.type === 'reasoning') return false
  if (chunk.block?.type === 'text') return typeof chunk.block.text === 'string' && chunk.block.text.trim() !== ''
  return true
}

/**
 * 一个错误/结束原因是否值得换下一环。
 *
 * @param {unknown} error
 * @param {string} [fallbackCode]
 * @returns {{verdict: object, advance: boolean}}
 */
function verdictFor(error, fallbackCode) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode
    : Number.isInteger(error?.status) ? error.status : undefined
  const verdict = classifyFailure({ status, code: fallbackCode, message: String(error?.message ?? error ?? '') })
  return { verdict, advance: shouldAdvance(verdict) }
}

/**
 * 走完一条链路，返回最终结果。
 *
 * 与网关的契约是「要么返回折叠好的 outcome，要么抛出错误」——和单模型调用一致，
 * 这样调用方不需要知道它用的其实是一条链。
 *
 * @param {object} options
 * @param {object} options.channels - 渠道运行时
 * @param {object} options.entry - 链路的目录行（带 `combo`）
 * @param {Array<object>} options.catalog - 当前全部目录行
 * @param {object} options.request - 转发形状的请求（`model` 会被逐环替换）
 * @param {(chunk: object) => void} options.onChunk - 交出去的分块
 * @param {{warn?: (message: string) => void}} [options.logger]
 * @returns {Promise<object>} 折叠好的 outcome
 */
export async function completeCombo({ channels, entry, catalog, request, onChunk, logger }) {
  const candidates = comboChain(entry, catalog)
  if (candidates.length === 0) {
    throw Object.assign(
      new Error(`the chain "${entry.name}" has no model available right now`),
      { statusCode: 503 })
  }

  const tried = []
  for (const candidate of candidates) {
    const held = []
    let committed = false
    const forward = chunk => {
      if (committed) { onChunk(chunk); return }
      held.push(chunk)
      if (!commitsAnswer(chunk)) return
      committed = true
      for (const row of held) onChunk(row)
      held.length = 0
    }

    let outcome
    try {
      outcome = await channels.complete({ ...request, model: candidate.id }, forward)
    } catch (error) {
      if (committed) {
        // The answer was already the caller's; hand over what is left and stop.
        for (const row of held) onChunk(row)
        throw error
      }
      const { verdict, advance } = verdictFor(error)
      const reason = describeVerdict(verdict)
      if (!advance) {
        for (const row of held) onChunk(row)
        throw error
      }
      tried.push(`${candidate.id} (${reason})`)
      logger?.warn?.(`modelport: chain "${entry.name}" advanced past ${candidate.id} — ${reason}`)
      continue
    }

    // A turn that finished on an error frame, with nothing committed yet, is
    // still a candidate fault: the next link gets its chance.
    if (outcome?.error !== undefined && !committed) {
      const { verdict, advance } = verdictFor({ message: outcome.error, statusCode: outcome.failure?.status }, outcome.failure?.code)
      const reason = describeVerdict(verdict)
      if (!advance) {
        for (const row of held) onChunk(row)
        throw Object.assign(new Error(outcome.error), { statusCode: outcome.failure?.status ?? 502 })
      }
      tried.push(`${candidate.id} (${reason})`)
      logger?.warn?.(`modelport: chain "${entry.name}" advanced past ${candidate.id} — ${reason}`)
      continue
    }

    // Success — or a turn that produced only reasoning. Either way what is held
    // belongs to the caller now.
    for (const row of held) onChunk(row)
    return outcome
  }

  throw Object.assign(
    new Error(`the chain "${entry.name}" exhausted every candidate: ${tried.join('; ')}`),
    { statusCode: 502 })
}