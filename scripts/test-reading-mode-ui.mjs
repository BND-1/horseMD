// Reading mode (#163): a status-bar switch / Mod+Shift+R makes documents
// read-only. Selecting with the mouse and copying, find, outline jumps, link
// clicks and external-change reloads keep working; typing, Enter/Backspace,
// formatting shortcuts (even while the editor still holds focus), code
// blocks, task checkboxes, replace, outline drag and source-mode typing never
// change the document. The setting survives a restart; switching back
// restores normal editing, and a save writes exactly the expected bytes.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-reading-'))
const file = join(root, 'doc.md')
const other = join(root, 'other.md')
const original = [
  '# 阅读模式',
  '',
  '第一段**粗体**文字，用来框选复制。',
  '',
  '[另一个文档](other.md) 和 [网站](https://example.com/hm)',
  '',
  '- [ ] 待办事项',
  '- 普通项',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
  '| 列一 | 列二 |',
  '| --- | --- |',
  '| 甲 | 乙 |',
  '',
  '批注{==重点==}{>>说明<<}文字',
  '',
  '尾段',
  ''
].join('\n')
await writeFile(file, original)
await writeFile(other, '# 另一个文档\n\n内容\n')
const port = 29700 + process.pid % 100
const inspectPort = 9600 + process.pid % 200
const launch = () => launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port, appArgs: [file, '--horsemd-input-trace', `--inspect=${inspectPort}`]
})
// Evaluate in the main process (link opening goes through Electron's shell).
const mainEval = async (expression) => {
  const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
  const ws = new WebSocket(list[0].webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  const done = new Promise((resolve) => ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d) }))
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, returnByValue: true } }))
  const res = await done
  ws.close()
  return res.result?.result?.value
}
let app = await launch()
const send = (...args) => app.send(...args)
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const mod = process.platform === 'darwin' ? 4 : 2
const waitFor = async (check, message, attempts = 80) => {
  for (let i = 0; i < attempts; i += 1) { const value = await check(); if (value) return value; await sleep(100) }
  throw new Error(message)
}
// The document's own text (decorations such as an open review card are not
// part of it).
const text = () => app.evaluate(`(${editor})?.pmViewDesc?.node?.textContent || ''`)
const state = () => app.evaluate(`(() => {
  const view = ${editor}
  const btn = document.querySelector('.hm-reading-btn')
  return {
    editable: view?.contentEditable,
    button: btn?.textContent.trim(), active: btn?.classList.contains('active'),
    dirty: Boolean(document.querySelector('.status-dot.mod')),
    saved: JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}').readingMode === true
  }
})()`)
const watchToasts = () => app.evaluate(`(() => {
  globalThis.__toasts = []
  new MutationObserver(() => {
    for (const node of document.querySelectorAll('.hm-toast-msg')) {
      const msg = node.textContent
      if (globalThis.__toasts[globalThis.__toasts.length - 1] !== msg) globalThis.__toasts.push(msg)
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true })
  // Read synchronously: clipboardData is locked once the event finishes.
  // Empty data means the browser's native copy ran (no handler set data):
  // then the selection itself is what lands on the clipboard.
  document.addEventListener('copy', (event) => {
    globalThis.__copied = event.clipboardData.getData('text/plain') || ('native:' + getSelection().toString())
  })
})()`)
const toasts = () => app.evaluate('globalThis.__toasts || []')
const mouse = async (type, point, clickCount = 1) =>
  send('Input.dispatchMouseEvent', { type, button: 'left', clickCount, ...point })
