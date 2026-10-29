// A folded heading carries its section, in the real app:
// - copy with the whole heading selected copies the folded content too
//   (Markdown, plain text, HTML — code from the document, not the hidden DOM);
//   part of the heading copies only that text;
// - cut takes the section with it; pasting it into an empty line puts it back
//   byte for byte;
// - dragging the folded heading by its block handle moves the whole section
//   and keeps it folded where it lands.
// Saved bytes are checked after each step; no mismatch / pause toast.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-fold-section-'))
const file = join(root, 'doc.md')
const SECTION = ['## 第一节', '', '一节正文', '', '```js', 'const a = 1', '```', '', '### 小节A', '', 'A正文', ''].join('\n')
const HEAD = ['# 文档', '', '引言段', ''].join('\n')
const TAIL = ['## 第二节', '', '二节正文', '', '尾段', ''].join('\n')
const original = `${HEAD}\n${SECTION}\n${TAIL}`
await writeFile(file, original)
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), port: 29700 + process.pid % 100, appArgs: [file, '--horsemd-input-trace']
})
const send = (...args) => app.send(...args)
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const mod = process.platform === 'darwin' ? 4 : 2
const waitFor = async (check, message, attempts = 80) => {
  for (let i = 0; i < attempts; i += 1) { const value = await check(); if (value) return value; await sleep(100) }
  throw new Error(typeof message === 'function' ? await message() : message)
}
const mouse = (type, point, extra = {}) => send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point, ...extra })
// Pointer moves without a pressed button (a left-button move is a drag
// selection: Milkdown hides the block handle); one pixel first so Chromium
// does not coalesce two moves to the same point.
const hover = async (point) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 1, y: point.y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
  await sleep(300)
}
const click = async (point) => {
  await mouse('mouseMoved', point)
  await mouse('mousePressed', point)
  await mouse('mouseReleased', point)
  await sleep(250)
}
const block = (tag, value) => `[...(${editor}).children].find(n => n.matches(${JSON.stringify(tag)}) && n.textContent.trim() === ${JSON.stringify(value)})`
const textRect = (expression) => app.evaluate(`(() => {
  const node = ${expression}
  if (!node) return null
  node.scrollIntoView({ block: 'center' })
  const range = document.createRange()
  range.selectNodeContents(node)
  const r = [...range.getClientRects()].pop()
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, y: r.top + r.height / 2 }
})()`)
const shownBlocks = () => app.evaluate(`[...(${editor}).children]
  .filter(n => n.getClientRects().length)
  .map(n => n.matches('.milkdown-code-block') ? 'code' : n.textContent.trim())
  .join('|')`)
