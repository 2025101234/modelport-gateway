/**
 * Run every offline suite in one command.
 *
 *     node scripts/test-all.mjs [--only <name>]
 *
 * These are the checks that need no network and spend no upstream quota: each
 * one drives the real module against a local stand-in. The live end-to-end run
 * against the real gateway is separate and costs quota, so it stays a
 * deliberate act rather than something CI does on every push.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = fileURLToPath(new URL('.', import.meta.url))
const options = { only: null }
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index]
  if (flag !== '--only' || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    console.error(`usage: node scripts/test-all.mjs [--only <name>] (invalid ${flag})`)
    process.exit(1)
  }
  options.only = process.argv[++index]
}
const { only } = options

/**
 * One row per suite. Order is deliberate: the cheap pure-module checks run
 * first so a broken codec or filter fails the run before anything that has to
 * boot a listener.
 */
const suites = [
  // Pure modules: wire codecs, the failure table, the chain's commit rule.
  ['projection', 'projection-test.mjs', []],
  ['anthropic', 'anthropic-test.mjs', []],
  ['route', 'route-test.mjs', []],
  ['combo-advance', 'combo-advance-test.mjs', []],
  // The savers and the local answers.
  ['rtk', 'rtk-test.mjs', []],
  ['rtk-shape', 'rtk-shape-test.mjs', []],
  ['prompt-saver', 'prompt-saver-test.mjs', []],
  ['local-optimize', 'local-optimize-test.mjs', []],
  // The service, its management API and the console build.
  ['workbuddy-desktop', 'workbuddy-desktop-test.mjs', []],
  ['channels', 'channels-test.mjs', []],
  ['session', 'session-test.mjs', []],
  ['standalone', 'standalone-test.mjs', []],
  ['standalone-management', 'standalone-management-test.mjs', []],
  ['standalone-lan', 'standalone-lan-test.mjs', []],
  ['standalone-frontend', 'standalone-frontend-test.mjs', []],
  ['standalone-page-lifecycle', 'standalone-page-lifecycle-test.mjs', []],
  ['standalone-settings-host', 'standalone-settings-host-test.mjs', []],
  ['standalone-model-operation', 'standalone-model-operation-test.mjs', []],
  ['standalone-login-terminal', 'standalone-login-terminal-test.mjs', []],
]

/** A suite that hangs is a failure, not a reason to wait forever. */
const SUITE_TIMEOUT_MS = 180_000

/**
 * Run a suite while forwarding its output as it arrives. Keeping the output
 * live is important here: a timeout kills the child before a buffered pipe can
 * be read, which would erase the last check the suite printed.
 */
function runSuite(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(scriptsDir, script), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let forceKillTimer
    let spawnError = null
    const started = Date.now()
    const forward = (stream, chunk) => {
      const text = chunk.toString()
      stream === 'stdout' ? stdout += text : stderr += text
      process[stream].write(text)
    }
    child.stdout.on('data', chunk => forward('stdout', chunk))
    child.stderr.on('data', chunk => forward('stderr', chunk))
    const deadline = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      timedOut = true
      child.kill()
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 500)
    }, SUITE_TIMEOUT_MS)
    child.once('error', error => { spawnError = error })
    child.once('close', (status, signal) => {
      clearTimeout(deadline)
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
      resolve({ error: spawnError, signal, status, stdout, stderr, ms: Date.now() - started, timedOut })
    })
  })
}

const selected = only === null ? suites : suites.filter(([name]) => name === only)
if (selected.length === 0) {
  console.error(`no suite named "${only}"`)
  process.exit(1)
}

const results = []
for (const [name, script, args] of selected) {
  const run = await runSuite(script, args)
  const output = `${run.stdout}${run.stderr}`.trimEnd().split('\n')
  const hung = run.timedOut || run.error !== null || run.signal !== null
  const ok = !hung && run.status === 0
  results.push({ name, ok, ms: run.ms, output })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(26)} ${String(run.ms).padStart(5)} ms`)
  if (!ok) {
    if (run.timedOut) console.log(`       killed at the ${SUITE_TIMEOUT_MS / 1000}s deadline — the live output above is the last diagnostic from the suite`)
    else if (hung) console.log(`       never finished (${run.error?.message ?? `signal ${run.signal}`})`)
    const detail = output.filter(line => /^(FAIL|✗|Error|error:)/.test(line.trim())).slice(0, 6)
    for (const line of (detail.length > 0 ? detail : output.slice(-12))) console.log(`       ${line}`)
  }
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} suites passed${failed.length > 0 ? ` — ${failed.map(f => f.name).join(', ')} failed` : ''}`)
process.exitCode = failed.length === 0 ? 0 : 1
