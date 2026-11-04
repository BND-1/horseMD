// Nightly rich/source stability run (docs/rich-source-fuzzing.md §2.1).
//
// Builds the LAST COMMIT in its own git worktree (node_modules shared) and
// runs, there:
//   - the full mark-combination test with a seed from the date (FULL=1),
//   - the CommonMark / GFM spec corpus,
//   - the random fuzzer with formatting, the editor's UI (slash menu, block
//     drag, table handles) and pasting on (FUZZ_FORMAT=1, FUZZ_UI=1,
//     FUZZ_PASTE=1) over seeds from the date.
// The working copy, its out/ and the installed app are never touched.
// A short summary goes to $NIGHTLY_LOG_DIR (default
// ~/Library/Logs/HorseMD-nightly, or ~/.horsemd-nightly elsewhere)
// as <date>.md, with each failing run's output and fuzz reports beside it.
//
//   node scripts/nightly-rich-source.mjs            (what launchd runs)
//   NIGHTLY_FUZZ_SEEDS=8 NIGHTLY_FUZZ_OPS=200 node scripts/nightly-rich-source.mjs
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(new URL('..', import.meta.url).pathname)
const date = new Date().toISOString().slice(0, 10)
const dayNumber = Math.floor(Date.now() / 86400000)
const logRoot = process.env.NIGHTLY_LOG_DIR || (process.platform === 'darwin' ? join(homedir(), 'Library/Logs/HorseMD-nightly') : join(homedir(), '.horsemd-nightly'))
const logDir = join(logRoot, date)
const fuzzSeeds = Number(process.env.NIGHTLY_FUZZ_SEEDS || 12)
const fuzzOps = Number(process.env.NIGHTLY_FUZZ_OPS || 150)
const work = join(tmpdir(), `horsemd-nightly-${process.pid}`)

const run = (name, command, args, env = {}) => new Promise((done) => {
  const started = Date.now()
  let output = ''
  const child = spawn(command, args, { cwd: work, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  child.on('close', (code) => done({ name, code, output, seconds: Math.round((Date.now() - started) / 1000) }))
})

await mkdir(logDir, { recursive: true })
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo }).toString().trim()
const results = []
try {
  execFileSync('git', ['worktree', 'add', '--detach', work, 'HEAD'], { cwd: repo, stdio: 'ignore' })
  await symlink(join(repo, 'node_modules'), join(work, 'node_modules'))
  results.push(await run('build', 'npm', ['run', 'build']))
  if (results[0].code === 0) {
    const seed = String(dayNumber % 100000)
    results.push(await run(`mark combinations (FULL, seed ${seed})`, 'node', ['scripts/test-mark-combinations-ui.mjs'], { FULL: '1', SEED: seed, CAP: '200' }))
    results.push(await run('spec corpus', 'node', ['scripts/test-spec-corpus-ui.mjs']))
    const first = (dayNumber * 7) % 9000 + 1000
    const seeds = Array.from({ length: fuzzSeeds }, (_, i) => first + i).join(',')
    const fuzzOut = join(work, 'fuzz-out')
    results.push(await run(`fuzz (FORMAT+UI+PASTE, seeds ${seeds}, ${fuzzOps} ops)`, 'node', ['scripts/fuzz-rich-source-ui.mjs'], { FUZZ_SEEDS: seeds, FUZZ_OPS: String(fuzzOps), FUZZ_FORMAT: '1', FUZZ_UI: '1', FUZZ_PASTE: '1', FUZZ_OUT: fuzzOut }))
    if (existsSync(fuzzOut)) await cp(fuzzOut, join(logDir, 'fuzz'), { recursive: true })
  }
} finally {
  try { execFileSync('rm', ['-f', join(work, 'node_modules')]) } catch {}
  try { execFileSync('git', ['worktree', 'remove', '--force', work], { cwd: repo, stdio: 'ignore' }) } catch {}
  try { execFileSync('git', ['worktree', 'prune'], { cwd: repo, stdio: 'ignore' }) } catch {}
  await rm(work, { recursive: true, force: true })
}

const failed = results.filter((r) => r.code !== 0)
const tail = (text, lines) => text.trim().split('\n').slice(-lines).join('\n')
const summary = [
  `# HorseMD nightly ${date} (${commit})`,
  '',
  failed.length ? `**${failed.length} failed**` : '**All passed**',
  '',
  ...results.map((r) => `- ${r.code === 0 ? 'PASS' : 'FAIL'} ${r.name} — ${r.seconds} s${r.code === 0 ? '' : `\n\n  \`\`\`\n${tail(r.output, 12).replace(/^/gm, '  ')}\n  \`\`\``}`),
  ''
].join('\n')
await writeFile(join(logDir, 'summary.md'), summary)
await writeFile(join(logRoot, `${date}.md`), summary)
for (const r of failed) await writeFile(join(logDir, `${r.name.replace(/[^a-z0-9]+/gi, '-')}.log`), r.output)
console.log(summary)
process.exitCode = failed.length ? 1 : 0
