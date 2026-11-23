// The main window's position and size come back on the next launch
// (src/main/window-state.js; Windows 10 report 2026-11-22: every start was
// the default 1280×820, centred — on every OS, the main window was never
// remembered). Real app, real profile, closed the way a user closes it
// (the window's close, which on Windows is also the only way: SIGTERM is
// TerminateProcess there):
//   1. a moved + resized window is saved on close and comes back exactly;
//   2. a window saved on a monitor that is gone comes back centred on the
//      primary display, shrunk to fit;
//   3. a window larger than its display (resolution change) is shrunk into it;
//   4. a maximized window keeps its normal size; on the next start it is
//      maximized again (a test run stays in the background, so the maximize
//      itself is only traced).
// Main-process state is read and driven through the Node inspector.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-window-state-'))
const profileDir = join(root, 'profile')
const stateFile = join(profileDir, 'window-state.json')
const cdpPort = 29500 + process.pid % 200
const inspectPort = 29700 + process.pid % 200

const exitWithin = (child, ms) => new Promise((resolve) => {
  if (child.exitCode != null || child.signalCode != null) return resolve(true)
  const timer = setTimeout(() => resolve(false), ms)
  child.once('exit', () => { clearTimeout(timer); resolve(true) })
})

async function mainEval(expression) {
  let targets = null
  for (let i = 0; i < 40 && !targets?.length; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json() } catch { await sleep(150) }
  }
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  try {
    const reply = new Promise((resolve) => ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data)
      if (data.id === 1) resolve(data)
    }))
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true } }))
    const data = await reply
    if (data.result?.exceptionDetails) throw new Error(JSON.stringify(data.result.exceptionDetails).slice(0, 400))
    return data.result?.result?.value
  } finally {
    ws.close()
  }
}

const MAIN = `require('electron').BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('hmWindow='))`
const readMain = () => mainEval(`(() => {
  const { screen } = require('electron')
  const w = ${MAIN}
  return JSON.stringify({ bounds: w.getBounds(), normal: w.getNormalBounds(), maximized: w.isMaximized(),
    primary: screen.getPrimaryDisplay().workArea, areas: screen.getAllDisplays().map((d) => d.workArea) })
})()`).then(JSON.parse)

async function launch() {
  const app = await launchBuiltElectron({ profileDir, cleanProfile: false, port: cdpPort, appArgs: [`--inspect=${inspectPort}`] })
  // A close before the renderer said app-ready (useAppLifecycle, in the
  // mount effect) reaches nobody — Windows starts slower: wait for the
  // mounted shell, then give the session restore its time.
  for (let i = 0; i < 150; i++) {
    if (await app.evaluate(`!!document.querySelector('.statusbar')`).catch(() => false)) break
    await sleep(100)
  }
  await sleep(1500)
  return app
}

