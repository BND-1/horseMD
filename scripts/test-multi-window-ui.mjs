// Multi-window (tab tear-off; user request 2026-11-15). One main window +
// secondary windows that hold tabs only. Covers:
//   1. tab menu 「移到新窗口」: a secondary with that tab, no activity bar /
//      sidebar; the main window loses the tab.
//   2. an unsaved edit in source mode moves with the tab (content, dirty,
//      source mode).
//   3. drag a tab out (dragstart / dragend on the tab; main decides from the
//      drop point, set by the test): torn off into a new window.
//   4. drag a tab onto another window's tab bar (drop there): moved, inserted
//      at the drop index; a secondary left with no tab closes.
//   5. 「移回主窗口」.
//   6. a file opened from the OS that is open in a secondary goes there.
//   7. a theme change in the main window reaches the secondary.
//   8. closing a secondary with an unsaved tab asks once (its own count).
//   9. quitting with secondaries: ONE confirm in the main window counting
//      every window's unsaved documents; next launch restores the secondary
//      (tabs, active tab).
// Windows are hidden (background test mode); quit trace steps are checked.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { connectCdp } from './lib/cdp.mjs'
import { pressKey, MOD_MODIFIER } from './lib/human-input.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-multi-window-'))
const files = {}
for (const name of ['甲', '乙', '丙', '丁']) {
  files[name] = join(root, `${name}.md`)
  await fs.writeFile(files[name], `# ${name}\n\n${name}的正文。\n`)
}
const profileDir = join(root, 'profile')
const pm = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`

async function launch(paths) {
  const inspectPort = 9300 + Math.floor(Math.random() * 150)
  const port = 9500 + Math.floor(Math.random() * 200)
  const app = await launchBuiltElectron({ profileDir, cleanProfile: false, port, appArgs: [...paths, '--horsemd-input-trace', `--inspect=${inspectPort}`] })
  app.port = port
  app.mainEval = async (expression) => {
    const [target] = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
    const reply = await new Promise((resolve) => {
      ws.addEventListener('message', (message) => { const data = JSON.parse(message.data); if (data.id === 1) resolve(data) })
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true } }))
    })
    ws.close()
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description || 'main eval failed')
    return reply.result?.result?.value
  }
  return app
}

const pageTargets = async (port) => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page')
const secondaryCount = async (port) => (await pageTargets(port)).filter((t) => t.url.includes('hmWindow=secondary')).length
async function waitFor(fn, label, ms = 8000) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    last = await fn()
    if (last) return last
    await sleep(150)
  }
  throw new Error(`timed out: ${label} (last: ${JSON.stringify(last)})`)
}
// Connect to the newest secondary window whose tab titles include `title`.
async function secondaryWith(port, title) {
  return waitFor(async () => {
    for (const target of (await pageTargets(port)).filter((t) => t.url.includes('hmWindow=secondary'))) {
      const cdp = await connectCdp({ port, attempts: 4, match: (t) => t.id === target.id })
      const titles = await cdp.evaluate(`[...document.querySelectorAll('.tab .tab-title')].map((n) => n.textContent)`).catch(() => [])
      if (titles.includes(title)) return Object.assign(cdp, { targetId: target.id })
      cdp.ws.close()
    }
    return null
  }, `secondary window with ${title}`)
}
// (A fresh profile also opens the onboarding document; not part of the test.)
const titles = (cdp) => cdp.evaluate(`[...document.querySelectorAll('.tab .tab-title')].map((n) => n.textContent).filter((t) => !/欢迎|Welcome/.test(t))`)
const activeTitle = (cdp) => cdp.evaluate(`document.querySelector('.tab.active .tab-title')?.textContent || null`)
const ready = (cdp) => waitFor(() => cdp.evaluate(`Boolean((${pm})?.pmViewDesc) || Boolean(document.querySelector('.source-editor textarea, textarea.source-editor'))`), 'editor ready', 15000)

async function tabMenu(cdp, title, labelRe) {
  const point = await cdp.evaluate(`(() => { const tab = [...document.querySelectorAll('.tab')].find((n) => n.querySelector('.tab-title')?.textContent === ${JSON.stringify(title)}); if (!tab) return null; const r = tab.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) } })()`)
  assert.ok(point, `tab ${title}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'right', clickCount: 1 })
  await sleep(250)
  const clicked = await cdp.evaluate(`(() => { const item = [...document.querySelectorAll('.tab-ctxmenu .tab-menu-item')].find((b) => ${labelRe}.test(b.textContent)); if (!item) return [...document.querySelectorAll('.tab-ctxmenu .tab-menu-item')].map((b) => b.textContent); item.click(); return true })()`)
  assert.equal(clicked, true, `menu item ${labelRe} in ${JSON.stringify(clicked)}`)
}

