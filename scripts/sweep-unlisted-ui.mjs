// Runs every scripts/test-*-ui.mjs that scripts/run-ui-regression.mjs does
// not list, one at a time, and records each result (docs/rich-source-fuzzing.md
// §2.2). Tests outside the suite rot silently: the 2026-11-06 sweep found 132
// of 223 failing, a few of them real bugs.
//
//   npm run build && node scripts/sweep-unlisted-ui.mjs
//   SWEEP_OUT=dir  SWEEP_ONLY=a.mjs,b.mjs  SWEEP_TIMEOUT=240000
//
// Output: <SWEEP_OUT>/results.jsonl (one line per script) + logs/<script>.log.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.env.SWEEP_OUT || join(tmpdir(), `horsemd-ui-sweep-${process.pid}`)
const logs = join(out, 'logs')
mkdirSync(logs, { recursive: true })
const results = join(out, 'results.jsonl')
writeFileSync(results, '')

const listed = readFileSync(join(repo, 'scripts/run-ui-regression.mjs'), 'utf8')
const scripts = process.env.SWEEP_ONLY
  ? process.env.SWEEP_ONLY.split(',').filter(Boolean)
  : readdirSync(join(repo, 'scripts')).filter((name) => /^test-.*-ui\.mjs$/.test(name) && !listed.includes(name)).sort()
const timeout = Number(process.env.SWEEP_TIMEOUT || 240000)

const run = (script) => new Promise((resolve) => {
  const started = Date.now()
  // Own process group, so a timeout also ends the Electron it launched.
  const child = spawn(process.execPath, [join('scripts', script)], {
    cwd: repo,
    env: { ...process.env, HORSEMD_TEST_RUN: '1' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let text = ''
  child.stdout.on('data', (chunk) => { text += chunk })
  child.stderr.on('data', (chunk) => { text += chunk })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
  }, timeout)
  child.on('close', (code) => {
    clearTimeout(timer)
    writeFileSync(join(logs, script.replace(/\.mjs$/, '.log')), text)
    const lines = text.split('\n').filter(Boolean)
    const pass = lines.filter((line) => /^PASS/.test(line)).pop() || ''
    const error = lines.find((line) => /AssertionError|^Error|^FAIL|not ok/.test(line)) || ''
    resolve({ script, code, timedOut, ms: Date.now() - started, pass: pass.slice(0, 160), error: error.slice(0, 300) })
  })
})

let failed = 0
for (const script of scripts) {
  const result = await run(script)
  if (result.code !== 0) failed += 1
  appendFileSync(results, JSON.stringify(result) + '\n')
  console.log(`${result.code === 0 ? 'ok  ' : 'FAIL'} ${script}${result.timedOut ? ' (timeout)' : ''}${result.error ? ` — ${result.error.slice(0, 120)}` : ''}`)
}
console.log(`${scripts.length - failed}/${scripts.length} passed; results in ${results}`)
