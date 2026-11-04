// `<kbd>Esc</kbd>` (and other phrasing tags: <u>, <b>, <sub> …) rendered but
// was one locked HTML atom: changing the key meant switching to source mode.
// They are now editable spans (html_span, like <font>/<span>): click in,
// type, delete; the authored tags are kept byte for byte. Locked here, in a
// CRLF file: typing / deleting inside a key, two adjacent keys staying two
// keys, keys in a list item and a table cell, a pair nested in a key staying
// raw HTML, <u>/<b> editing, save, and reopen.
//
// Keys edit like inline code (editor-html-token-editing.js): typed
// `<kbd>Esc</kbd>` stays text until the closing tag, then typing continues
// AFTER the key (Air trace 2026-11-01: Enter + Backspace put the caret back
// at the key's end and `aef` went into the key); at a key edge the caret is
// outside unless the user went in (click on the key, ←/→ across the tag),
// and the grey `<kbd>` `</kbd>` tags show while it is inside. <u>/<font>
// keep continuing at their end (inclusive, like bold).
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { pressKey } from './lib/human-input.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-kbd-'))
const pm = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`
const DOC = [
  '# 快捷键',
  '',
  '按 <kbd>Esc</kbd> 退出。',
  '',
  '复制 <kbd>Ctrl</kbd>+<kbd>C</kbd>，粘贴 <kbd>Ctrl</kbd><kbd>V</kbd> 完。',
  '',
  '- 列表里 <kbd>Tab</kbd> 缩进',
  '',
  '| 操作 | 按键 |',
  '| --- | --- |',
  '| 保存 | <kbd>Ctrl</kbd>+<kbd>S</kbd> |',
  '',
  '嵌套 <kbd><b>Shift</b></kbd> 键，<u>下划线</u> 与 <b>粗体</b>。',
  '',
  '<kbd>Home</kbd> 开头',
  '',
  '新行：',
  ''
].join('\r\n')

const file = join(root, 'kbd.md')
await fs.writeFile(file, DOC)
const port = 9400 + Math.floor(Math.random() * 100)
let app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file, '--horsemd-input-trace'] })
const evaluate = (expression) => app.evaluate(expression)
const keys = () => evaluate(`[...(${pm}).querySelectorAll('kbd')].map((n) => n.textContent + (n.closest('[contenteditable=false]') ? '(locked)' : ''))`)
const waitDoc = async () => {
  for (let i = 0; i < 80; i += 1) {
    if (await evaluate(`Boolean((${pm})?.pmViewDesc) && Boolean(globalThis.__hmSourceReprintHarness)`)) break
    await sleep(150)
  }
  await sleep(700)
}
// dx: horizontal offset from the caret spot (negative = left of it, e.g.
// inside a key's box at its end; +1 right after the box is outside the key).
const clickAt = async (text, offset, nth = 0, dx = 1) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const point = await evaluate(`((text, offset, nth, dx) => {
      const walker = document.createTreeWalker(${pm}, NodeFilter.SHOW_TEXT)
      let k = 0
      while (walker.nextNode()) {
        const node = walker.currentNode
        const at = node.nodeValue.indexOf(text)
        if (at < 0 || k++ < nth) continue
        node.parentElement.scrollIntoView({ block: 'center' })
        const range = document.createRange(); range.setStart(node, at + offset); range.collapse(true)
        const rect = range.getClientRects()[0] || node.parentElement.getBoundingClientRect()
        return { x: Math.round(rect.left + dx), y: Math.round(rect.top + rect.height / 2) }
      }
      return null
    })(${JSON.stringify(text)}, ${offset}, ${nth}, ${dx})`)
    assert.ok(point, `text on screen: ${text}`)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    await sleep(200)
  }
}
const type = async (text) => { for (const ch of [...text]) { await app.send('Input.insertText', { text: ch }); await sleep(40) } }
const key = (name) => pressKey(app.send, { key: name })
const tags = () => evaluate(`[...document.querySelectorAll('.hm-html-token-tag')].map((n) => n.textContent).join(' ')`)
const domInKey = () => evaluate(`(() => { const n = getSelection().anchorNode; const e = n?.nodeType === 1 ? n : n?.parentElement; return Boolean(e?.closest('kbd')) })()`)
const lineOf = (source, start) => source.split(/\r\n/).find((l) => l.startsWith(start))
const check = async (label) => {
  await sleep(1200)
  const toasts = await evaluate('window.__toasts.slice()')
  assert.deepEqual(toasts.filter((t) => /不一致|无法安全/.test(t)), [], `${label}: no mismatch warning`)
  const state = await evaluate(`(() => { const h = globalThis.__hmSourceReprintHarness; const s = h.liveSource(); return { source: s, equivalent: h.equivalent(s, h.liveDoc()) } })()`)
  assert.equal(state.equivalent, true, `${label}: the source parses to the editor's document:\n${state.source}`)
  return state.source
}