const toggles = () => app.evaluate(`[...document.querySelectorAll('.hm-fold-toggle')].map(b => {
  const r = b.getBoundingClientRect()
  return { folded: b.dataset.folded === 'true', x: r.left + r.width / 2, y: r.top + r.height / 2 }
})`)
const foldHeading = async (text) => {
  const r = await textRect(block('h2', text))
  await hover({ x: r.left + 4, y: r.y })
  const toggle = await waitFor(async () => (await toggles()).find((b) => Math.abs(b.y - r.y) < 12 && !b.folded) || null, `no fold toggle next to ${text}`)
  const folded = (await toggles()).filter((b) => b.folded).length
  await click(toggle)
  await waitFor(async () => (await toggles()).filter((b) => b.folded).length === folded + 1, `${text} did not fold`)
}
const save = async () => {
  await waitFor(() => app.evaluate("!!document.querySelector('.hm-save-fab')"), 'save button did not appear')
  const before = await readFile(file, 'utf8')
  await app.evaluate("document.querySelector('.hm-save-fab').click()")
  await waitFor(async () => (await readFile(file, 'utf8')) !== before, 'save did not write')
  return readFile(file, 'utf8')
}
const selectText = (tag, text, start, end) => app.evaluate(`(() => {
  const node = ${block(tag, text)}
  node.scrollIntoView({ block: 'center' }); (${editor}).focus()
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  const t = walker.nextNode()
  getSelection().setBaseAndExtent(t, ${start}, t, ${end} < 0 ? t.length : ${end})
})()`)
const keyboard = async (key, code, command) => {
  await app.evaluate('globalThis.__clip = null')
  for (const type of ['rawKeyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: code.charCodeAt(3), modifiers: mod, ...(type === 'rawKeyDown' ? { commands: [command] } : {}) })
  }
  return waitFor(() => app.evaluate('globalThis.__clip'), `${command} did not fill the clipboard`)
}
const paste = (payload) => app.evaluate(`(() => {
  const data = new DataTransfer()
  for (const [type, value] of Object.entries(${JSON.stringify(payload)})) if (value) data.setData(type === 'markdown' ? 'text/markdown' : type === 'plain' ? 'text/plain' : 'text/html', value)
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
  ;(${editor}).dispatchEvent(event)
  return event.defaultPrevented
})()`)
const caretAtEnd = async (tag, text) => {
  const r = await textRect(block(tag, text))
  await click({ x: r.right - 2, y: r.y })
  await pressKey(send, { key: 'End', code: 'End' })
}

try {
  await waitFor(async () => (await shownBlocks()).includes('尾段'), 'document did not open')
  await sleep(800)
  // Record what the copy / cut handlers write: the window capture listener
  // runs first and remembers the event; setData on its clipboardData is
  // recorded (the cut handler stops propagation inside the editor).
  await app.evaluate(`(() => {
    const proto = DataTransfer.prototype, set = proto.setData
    proto.setData = function (type, value) {
      set.call(this, type, value)
      const event = globalThis.__clipEvent
      if (event?.clipboardData === this) globalThis.__clip = { markdown: this.getData('text/markdown'), plain: this.getData('text/plain'), html: this.getData('text/html') }
    }
    for (const type of ['copy', 'cut']) window.addEventListener(type, (event) => { globalThis.__clipEvent = event }, true)
  })()`)
  await foldHeading('第一节')
  const FOLDED = '文档|引言段|第一节|第二节|二节正文|尾段'
  assert.equal(await shownBlocks(), FOLDED)

  // 1. Copy with the whole heading selected: the folded section comes along.
  await selectText('h2', '第一节', 0, -1)
  const copied = await keyboard('c', 'KeyC', 'copy')
  assert.equal(copied.markdown, SECTION, `copied markdown: ${JSON.stringify(copied.markdown)}`)
  for (const piece of ['第一节', '一节正文', 'const a = 1', '小节A', 'A正文']) {
    assert.ok(copied.plain.includes(piece), `plain text misses ${piece}: ${JSON.stringify(copied.plain)}`)
    assert.ok(copied.html.includes(piece), `html misses ${piece}`)
  }
  assert.ok(!copied.plain.includes('第二节'))
  assert.ok(!/hm-fold-hidden|display:\s*none/.test(copied.html), 'html carries the hidden state')
  // Part of the heading: just that text.
  await selectText('h2', '第一节', 0, 2)
  const partial = await keyboard('c', 'KeyC', 'copy')
  assert.equal(partial.plain, '第一')
  assert.ok(!partial.markdown.includes('一节正文'))
  assert.equal(await shownBlocks(), FOLDED, 'copying opened the fold')

  // 2. Cut takes the section; pasted into an empty line at the end it comes
  //    back byte for byte.
  await selectText('h2', '第一节', 0, -1)
  const cut = await keyboard('x', 'KeyX', 'cut')
  assert.equal(cut.markdown, SECTION)
  await waitFor(async () => (await shownBlocks()) === '文档|引言段|第二节|二节正文|尾段', async () => `cut left: ${await shownBlocks()}`)
  await caretAtEnd('p', '尾段')
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  assert.equal(await paste(cut), true, 'paste not handled')
  await waitFor(async () => (await shownBlocks()).endsWith('尾段|第一节|一节正文|code|小节A|A正文'), async () => `paste: ${await shownBlocks()}`)
  const moved = `${HEAD}\n${TAIL}\n${SECTION}`
  assert.equal(await save(), moved, 'cut + paste did not move the section byte for byte')

  // 3. Drag the folded heading by its block handle above 第二节: the whole
  //    section moves and stays folded.
  await foldHeading('第一节')
  assert.equal(await shownBlocks(), '文档|引言段|第二节|二节正文|尾段|第一节')
  const head = await textRect(block('h2', '第一节'))
  // The handle shows for the pointer in the leading gutter (block-handle guard).
  const gutterX = await app.evaluate(`(() => { const pm = ${editor}; const host = pm.closest('.editor-host'); return Math.max((host?.getBoundingClientRect().left ?? pm.getBoundingClientRect().left - 60) + 2, pm.getBoundingClientRect().left - 8) })()`)
  await hover({ x: gutterX, y: head.y })
  const grip = await waitFor(() => app.evaluate(`(() => {
    const handle = [...document.querySelectorAll('.milkdown-block-handle')].find((n) => n.dataset.show === 'true')
    const item = handle && [...handle.querySelectorAll('.operation-item')].pop()
    if (!item) return null
    const r = item.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`), 'block handle did not show')
  await hover(grip)
  await mouse('mousePressed', grip)
  const target = await textRect(block('h2', '第二节'))
  const dropped = await app.evaluate(`(() => {
    const handle = [...document.querySelectorAll('.milkdown-block-handle')].find((n) => n.dataset.show === 'true')
    const target = ${block('h2', '第二节')}
    const dataTransfer = new DataTransfer()
    handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
    const at = { clientX: ${target.left + 2}, clientY: ${target.top + 2} }
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, ...at }))
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, ...at })
    target.dispatchEvent(drop)
    handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }))
    return drop.defaultPrevented
  })()`)
  await mouse('mouseReleased', grip)
  assert.equal(dropped, true, 'drop not handled')
  await waitFor(async () => (await shownBlocks()) === FOLDED, async () => `after the drag: ${await shownBlocks()}`)
  await waitFor(async () => (await toggles()).filter((b) => b.folded).length === 1, 'the dragged section is not folded')
  assert.equal(await save(), original, 'dragging the folded section did not move it byte for byte')

  const toasts = await app.evaluate("[...document.querySelectorAll('.hm-toast-msg')].map(n => n.textContent).join('|')")
  assert.ok(!/不一致|暂停/.test(toasts), `unexpected toast: ${toasts}`)
  console.log('PASS folded section: copy / cut take the folded content (partial heading = text only), cut + paste and handle drag move it byte for byte, the dragged section stays folded')
} finally {
  await stopBuiltElectron(app)
}
