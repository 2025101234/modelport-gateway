/**
 * 把渠道运行时交出来的分块折叠成一个回合的结果。
 *
 * 渠道 Worker 已经做了 wire 解析，所以这里拿到的是**归一化**分块
 * （`text-delta` / `tool-call-delta` / `usage` / `finish` …）。本模块只做归集，
 * 供用量记录与降级链的判定使用。
 *
 * @module src/core/completion.js
 */

import { toOpenAiUsage } from '../forward.js'
import { carryFailure } from '../failure.js'

/**
 * 把一个归一化分块折进 `outcome`。
 *
 * `outcome` 的形状是 `{text, toolCalls, usage, truncated, error, failure}`；
 * 它与 `app/channels/runtime.mjs` 用的是同一份结构，两处不会漂移。
 *
 * @param {object} outcome - 就地修改
 * @param {object} chunk
 * @returns {object} 同一个 outcome
 */
export function foldForwardOutcome(outcome, chunk) {
  switch (chunk.type) {
    case 'text-delta': outcome.text += chunk.text; break
    case 'tool-call-delta': {
      let call = outcome.toolCalls.find(candidate => candidate.slot === chunk.index)
      if (call === undefined) { call = { slot: chunk.index, id: chunk.id ?? '', name: chunk.name ?? '', arguments: chunk.argumentsDelta ?? '' }; outcome.toolCalls.push(call) }
      else call.arguments += chunk.argumentsDelta ?? ''
      if (chunk.name) call.name = chunk.name
      if (chunk.id) call.id = chunk.id
      break
    }
    case 'block-end':
      if (chunk.block?.type === 'tool-call') {
        // Match by slot first: the call's deltas were folded under this same
        // block index, and a relayed stream can carry its id late — matching
        // by id alone would miss the slot's entry and fold one call into two.
        // The block-end carries the assembled arguments, so a slot match
        // adopts them; an id match only fills identity fields.
        const bySlot = outcome.toolCalls.find(candidate => candidate.slot === chunk.index)
        if (bySlot !== undefined) {
          if (typeof chunk.block.id === 'string' && chunk.block.id !== '') bySlot.id = chunk.block.id
          if (typeof chunk.block.name === 'string' && chunk.block.name !== '') bySlot.name = chunk.block.name
          if (typeof chunk.block.arguments === 'string') bySlot.arguments = chunk.block.arguments
          break
        }
        const byId = outcome.toolCalls.find(candidate => typeof candidate.id === 'string' && candidate.id !== ''
          && candidate.id === chunk.block.id)
        if (byId === undefined) {
          outcome.toolCalls.push({
            slot: chunk.index,
            id: typeof chunk.block.id === 'string' ? chunk.block.id : '',
            name: typeof chunk.block.name === 'string' ? chunk.block.name : '',
            arguments: typeof chunk.block.arguments === 'string' ? chunk.block.arguments : '',
          })
        }
      }
      break
    case 'usage': outcome.usage = toOpenAiUsage(chunk.usage); break
    case 'finish':
      if (chunk.reason?.kind === 'max-tokens') outcome.truncated = true
      if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
        outcome.failure = carryFailure(chunk.reason.failure, chunk.reason.kind)
        outcome.error = outcome.failure.message
      }
      break
    default: break
  }
  return outcome
}