// Closed like the user does: the window's close (no unsaved tab → quits).
async function closeApp(app) {
  const pid = app.child.pid
  await mainEval(`(() => { (${MAIN}).close(); return true })()`)
  // macOS: closing the last window leaves the app running (the platform's
  // rule); the user then quits it.
  let exited = await exitWithin(app.child, process.platform === 'darwin' ? 2500 : 8000)
  if (!exited && process.platform === 'darwin') {
    await mainEval(`(() => { require('electron').app.quit(); return true })()`).catch(() => {})
    exited = await exitWithin(app.child, 6000)
  }
  if (!exited) await stopBuiltElectron(app)
  else try { app.ws?.close() } catch { /* closed */ }
  assert.ok(exited, 'the app quits when its window is closed (macOS: and then quit)')
  let trace = []
  try {
    trace = (await readFile(join(tmpdir(), `horsemd-input-trace-${pid}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { /* no trace */ }
  return trace.filter((e) => e.kind === 'window')
}

// Windows at a fractional display scale rounds window bounds outwards by a
// few pixels on every conversion (125 %: 1000 → 1002–1004); macOS is exact.
const TOL = process.platform === 'win32' ? 4 : 2
const near = (a, b, label) => {
  for (const k of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(a[k] - b[k]) <= TOL, `${label}: ${k} ${a[k]} ≠ ${b[k]} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`)
}

try {
  // 1. Move + resize, close, reopen.
  let app = await launch()
  const first = await readMain()
  const wa = first.primary
  const target = { x: wa.x + 37, y: wa.y + 41, width: Math.min(1000, wa.width - 60), height: Math.min(640, wa.height - 60) }
  assert.notDeepEqual(first.bounds, target, 'the fixture bounds differ from the default')
  await mainEval(`(() => { (${MAIN}).setBounds(${JSON.stringify(target)}); return true })()`)
  await sleep(300)
  let steps = await closeApp(app)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  near(saved.bounds, target, 'saved bounds')
  assert.equal(saved.maximized, false, 'not maximized')
  assert.ok(steps.some((e) => e.step === 'window-state-saved'), `save traced: ${JSON.stringify(steps.map((e) => e.step))}`)
  app = await launch()
  let now = await readMain()
  near(now.bounds, target, 'reopened at the saved bounds')
  console.log(`  ✓ moved + resized window comes back: ${JSON.stringify(now.bounds)}`)
  await closeApp(app)

  // 1b. Opened and closed again untouched: the saved bounds never creep
  // (Windows 125 % made the window a few pixels larger per launch).
  const savedOnce = JSON.parse(await readFile(stateFile, 'utf8')).bounds
  for (let round = 0; round < 3; round++) {
    app = await launch()
    await closeApp(app)
    assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')).bounds, savedOnce, `round ${round + 1}: saved bounds unchanged by an untouched launch`)
  }
  console.log(`  ✓ three untouched launches keep the saved bounds: ${JSON.stringify(savedOnce)}`)

  // 2. Saved on a monitor that is gone.
  await writeFile(stateFile, JSON.stringify({ version: 1, bounds: { x: -50000, y: -50000, width: 900, height: 600 }, maximized: false }))
  app = await launch()
  now = await readMain()
  const expected = { x: wa.x + Math.round((wa.width - 900) / 2), y: wa.y + Math.round((wa.height - 600) / 2), width: 900, height: 600 }
  near(now.bounds, expected, 'off-screen window centred on the primary display')
  console.log(`  ✓ window from a missing monitor comes back centred: ${JSON.stringify(now.bounds)}`)
  await closeApp(app)

  // 3. Larger than the display now.
  await writeFile(stateFile, JSON.stringify({ version: 1, bounds: { x: wa.x + 10, y: wa.y + 10, width: wa.width + 400, height: wa.height + 300 }, maximized: false }))
  app = await launch()
  now = await readMain()
  assert.ok(now.bounds.width <= wa.width + TOL && now.bounds.height <= wa.height + TOL, `shrunk to the work area: ${JSON.stringify(now.bounds)} in ${JSON.stringify(wa)}`)
  assert.ok(now.bounds.x >= wa.x - TOL && now.bounds.y >= wa.y - TOL, `inside the work area: ${JSON.stringify(now.bounds)}`)
  console.log(`  ✓ oversized window shrunk into the display: ${JSON.stringify(now.bounds)}`)
  await closeApp(app)

  // 4. Maximized: the normal size is what is kept, maximized comes back.
  const normal = { x: wa.x + 60, y: wa.y + 50, width: Math.min(900, wa.width - 100), height: Math.min(600, wa.height - 100) }
  await writeFile(stateFile, JSON.stringify({ version: 1, bounds: normal, maximized: true }))
  app = await launch()
  now = await readMain()
  near(now.normal, normal, 'normal bounds of a maximized window')
  steps = await closeApp(app)
  const restored = steps.find((e) => e.step === 'window-state-restored')
  assert.equal(restored?.maximized, true, `restored as maximized: ${JSON.stringify(restored)}`)
  assert.ok(steps.some((e) => e.step === 'window-state-maximize-skipped'), 'maximize traced (skipped only because tests stay in the background)')
  const after = JSON.parse(await readFile(stateFile, 'utf8'))
  near(after.bounds, normal, 'the normal bounds stay saved')
  console.log('  ✓ maximized window keeps its normal size and is maximized again')

  console.log('PASS window state')
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