// A synthetic HTML5 drag on a tab: dragstart (the handler builds the payload
// and asks main for a token); returns the drag key put on the DataTransfer.
const dragStart = (cdp, title) => cdp.evaluate(`(() => {
  const tab = [...document.querySelectorAll('.tab')].find((n) => n.querySelector('.tab-title')?.textContent === ${JSON.stringify(title)})
  const data = new DataTransfer()
  window.__hmDrag = { tab, data }
  tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
  return data.getData('application/x-horsemd-tab')
})()`)
const dragEnd = (cdp) => cdp.evaluate(`(() => { const { tab, data } = window.__hmDrag; tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data })); return true })()`)
const dropOnTab = (cdp, title, key) => cdp.evaluate(`(() => {
  const tab = [...document.querySelectorAll('.tab')].find((n) => n.querySelector('.tab-title')?.textContent === ${JSON.stringify(title)})
  const data = new DataTransfer(); data.setData('application/x-horsemd-tab', ${JSON.stringify(key)})
  tab.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
  tab.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  return true
})()`)

const confirmStub = (cdp, answer = true) => cdp.evaluate(`(() => { window.__confirms = []; window.confirm = (m) => { window.__confirms.push(String(m)); return ${answer} }; return true })()`)

let app = await launch([files['甲'], files['乙'], files['丙'], files['丁']])
try {
  await ready(app)
  await waitFor(async () => (await titles(app)).length === 4 && 1, 'four tabs in the main window')

  // 1. Tab menu → new window.
  await tabMenu(app, '乙.md', /新窗口|New Window/)
  const s1 = await secondaryWith(app.port, '乙.md')
  await ready(s1)
  assert.deepEqual(await titles(s1), ['乙.md'])
  assert.deepEqual(await titles(app), ['甲.md', '丙.md', '丁.md'], 'the main window lost the moved tab')
  assert.equal(await s1.evaluate(`Boolean(document.querySelector('.activitybar, .activity-bar'))`), false, 'no activity bar in a secondary window')
  assert.equal(await s1.evaluate(`Boolean(document.querySelector('.pane-left .sidebar, .sidebar-panes'))`), false, 'no sidebar in a secondary window')
  assert.equal(await app.evaluate(`Boolean(document.querySelector('.activitybar, .activity-bar'))`), true, 'the main window keeps its activity bar')
  assert.match(await s1.evaluate('document.title'), /乙\.md — HorseMD/)

  // 2. Unsaved edit in source mode moves with the tab.
  await app.evaluate(`[...document.querySelectorAll('.tab')].find((n) => n.textContent.includes('丙.md')).click()`)
  await sleep(500)
  await app.evaluate(`(${pm}).focus()`)
  await pressKey(app.send, { key: 'End', code: 'End', modifiers: MOD_MODIFIER })
  await app.send('Input.insertText', { text: '新加的字' })
  await sleep(400)
  // source mode (the status bar's 源码 switch)
  assert.equal(await app.evaluate(`(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(n.title || n.textContent || '')); b?.click(); return Boolean(b) })()`), true)
  await waitFor(() => app.evaluate(`Boolean([...document.querySelectorAll('textarea')].find((n) => n.offsetParent))`), 'source mode in the main window')
  const sourceBefore = await app.evaluate(`[...document.querySelectorAll('textarea')].find((n) => n.offsetParent).value`)
  assert.match(sourceBefore, /新加的字/)
  await tabMenu(app, '丙.md', /新窗口|New Window/)
  const s2 = await secondaryWith(app.port, '丙.md')
  await waitFor(() => s2.evaluate(`Boolean([...document.querySelectorAll('textarea')].find((n) => n.offsetParent))`), 'source mode kept in the new window')
  assert.equal(await s2.evaluate(`[...document.querySelectorAll('textarea')].find((n) => n.offsetParent).value`), sourceBefore, 'unsaved source text moved')
  assert.equal(await s2.evaluate(`Boolean(document.querySelector('.tab.active .tab-close.dirty'))`), true, 'still unsaved')
  assert.equal(await fs.readFile(files['丙'], 'utf8'), '# 丙\n\n丙的正文。\n', 'nothing written to disk by the move')

  // 3. Drag 丁 out of the main window (drop point far from its tab bar).
  await app.mainEval(`globalThis.__hmTestCursorPoint = { x: 40, y: 600 }; true`)
  const key3 = await dragStart(app, '丁.md')
  assert.ok(key3, 'the drag carries the custom tab type')
  assert.equal(await app.evaluate(`window.__hmDrag.data.getData('text/plain')`), '', 'nothing in text/plain')
  await sleep(200)
  await dragEnd(app)
  const s3 = await secondaryWith(app.port, '丁.md')
  await ready(s3)
  await waitFor(async () => (await titles(app)).join() === '甲.md' && 1, 'main keeps only 甲 after the tear-off')
  assert.equal(await secondaryCount(app.port), 3)

  // 4. Drag 乙 (secondary 1, its only tab) onto 丁's window tab bar, before 丁.
  const key4 = await dragStart(s1, '乙.md')
  await sleep(200)
  await dropOnTab(s3, '丁.md', key4)
  await dragEnd(s1)
  await waitFor(async () => (await titles(s3)).join() === '乙.md,丁.md' && 1, 'inserted before 丁 in the target window')
  await waitFor(async () => (await secondaryCount(app.port)) === 2 && 1, 'the emptied secondary closed')
  assert.equal(await activeTitle(s3), '乙.md')

  // 5. Back to the main window.
  await tabMenu(s3, '乙.md', /主窗口|Main Window/)
  await waitFor(async () => (await titles(app)).includes('乙.md') && 1, '乙 back in the main window')
  assert.deepEqual(await titles(s3), ['丁.md'])

  // 6. Opening 丁.md from the OS goes to its secondary, not the main window.
  await app.mainEval(`(() => { const { app } = require('electron'); app.emit('second-instance', {}, [process.execPath, ${JSON.stringify(files['丁'])}], process.cwd()); return true })()`)
  await sleep(1200)
  assert.equal((await titles(app)).includes('丁.md'), false, 'not opened twice in the main window')
  assert.deepEqual(await titles(s3), ['丁.md'])
  //    …and so does a link to it clicked in the main window (file tree,
  //    Ctrl+O and links all go through openPaths).
  await app.evaluate(`window.dispatchEvent(new CustomEvent('hm:open-document', { detail: { path: ${JSON.stringify(files['丁'])} } }))`)
  await sleep(1200)
  assert.equal((await titles(app)).includes('丁.md'), false, 'a link does not open a second copy')
  assert.deepEqual(await titles(s3), ['丁.md'])

  // 7. A setting changed in the main window reaches the secondary (theme).
  //    (the View menu's 主题 command, as the menu sends it to the main window)
  const themeOf = (cdp) => cdp.evaluate(`[...document.body.classList].filter((c) => /^(light|dark|theme-)/.test(c)).sort().join(' ')`)
  const before7 = await themeOf(s3)
  assert.equal(before7, await themeOf(app))
  await app.mainEval(`(() => { const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('hmWindow=secondary')); w.webContents.send('menu', 'toggleTheme'); return true })()`)
  await waitFor(async () => (await themeOf(app)) !== before7 && 1, 'the main window changed theme')
  await waitFor(async () => (await themeOf(s3)) === (await themeOf(app)) && 1, 'the secondary followed the theme')

  // 8. Close a secondary with an unsaved tab: one confirm with its count.
  await confirmStub(s2, true)
  await s2.evaluate(`window.api.windowClose ? window.api.windowClose() : window.close()`)
  await waitFor(async () => (await secondaryCount(app.port)) === 1 && 1, 'the secondary with 丙 closed after its confirm')
  const s2gone = await pageTargets(app.port)
  assert.equal(s2gone.some((t) => t.id === s2.targetId), false)

  // 9. Quit with a secondary holding an unsaved tab: ONE confirm in main.
  await s3.evaluate(`(${pm}).focus()`)
  await pressKey(s3.send, { key: 'End', code: 'End', modifiers: MOD_MODIFIER })
  await s3.send('Input.insertText', { text: '副窗口改动' })
  await sleep(600)
  await app.evaluate(`[...document.querySelectorAll('.tab')].find((n) => n.textContent.includes('甲.md')).click()`)
  await sleep(300)
  await app.evaluate(`(${pm}).focus()`)
  await pressKey(app.send, { key: 'End', code: 'End', modifiers: MOD_MODIFIER })
  await app.send('Input.insertText', { text: '主窗口改动' })
  await sleep(600)
  await confirmStub(app, true)
  await confirmStub(s3, true)
  const exited = new Promise((resolve) => app.child.once('exit', resolve))
  await app.mainEval(`(() => { require('electron').app.quit(); return true })()`).catch(() => {})
  await Promise.race([exited, sleep(10000)])
  const windowsJson = JSON.parse(await fs.readFile(join(profileDir, 'windows.json'), 'utf8'))
  assert.equal(windowsJson.windows.length, 1, `one secondary kept for the next launch: ${JSON.stringify(windowsJson)}`)
  assert.deepEqual(windowsJson.windows[0].tabs.map((t) => t.path), [files['丁']])
  const traceFiles = (await fs.readdir(tmpdir())).filter((n) => n === `horsemd-input-trace-${app.child.pid}.jsonl`)
  const traceText = (await Promise.all(traceFiles.map((n) => fs.readFile(join(tmpdir(), n), 'utf8')))).join('\n')
  const quitSteps = traceText.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((e) => e?.kind === 'quit')
  const prepared = quitSteps.find((e) => e.step === 'quit-prepared')
  assert.ok(prepared, `quit-prepared traced: ${quitSteps.map((e) => e.step).join(', ')}`)
  assert.equal(prepared.dirty, 1, 'the secondary reported its unsaved document')
  // Only the quit (step 8's secondary close asked its own confirm earlier).
  const quitStart = quitSteps.map((e) => e.step).lastIndexOf('quit-prepare-sent')
  const shown = quitSteps.slice(quitStart).filter((e) => e.step === 'confirm-shown')
  assert.equal(shown.length, 1, `one quit confirm: ${quitSteps.map((e) => e.step).join(', ')}`)
  assert.equal(shown[0].dirty + (shown[0].extraDirty || 0), 2, `the confirm counts both windows: ${JSON.stringify(shown[0])}`)
  await stopBuiltElectron(app).catch(() => {})

  // Next launch restores the secondary with 丁.
  app = await launch([])
  await ready(app)
  const restored = await secondaryWith(app.port, '丁.md')
  await ready(restored)
  assert.deepEqual(await titles(restored), ['丁.md'])
  assert.equal((await titles(app)).includes('丁.md'), false)
} finally {
  await stopBuiltElectron(app, { removeProfile: false }).catch(() => {})
}
await fs.rm(root, { recursive: true, force: true })
console.log('PASS multi-window UI: move to new window (no sidebar there), unsaved source-mode tab moves intact, drag tear-off, drag into another window at the drop index (empty window closes), move back to main, OS open goes to the holding window, closing a secondary asks once, quit asks once for every window and the secondary is restored next launch')
