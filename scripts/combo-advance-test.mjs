/**
 * 降级链的提交规则与换环判定。
 *
 *     node scripts/combo-advance-test.mjs
 *
 * 这里驱动的是真正跑在服务里的那条路径：`src/core/combo.js` 的 `completeCombo`，
 * 只是把「渠道」换成一个按脚本吐分块的替身——所以不访问外网、不花任何渠道额度。
 *
 * 被验证的语义就是这个功能的全部契约，它曾经横跨两个文件（`commitsAnswer` 与
 * `advanceVerdict`），现在同住在 `src/core/combo.js` 里，两边必须对「答复」有
 * 同一个定义：可见正文或流式工具调用算，**思考不算**。
 *
 * - 先思考、再撞上配额墙 → 换下一环，且被丢弃那一环的思考调用方一个字都看不到；
 * - 只推理、正常结束 → 同样不算提交；
 * - 已经吐出可见正文 → 提交，此后再失败就结束回合，绝不换环；
 * - 还没输出就失败 → 换下一环。
 */
import assert from 'node:assert/strict'

const { completeCombo, commitsAnswer } = await import('../src/core/combo.js')
const { buildComboCatalog, normalizeCombos } = await import('../src/combos.js')
const { foldForwardOutcome } = await import('../src/core/completion.js')

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`) }
  catch (error) { failures += 1; console.log(`FAIL ${name} — ${error.message}`) }
}

/** 受脚本控制的渠道替身，并记录每一环是否被真的调用过。 */
function harness(scripts) {
  const called = []
  return {
    called,
    channels: {
      handles: model => Object.hasOwn(scripts, model),
      async complete(request, onChunk) {
        called.push(request.model)
        const script = scripts[request.model]
        if (script === undefined) {
          throw Object.assign(new Error(`no script for ${request.model}`), { statusCode: 404 })
        }
        const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
        for (const chunk of script.chunks ?? []) {
          foldForwardOutcome(outcome, chunk)
          onChunk(chunk)
        }
        if (script.throw !== undefined) throw script.throw
        return outcome
      },
    },
  }
}

/** 一条链，以及它引用的那些渠道行。 */
function chain(...models) {
  const combos = normalizeCombos([{ id: 'combo:test', name: '测试链', models, strategy: 'fallback', enabled: true }])
  const base = models.map(id => ({
    id, name: id, channel: id.split('/')[0], contextWindow: 128000, maxOutput: 8192, reasoning: true,
  }))
  const catalog = [...base, ...buildComboCatalog(combos, base)]
  return { catalog, entry: catalog.find(row => row.id === 'combo:test') }
}

const text = value => ({ type: 'text-delta', text: value })
const think = value => ({ type: 'reasoning-delta', text: value })
const thinkEnd = () => ({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thought' } })
const toolCall = () => ({ type: 'tool-call-delta', index: 1, id: 'call_1', name: 'read', argumentsDelta: '{}' })
const wall = () => ({ type: 'finish', reason: { kind: 'error', failure: { message: 'quota reached', status: 429 } } })
const done = () => ({ type: 'finish', reason: { kind: 'stop' } })

const run = async (scripts, options = {}) => {
  const { catalog, entry } = chain(...Object.keys(scripts))
  const { channels, called } = harness(scripts)
  const emitted = []
  let outcome
  let error
  try {
    outcome = await completeCombo({
      channels, entry, catalog, onChunk: chunk => emitted.push(chunk),
      request: { model: entry.id }, logger: { warn: () => {} }, ...options,
    })
  } catch (reason) { error = reason }
  return { called, emitted, outcome, error }
}

const saidSoFar = result => result.emitted.map(chunk => chunk.text ?? '').join('')

// ── 提交规则的判定本身 ──────────────────────────────────────────────────────
await check('a text delta commits only when it carries something', () => {
  assert.equal(commitsAnswer(text('')), false)
  assert.equal(commitsAnswer(text('   ')), false)
  assert.equal(commitsAnswer(text('好')), true)
})

await check('reasoning never commits, not even as a finished block', () => {
  assert.equal(commitsAnswer(think('想了很久')), false)
  assert.equal(commitsAnswer(thinkEnd()), false)
})

await check('a tool call commits', () => {
  assert.equal(commitsAnswer(toolCall()), true)
})

// ── 换环：想完才撞墙 ────────────────────────────────────────────────────────
await check('thinking then an in-stream quota wall advances to the next link', async () => {
  const result = await run({
    'a/1': { chunks: [think('先想一分钟'), thinkEnd(), wall()] },
    'b/2': { chunks: [text('答复来自 b'), done()] },
  })
  assert.deepEqual(result.called, ['a/1', 'b/2'])
  assert.equal(result.emitted.some(chunk => chunk.type === 'reasoning-delta'), false,
    'the discarded link\'s thinking leaked to the caller')
  assert.equal(saidSoFar(result), '答复来自 b')
  assert.equal(result.outcome.error, undefined)
})

await check('reasoning that ends cleanly is not a fault: the turn ends, the chain does not move', async () => {
  // Advancing is a *failure* policy. A link that answered with nothing but
  // thinking and then stopped did not fail — it stopped. The held thinking is
  // handed over and the chain stays where it is; inventing a second call here
  // would spend another link on a model that simply had nothing to say.
  const result = await run({
    'a/1': { chunks: [think('只想了'), thinkEnd(), done()] },
    'b/2': { chunks: [text('不该出现'), done()] },
  })
  assert.deepEqual(result.called, ['a/1'])
  assert.equal(result.emitted.some(chunk => chunk.type === 'reasoning-delta'), true,
    'the only output there was must still reach the caller')
  assert.equal(result.outcome.error, undefined)
})

await check('a refusal with no output at all advances', async () => {
  const result = await run({
    'a/1': { chunks: [wall()] },
    'b/2': { chunks: [text('b 接手'), done()] },
  })
  assert.deepEqual(result.called, ['a/1', 'b/2'])
  assert.equal(saidSoFar(result), 'b 接手')
})

await check('a thrown error before any output advances too', async () => {
  const result = await run({
    'a/1': { chunks: [], throw: Object.assign(new Error('upstream 503'), { statusCode: 503 }) },
    'b/2': { chunks: [text('b 接手'), done()] },
  })
  assert.deepEqual(result.called, ['a/1', 'b/2'])
  assert.equal(result.outcome.error, undefined)
  assert.equal(saidSoFar(result), 'b 接手')
})

await check('a per-link refusal advances, because the next link is a different channel', async () => {
  // This is deliberate, not an oversight: a 401 here usually means *this*
  // account's credential went stale. The next link is another channel with its
  // own login, so refusing to try it would throw away the chain's whole value.
  const result = await run({
    'a/1': { chunks: [], throw: Object.assign(new Error('invalid credential'), { statusCode: 401 }) },
    'b/2': { chunks: [text('b 接手'), done()] },
  })
  assert.deepEqual(result.called, ['a/1', 'b/2'])
  assert.equal(saidSoFar(result), 'b 接手')
})

await check('a caller abort is not a link fault and must not be retried elsewhere', async () => {
  const result = await run({
    'a/1': { chunks: [], throw: Object.assign(new Error('request aborted'), { statusCode: 499, code: 'ABORTED' }) },
    'b/2': { chunks: [text('不该出现'), done()] },
  })
  assert.deepEqual(result.called, ['a/1'], 'walking away must not spend another link')
  assert.match(String(result.error?.message), /aborted/)
})

// ── 不换环：正文已经交出去 ──────────────────────────────────────────────────
await check('visible text commits the chain: a later failure ends the turn', async () => {
  const result = await run({
    'a/1': { chunks: [text('已经说了'), wall()] },
    'b/2': { chunks: [text('不该出现'), done()] },
  })
  assert.deepEqual(result.called, ['a/1'], 'the chain advanced after committing an answer')
  assert.equal(saidSoFar(result), '已经说了')
  assert.equal(result.outcome.error, 'quota reached')
})

await check('a tool call commits even when the link then fails', async () => {
  const result = await run({
    'a/1': { chunks: [toolCall(), wall()] },
    'b/2': { chunks: [text('不该出现'), done()] },
  })
  assert.deepEqual(result.called, ['a/1'])
  assert.equal(result.emitted.some(chunk => chunk.type === 'tool-call-delta'), true)
})

await check('a thrown error after committing does not advance', async () => {
  const result = await run({
    'a/1': { chunks: [text('已经说了')], throw: new Error('stream cut') },
    'b/2': { chunks: [text('不该出现'), done()] },
  })
  assert.deepEqual(result.called, ['a/1'])
  assert.equal(saidSoFar(result), '已经说了')
  assert.match(String(result.error?.message), /stream cut/)
})

// ── 走完所有环 ──────────────────────────────────────────────────────────────
await check('exhausting every link names the chain and what was tried', async () => {
  const result = await run({
    'a/1': { chunks: [wall()] },
    'b/2': { chunks: [wall()] },
  })
  assert.deepEqual(result.called, ['a/1', 'b/2'])
  assert.match(String(result.error?.message), /测试链/)
  assert.match(String(result.error?.message), /a\/1/)
  assert.match(String(result.error?.message), /b\/2/)
  assert.equal(result.error.statusCode, 502)
})

await check('a chain with nothing resolvable says so instead of guessing', async () => {
  const entry = { id: 'combo:empty', name: '空链', channel: 'combo', combo: ['x/1'], strategy: 'fallback' }
  await assert.rejects(
    () => completeCombo({
      channels: harness({}).channels, entry, catalog: [entry],
      request: { model: entry.id }, onChunk: () => {},
    }),
    /空链/)
})

// ── 目录行：链路的身份与能力 ────────────────────────────────────────────────
await check('a chain keeps a non-Latin name through a JSON round trip', () => {
  const combos = normalizeCombos(JSON.parse(JSON.stringify([
    { id: 'combo:中文', name: '推荐组', models: ['a/1', 'b/2'], strategy: 'fallback', enabled: true },
  ])))
  assert.equal(combos[0].name, '推荐组')
  assert.equal(combos[0].id, 'combo:中文')
})

await check('mixed Unicode chain names keep distinct identities after reload', () => {
  const combos = normalizeCombos([
    { id: 'combo:a', name: '推荐组', models: ['x/1'], strategy: 'fallback', enabled: true },
    { id: 'combo:b', name: '推荐组·备', models: ['y/2'], strategy: 'fallback', enabled: true },
  ])
  assert.notEqual(combos[0].id, combos[1].id)
  assert.notEqual(combos[0].name, combos[1].name)
})

await check('a chain advertises the capability intersection of its members', () => {
  const base = [
    { id: 'a/1', name: 'a', channel: 'a', vision: true, reasoning: true, contextWindow: 200000, maxOutput: 8192 },
    { id: 'b/2', name: 'b', channel: 'b', vision: false, reasoning: true, contextWindow: 128000, maxOutput: 4096 },
  ]
  const rows = buildComboCatalog(
    normalizeCombos([{ id: 'combo:mix', name: '混合', models: ['a/1', 'b/2'], strategy: 'fallback', enabled: true }]), base)
  const row = rows.find(candidate => candidate.id === 'combo:mix')
  assert.equal(row.vision, false, 'a chain must not promise vision if a link lacks it')
  assert.equal(row.contextWindow, 128000, 'the chain is bounded by its narrowest link')
  assert.equal(row.maxOutput, 4096)
})

console.log(`\ncombo-advance: ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exitCode = failures === 0 ? 0 : 1