const click = async (point) => {
  await mouse('mouseMoved', point)
  await mouse('mousePressed', point)
  await mouse('mouseReleased', point)
  await sleep(200)
}
const rectOf = (expression) => app.evaluate(`(() => {
  const node = ${expression}
  if (!node) return null
  node.scrollIntoView({ block: 'center' })
  const r = node.getBoundingClientRect()
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`)
const paragraph = (value) => `[...(${editor}).querySelectorAll('p')].find(n => n.textContent === ${JSON.stringify(value)})`
const clickParagraphEnd = async (value) => {
  const r = await rectOf(paragraph(value))
  assert.ok(r, `paragraph ${value} missing`)
  await click({ x: r.right - 2, y: (r.top + r.bottom) / 2 })
}
const formatting = () => app.evaluate(`['strong', 'em', 'mark', 'h1', 'h2', 'p'].map(tag => (${editor}).querySelectorAll(tag).length)`)
const sourceButton = "[...document.querySelectorAll('.status-right .status-btn')].find(b => /源码|富文本/.test(b.textContent))"
const toggleShortcut = () => pressKey(send, { key: 'R', code: 'KeyR', modifiers: mod | 8 })

try {
  await waitFor(async () => (await text()).includes('尾段'), 'document did not open')
  await sleep(800)
  await watchToasts()
  const before = await state()
  assert.equal(before.button, '编辑', `status button: ${JSON.stringify(before)}`)
  assert.equal(before.editable, 'true')

  // 1. The status-bar switch enters reading mode and persists it.
  const button = await rectOf("document.querySelector('.hm-reading-btn')")
  await click(button)
  const on = await waitFor(async () => { const s = await state(); return s.editable === 'false' && s }, 'switch did not enter reading mode')
  assert.deepEqual([on.button, on.active, on.saved], ['阅读', true, true], JSON.stringify(on))
  const baseline = await text()

  // 2. Mouse selection and copy work.
  const p = await rectOf(paragraph('第一段粗体文字，用来框选复制。'))
  await mouse('mouseMoved', { x: p.left + 2, y: p.y })
  await mouse('mousePressed', { x: p.left + 2, y: p.y })
  for (let i = 1; i <= 8; i += 1) await mouse('mouseMoved', { x: p.left + 2 + (p.right - p.left - 6) * i / 8, y: p.y })
  await mouse('mouseReleased', { x: p.right - 4, y: p.y })
  await sleep(250)
  const selected = await app.evaluate('getSelection().toString()')
  assert.match(selected, /粗体/, `mouse selection: ${JSON.stringify(selected)}`)
  await app.evaluate('globalThis.__copied = null')
  for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', {
    type, key: 'c', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: mod, commands: ['copy']
  })
  const copied = await waitFor(() => app.evaluate('globalThis.__copied'), 'Cmd/Ctrl+C did not copy')
  assert.match(copied, /第一段粗体文字/, `copied: ${JSON.stringify(copied)}`)

  // 3. Typing, Enter, Backspace, Mod+B and paste change nothing; a hint shows.
  await clickParagraphEnd('尾段')
  await typeTextLikeUser(send, '打字')
  for (const key of ['Backspace', 'Enter', 'Delete']) await pressKey(send, { key, ...(key === 'Enter' ? { text: '\r' } : {}) })
  await pressKey(send, { key: 'x', code: 'KeyX', text: 'x' })
  await pressKey(send, { key: 'b', code: 'KeyB', modifiers: mod })
  const pasted = await app.evaluate(`(() => {
    const data = new DataTransfer(); data.setData('text/plain', '粘贴')
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
    ;(${editor}).dispatchEvent(event); return event.defaultPrevented
  })()`)
  assert.equal(pasted, true, 'paste was not stopped')
  await sleep(400)
  assert.equal(await text(), baseline, 'keyboard input changed a read-only document')
  assert.ok((await toasts()).some((msg) => msg.includes('阅读模式')), `no reading-mode hint: ${JSON.stringify(await toasts())}`)

  // 4. Code block and task checkbox.
  const code = await rectOf(`(${editor}).querySelector('.cm-content')`)
  await click({ x: code.right - 4, y: code.y })
  await typeTextLikeUser(send, 'zz')
  await pressKey(send, { key: 'Backspace' })
  const task = await rectOf(`(${editor}).querySelector('.label-wrapper .label.unchecked')`)
  assert.ok(task, 'task checkbox missing')
  await click(task)
  await sleep(300)
  assert.equal(await text(), baseline, 'code block or checkbox changed a read-only document')
  assert.equal(await app.evaluate(`Boolean((${editor}).querySelector('.label-wrapper .label.unchecked')) && !(${editor}).querySelector('.label-wrapper .label.checked')`), true, 'task checkbox toggled')

  // 4b. A review note opens read-only: copy actions only.
  await click(await rectOf(`(${editor}).querySelector('.hm-review-note-button')`))
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-review-card[role="dialog"]'))`), 'review card did not open')
  const actions = await app.evaluate(`[...document.querySelectorAll('.hm-review-card .hm-review-card-action')].map(b => b.title)`)
  assert.ok(actions.length >= 1, 'review card has no copy actions')
  assert.equal(actions.some((title) => /编辑|完成|删除/.test(title)), false, `review card offers edits: ${JSON.stringify(actions)}`)
  await pressKey(send, { key: 'Escape' })
  await sleep(200)
  assert.equal(await text(), baseline, 'review card changed the document')

  // 5. Entering with the caret in the editor: Mod+B / Mod+Alt+H must not
  // reformat (Chromium moves focus off the now non-editable view).
  await toggleShortcut()
  await waitFor(async () => (await state()).editable === 'true', 'shortcut did not leave reading mode')
  const tail = await app.evaluate(`(() => {
    const p = ${paragraph('尾段')}; p.scrollIntoView({ block: 'center' }); (${editor}).focus()
    getSelection().setBaseAndExtent(p.firstChild, 0, p.firstChild, 2)
    return document.activeElement === ${editor}
  })()`)
  assert.equal(tail, true, 'editor did not take focus')
  await sleep(200)
  await toggleShortcut()
  await waitFor(async () => (await state()).editable === 'false', 'shortcut did not re-enter reading mode')
  const formatBefore = await formatting()
  await pressKey(send, { key: 'b', code: 'KeyB', modifiers: mod })
  await pressKey(send, { key: 'i', code: 'KeyI', modifiers: mod })
  await pressKey(send, { key: 'h', code: 'KeyH', modifiers: mod | 1 })
  await pressKey(send, { key: '1', code: 'Digit1', modifiers: mod })
  await sleep(400)
  assert.equal(await text(), baseline)
  assert.deepEqual(await formatting(), formatBefore, 'a formatting shortcut changed the document')
  assert.equal((await state()).dirty, false, 'reading mode made the document dirty')

  // 6. Find works, replace is gone (also via its shortcut).
  await pressKey(send, { key: 'f', code: 'KeyF', modifiers: mod })
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.findbar'))`), 'find bar did not open')
  assert.equal(await app.evaluate(`document.querySelectorAll('.findbar .findbar-row').length`), 1, 'replace row shown in reading mode')
  await typeTextLikeUser(send, '甲')
  await waitFor(() => app.evaluate(`document.querySelector('.findbar-count')?.textContent === '1/1'`), 'find did not match')
  await pressKey(send, { key: 'Escape' })
  await pressKey(send, { key: 'f', code: 'KeyF', modifiers: mod | 1 })
  await sleep(300)
  assert.equal(await app.evaluate(`document.querySelectorAll('.findbar .findbar-row').length <= 1`), true, 'replace shortcut opened replace')
  if (await app.evaluate(`Boolean(document.querySelector('.findbar'))`)) await pressKey(send, { key: 'Escape' })

  // 7. Outline: jumps work, headings cannot be dragged.
  await pressKey(send, { key: 'l', code: 'KeyL', modifiers: mod | 8 })
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.outline-item'))`), 'outline did not open')
  assert.equal(await app.evaluate(`document.querySelectorAll('.outline-drag-handle').length`), 0, 'outline drag handle shown in reading mode')

  // 8. Source mode: the textarea is read-only.
  await click(await rectOf(sourceButton))
  await waitFor(() => app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find(e => e.offsetParent))`), 'source mode did not open')
  const sourceBefore = await app.evaluate(`[...document.querySelectorAll('textarea.source-editor')].find(e => e.offsetParent).value`)
  assert.equal(await app.evaluate(`[...document.querySelectorAll('textarea.source-editor')].find(e => e.offsetParent).readOnly`), true)
  const source = await rectOf(`[...document.querySelectorAll('textarea.source-editor')].find(e => e.offsetParent)`)
  await click(source)
  await typeTextLikeUser(send, 'q')
  await pressKey(send, { key: 'Backspace' })
  await sleep(300)
  assert.equal(await app.evaluate(`[...document.querySelectorAll('textarea.source-editor')].find(e => e.offsetParent).value`), sourceBefore, 'source textarea changed')
  await click(await rectOf(sourceButton))
  await waitFor(async () => (await text()).includes('尾段') && await app.evaluate(`![...document.querySelectorAll('textarea.source-editor')].some(e => e.offsetParent)`), 'did not return to rich mode')

  // 9. External change reloads in reading mode.
  const changed = original.replace('尾段', '外部改动的尾段')
  await writeFile(file, changed)
  await waitFor(async () => (await text()).includes('外部改动的尾段'), 'external change was not reloaded')
  assert.equal((await state()).editable, 'false', 'reload left reading mode')

  // 10. Restart keeps reading mode.
  await stopBuiltElectron(app)
  app = await launch()
  await waitFor(async () => (await text()).includes('外部改动的尾段'), 'document did not reopen')
  await sleep(800)
  await watchToasts()
  const restarted = await state()
  assert.deepEqual([restarted.editable, restarted.button, restarted.active], ['false', '阅读', true], JSON.stringify(restarted))

  // 11. A plain click on a link opens it. Electron's shell is stubbed in main
  // so nothing really opens (a local file would start the system's default
  // Markdown app).
  await mainEval(`(() => { const { shell } = require('electron'); globalThis.__hmOpened = []
    shell.openPath = async (p) => { globalThis.__hmOpened.push('path:' + p); return '' }
    shell.openExternal = async (u) => { globalThis.__hmOpened.push('url:' + u) }
    return true })()`)
  await click(await rectOf(`(${editor}).querySelector('a[href="other.md"]')`))
  await click(await rectOf(`(${editor}).querySelector('a[href^="https:"]')`))
  const opened = await waitFor(async () => { const v = await mainEval('globalThis.__hmOpened'); return v?.length >= 2 && v }, 'link clicks did not open')
  assert.ok(opened[0].startsWith('path:') && opened[0].endsWith('other.md'), JSON.stringify(opened))
  assert.equal(opened[1], 'url:https://example.com/hm')

  // 12. Back to editing: typing works and the save writes exactly one change.
  await toggleShortcut()
  await waitFor(async () => (await state()).editable === 'true', 'shortcut did not leave reading mode')
  assert.equal((await state()).saved, false)
  await clickParagraphEnd('外部改动的尾段')
  await pressKey(send, { key: 'End' })
  await typeTextLikeUser(send, '可以编辑')
  await waitFor(async () => (await state()).dirty, 'typing did not dirty the document')
  await click(await rectOf("document.querySelector('.hm-save-fab')"))
  await waitFor(async () => (await readFile(file, 'utf8')).includes('可以编辑'), 'save did not write')
  assert.equal(await readFile(file, 'utf8'), changed.replace('外部改动的尾段', '外部改动的尾段可以编辑'), 'saved bytes differ')
  const all = await toasts()
  assert.equal(all.some((msg) => msg.includes('不一致')), false, `source mismatch toast: ${JSON.stringify(all)}`)
  console.log('PASS reading mode: status-bar switch + Mod+Shift+R (persisted); mouse select + copy; typing/Enter/Backspace/paste/Mod+B/Mod+I/Mod+Alt+H/Mod+1 (also with focus kept), code block, task checkbox, replace, outline drag and source typing change nothing (hint shown); find, outline, external reload and plain link click work; back to editing saves exact bytes')
} finally {
  await stopBuiltElectron(app)
  console.log('Evidence retained:', root)
}