try {
  await waitDoc()
  await evaluate(`(() => { window.__toasts = []; const seen = new WeakSet(); new MutationObserver(() => { for (const n of document.querySelectorAll('.hm-toast-msg')) { if (!seen.has(n)) { seen.add(n); window.__toasts.push(n.textContent) } } }).observe(document.body, { childList: true, subtree: true }) })()`)

  // 1. Every key renders as an editable <kbd>; adjacent keys stay two.
  assert.deepEqual(await keys(), ['Esc', 'Ctrl', 'C', 'Ctrl', 'V', 'Tab', 'Ctrl', 'S', 'Shift', 'Home'], 'keys render, editable')
  assert.equal(await evaluate(`Boolean([...(${pm}).querySelectorAll('kbd b')].length)`), true, 'the <b> nested in a key renders inside it')

  // 2. Type inside a key, then delete a letter of another.
  await clickAt('Esc', 3, 0, -2)
  await type('ape')
  let source = await check('typing inside <kbd>')
  assert.match(source, /按 <kbd>Escape<\/kbd> 退出。\r\n/, source)
  await clickAt('Tab', 3, 0, -2)
  await key('Backspace')
  await type('b')
  source = await check('Backspace inside <kbd>')
  assert.match(source, /- 列表里 <kbd>Tab<\/kbd> 缩进\r\n/, source)

  // 3. The second of two adjacent keys: still two keys.
  await clickAt('V', 1, 0, -2)
  await type('2')
  source = await check('typing in the second of two adjacent keys')
  assert.match(source, /粘贴 <kbd>Ctrl<\/kbd><kbd>V2<\/kbd> 完。\r\n/, source)
  assert.deepEqual((await keys()).slice(3, 5), ['Ctrl', 'V2'])

  // 4. A key in a table cell; <u> and <b> are editable too.
  await clickAt('S', 1, 0, -2)
  await type('ave')
  await clickAt('下划线', 3)
  await type('文字')
  await clickAt('粗体', 2)
  await type('字')
  source = await check('table cell key, <u>, <b>')
  assert.match(source, /\| 保存 \| <kbd>Ctrl<\/kbd>\+<kbd>Save<\/kbd> \|\r\n/, source)
  assert.match(source, /嵌套 <kbd><b>Shift<\/b><\/kbd> 键，<u>下划线文字<\/u> 与 <b>粗体字<\/b>。\r\n/, source)

  // 5. Typing a key: `<kbd>` stays text, the closing tag makes the key and
  //    the next characters go after it.
  await clickAt('新行：', 3)
  await type('按 <kbd>')
  assert.equal(await evaluate(`[...(${pm}).querySelectorAll('.hm-html-inline')].some((n) => /^<kbd>$/.test(n.textContent))`), false, 'a lone <kbd> stays text')
  await type('Esc</kbd>')
  assert.equal(await tags(), '', 'no tags after the key is closed (caret outside)')
  assert.equal(await domInKey(), false, 'DOM caret outside the new key')
  await type(' 后')
  source = await check('typing after a closed key')
  assert.equal(lineOf(source, '新行：'), '新行：按 <kbd>Esc</kbd> 后', source)
  // The Air repro: Enter + Backspace back to the key's end, then type.
  await clickAt(' 后', 0)
  await key('Enter')
  await key('Backspace')
  assert.equal(await tags(), '', 'caret back at the key end is outside')
  await type('aef')
  source = await check('typing at a key end after Enter + Backspace')
  assert.equal(lineOf(source, '新行：'), '新行：按 <kbd>Esc</kbd>aef 后', source)

  // 6. ← from outside crosses the tag into the key (tags shown), → leaves.
  await clickAt('aef', 0)
  assert.equal(await tags(), '', 'click right after the key: outside')
  await key('ArrowLeft')
  assert.equal(await tags(), '<kbd> </kbd>', '← enters the key: tags shown')
  assert.equal(await domInKey(), true, 'DOM caret inside the key')
  await type('ape')
  await key('ArrowRight')
  assert.equal(await tags(), '', '→ at the key end leaves it')
  assert.equal(await domInKey(), false, 'DOM caret outside after →')
  await type('!')
  source = await check('arrows across the key tags')
  assert.equal(lineOf(source, '新行：'), '新行：按 <kbd>Escape</kbd>!aef 后', source)
  // → from inside the text stops at the key end (inside) before leaving.
  await clickAt('Escape', 4, 1)
  assert.equal(await tags(), '<kbd> </kbd>', 'click inside: tags shown')
  await key('ArrowRight')
  await key('ArrowRight')
  assert.equal(await tags(), '<kbd> </kbd>', 'at the key end, still inside')
  await type('s')
  await key('Backspace')
  await key('Backspace')
  assert.equal(await tags(), '<kbd> </kbd>', 'Backspace inside keeps the caret inside')
  await type('E')
  source = await check('editing at the key end')
  assert.equal(lineOf(source, '新行：'), '新行：按 <kbd>EscapE</kbd>!aef 后', source)

  // 7. Between two keys: outside; a key at the line start: Home is outside.
  await clickAt('V2', 0)
  assert.equal(await tags(), '<kbd> </kbd>', 'click at the start of the second key: inside it')
  await key('ArrowLeft')
  assert.equal(await tags(), '', 'between the keys: outside')
  await type('+')
  // Deleting what separates two identical keys keeps two keys (ProseMirror
  // would join equal marks into one `CtrlC`), as in Typora / Obsidian.
  await clickAt('+', 1)
  await key('Backspace')
  source = await check('typing between keys, deleting the separator')
  assert.match(source, /复制 <kbd>Ctrl<\/kbd><kbd>C<\/kbd>，粘贴 <kbd>Ctrl<\/kbd>\+<kbd>V2<\/kbd> 完。\r\n/, source)
  assert.deepEqual((await keys()).slice(1, 5), ['Ctrl', 'C', 'Ctrl', 'V2'])
  await clickAt('Home', 2)
  await key('ArrowLeft')
  await key('ArrowLeft')
  assert.equal(await tags(), '<kbd> </kbd>', '← to the start of a line-start key: still inside')
  await key('ArrowLeft')
  assert.equal(await tags(), '', '← again: before the key, outside')
  assert.equal(await domInKey(), false, 'DOM caret before the key')
  if (process.platform !== 'darwin') {
    await clickAt('Home', 2)
    await key('Home')
    assert.equal(await tags(), '', 'Home before a line-start key: outside')
  }
  await type('按')
  // IME composition outside a key end.
  await clickAt(' 开头', 0)
  await app.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
  await sleep(150)
  await app.send('Input.insertText', { text: '中' })
  await sleep(200)
  source = await check('between keys, line start, IME after a key')
  assert.equal(lineOf(source, '按<kbd>'), '按<kbd>Home</kbd>中 开头', source)

  // 8. <u> still continues at its end (inclusive), no tags shown.
  await clickAt('下划线文字', 5)
  assert.equal(await tags(), '', 'no tags for <u>')
  await type('呀')
  source = await check('<u> end')
  assert.match(source, /<u>下划线文字呀<\/u>/, source)

  // 9. Save and reopen: the same keys, the file still CRLF.
  await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  for (let i = 0; i < 40 && (await fs.readFile(file, 'utf8')) === DOC; i += 1) await sleep(150)
  const saved = await fs.readFile(file, 'utf8')
  assert.equal(saved, source, 'saved bytes are the synced source')
  assert.doesNotMatch(saved, /(^|[^\r])\n/, 'CRLF kept')
  await stopBuiltElectron(app, { removeProfile: true })
  app = await launchBuiltElectron({ profileDir: join(root, 'profile2'), port: port + 1, appArgs: [file, '--horsemd-input-trace'] })
  await waitDoc()
  assert.deepEqual(await keys(), ['Escape', 'Ctrl', 'C', 'Ctrl', 'V2', 'Tab', 'Ctrl', 'Save', 'Shift', 'Home', 'EscapE'], 'keys after reopen')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await fs.rm(root, { recursive: true, force: true })
}
console.log('PASS kbd edit: <kbd> keys edit like inline code — typed key closes with the caret after it, edges outside unless entered (click / arrows), grey tags inside, Backspace, adjacent keys, IME, <u> inclusive, CRLF bytes, save and reopen')
