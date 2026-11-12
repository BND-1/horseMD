// The quit flow is in the input trace (main: before-quit, window-close,
// renderer-confirmed / -cancelled, will-quit; renderer: close-request-
// received, confirm-shown with the dirty tab count). A quit that never
// finished (mini 2026-11-10: Cmd+Q and SIGTERM ignored) had left no trace of
// where it stopped.
//  1. A clean document: SIGTERM quits, every step traced.
//  2. An unsaved edit: SIGTERM brings the window forward, shows the
//     unsaved-changes confirm (traced with the dirty count) and does not quit
//     behind the user's back.
// On Windows SIGTERM is TerminateProcess (no quit flow at all), so the test
// closes the window there instead — the close button's path.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-quit-trace-${process.pid}`
const exitWithin = (child, ms) => new Promise((resolve) => {
  if (child.exitCode != null || child.signalCode != null) return resolve(true)
  const timer = setTimeout(() => resolve(false), ms)
  child.once('exit', () => { clearTimeout(timer); resolve(true) })
})

async function run(name, edit) {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'doc.md')
  await writeFile(file, '# t\n\nbody\n', 'utf8')
  const app = await launchBuiltElectron({ profileDir: join(dir, 'profile'), port: name === 'clean' ? 9645 : 9646, appArgs: [file] })
  try {
    await sleep(1500)
    if (edit) {
      await app.evaluate(`(() => { const v = globalThis.__hmSourceReprintHarness.view(); v.focus(); return true })()`)
      await app.send('Input.insertText', { text: 'X' })
      await sleep(800)
    }
    const pid = app.child.pid
    if (process.platform === 'win32') await app.evaluate('(() => { setTimeout(() => window.close(), 0); return true })()')
    else app.child.kill('SIGTERM')
    const exited = await exitWithin(app.child, 6000)
    // Renderer steps reach the file through IPC, main's are written at once.
    if (!exited) await sleep(500)
    let lines = []
    try { lines = (await readFile(join(tmpdir(), `horsemd-input-trace-${pid}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).sort((a, b) => a.t - b.t) } catch { /* no trace */ }
    if (process.env.HM_QUIT_DEBUG) console.log(lines.filter((e) => e.kind === "quit").map((e) => `${e.t} ${e.step}`).join("\n"))
    const steps = lines.filter((entry) => entry.kind === 'quit').map((entry) => entry.step + (entry.dirty ? `:${entry.dirty}` : ''))
    return { exited, steps, app }
  } catch (error) {
    try { app.child.kill('SIGKILL') } catch { /* gone */ }
    await exitWithin(app.child, 10000)
    throw error
  }
}

await rm(root, { recursive: true, force: true })
try {
  const clean = await run('clean', false)
  assert.equal(clean.exited, true, 'a clean document quits on SIGTERM')
  for (const step of ['before-quit', 'window-close', 'close-request-received', 'confirmed', 'renderer-confirmed', 'will-quit']) {
    assert.ok(clean.steps.includes(step), `quit step ${step} traced: ${JSON.stringify(clean.steps)}`)
  }
  const dirty = await run('dirty', true)
  assert.equal(dirty.exited, false, 'an unsaved edit is not dropped by SIGTERM')
  assert.ok(dirty.steps.some((step) => step.startsWith('confirm-shown:')), `the unsaved-changes confirm is traced with its dirty count: ${JSON.stringify(dirty.steps)}`)
  // The window comes forward before the confirm (it is a modal of the window).
  assert.ok(dirty.steps.indexOf('window-shown-for-confirm') >= 0 && dirty.steps.indexOf('window-shown-for-confirm') < dirty.steps.findIndex((step) => step.startsWith('confirm-shown:')), `the window is brought forward before the confirm: ${JSON.stringify(dirty.steps)}`)
  assert.ok(!clean.steps.includes('window-shown-for-confirm'), 'a clean quit does not bring the window forward')
  try { dirty.app.child.kill('SIGKILL') } catch { /* gone */ }
  await exitWithin(dirty.app.child, 10000)
  console.log(`PASS quit trace: clean quit traced (${clean.steps.join(' → ')}); an unsaved edit shows the confirm (${dirty.steps.join(' → ')})`)
} finally {
  // Windows releases a killed process's files a moment after it exits.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
