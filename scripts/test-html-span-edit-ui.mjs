// Editable <font>/<span> (Typora parity, Yuque exports): text inside an inline
// HTML wrapper takes a caret and a partial selection, typing lands inside the
// authored tags byte-exactly, Enter splits the span, bold applies inside it,
// and empty anchors / untouched spans keep their bytes through save + reopen.
// Before, `<font …>text</font>` was one locked atom: a click selected all of
// it and typing replaced it.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-html-span-'))
const file = join(root, 'spans.md')
const FONT1 = '<font style="color:rgb(31, 35, 41);">'
const FONT2 = '<font style="color:rgb(0, 0, 0);">'
const original = [
  '# Spans',
  '',
  `${FONT1}String 底层是 SDS，有 int、embstr、raw 三种编码；</font>`,
  '',
  `+ **${FONT2}单线程模型</font>**${FONT2}，CPU 密集型场景不适合；</font>`,
  '',
  '前文<span style="color:red">红色a*b文字</span>后文',
  '',
  '<span id="anchor"></span>锚点段落',
  '',
  'untouched <font color="blue">蓝色</font> line',
  '',
  // Milkdown's underscore emphasis input rule had no `$` anchor: `_x_` in
  // the inline code before the caret turned into emphasis on every keystroke.
  'A通过 `_<font style="color:rgb(0, 0, 0);">equals()</font>_` 比较相等',
  ''
].join('\n')
await writeFile(file, original)

const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (fn, label, attempts = 150) => {
  for (let i = 0; i < attempts; i++) { const v = await fn(); if (v) return v; await sleep(100) }
  throw new Error(label)
}
const launch = (port) => launchBuiltElectron({ profileDir: join(root, `profile-${port}`), port, appArgs: [file, '--horsemd-input-trace'] })
const warnings = (app) => app.evaluate(`[...document.querySelectorAll('.toast, [class*=toast], [role=dialog]')].map(n => n.innerText).filter((t) => /不一致|未被覆盖|mismatch|not overwritten/i.test(t))`)
// Screen point just before character `index` of the first occurrence of `needle`.
const pointBefore = (app, needle, index = 0) => app.evaluate(`(() => {
  const walk = document.createTreeWalker(${editor}, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walk.nextNode())) if (node.data.includes(${JSON.stringify(needle)})) break
  if (!node) return null
  const at = node.data.indexOf(${JSON.stringify(needle)}) + ${index}
  node.parentElement.scrollIntoView({ block: 'center' })
  const range = document.createRange(); range.setStart(node, at); range.setEnd(node, Math.min(at + 1, node.data.length))
  const r = range.getBoundingClientRect()
  return { x: r.left + 0.5, y: r.top + r.height / 2 }
})()`)
const mouse = (app, type, p, extra = {}) => app.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, ...extra })
const click = async (app, p) => { await mouse(app, 'mousePressed', p); await mouse(app, 'mouseReleased', p); await sleep(250) }
const drag = async (app, from, to) => {
  await mouse(app, 'mousePressed', from)
  for (let k = 1; k <= 6; k++) await mouse(app, 'mouseMoved', { x: from.x + (to.x - from.x) * k / 6, y: from.y + (to.y - from.y) * k / 6 }, { buttons: 1 })
  await mouse(app, 'mouseReleased', to)
  await sleep(250)
}
const selection = (app) => app.evaluate(`(() => { const s = getSelection(); return { collapsed: s.isCollapsed, text: s.toString(), inText: s.anchorNode?.nodeType === 3, node: Boolean(document.querySelector('.ProseMirror-selectednode')) } })()`)
const mod = process.platform === 'darwin' ? 4 : 2

const port = 29700 + process.pid % 50
let app = await launch(port)
try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('锚点段落')`), 'fixture did not open')
  await sleep(1000)
  assert.equal(await app.evaluate(`(${editor}).querySelectorAll('font.hm-html-span, span.hm-html-span').length`), 5, 'five editable spans render')
  assert.equal(await app.evaluate(`(${editor}).querySelector('font.hm-html-span')?.style.color`), 'rgb(31, 35, 41)', 'authored style applies')

  // 1. A click inside <font> puts a caret there; typing lands inside the tags.
  await click(app, await pointBefore(app, '，有 int'))
  const caret = await selection(app)
  assert.equal(caret.collapsed && caret.inText && !caret.node, true, `caret inside the font text: ${JSON.stringify(caret)}`)
  await typeTextLikeUser(app.send, 'XY', { delayMs: 90 })
  await sleep(800)

  // 2. A drag selects part of the span, not the whole atom.
  await drag(app, await pointBefore(app, 'CPU', 0), await pointBefore(app, 'CPU', 3))
  assert.equal((await selection(app)).text, 'CPU', 'drag selects part of the span')
  // ...and bold applies inside it.
  await pressKey(app.send, { key: 'b', code: 'KeyB', modifiers: mod })
  await sleep(800)

  // 3. Typing right after the last character of a span continues it.
  await click(app, await pointBefore(app, '后文', 0))
  await typeTextLikeUser(app.send, 'Z', { delayMs: 90 })
  await sleep(800)

  // 3b. Typing after inline code that holds `_…_` text types, nothing else.
  await click(app, await pointBefore(app, '相等', 1))
  await typeTextLikeUser(app.send, 'QW', { delayMs: 90 })
  await sleep(800)
  assert.equal(await app.evaluate(`[...(${editor}).querySelectorAll('p')].find((p) => p.textContent.includes('A通过')).textContent`),
    'A通过 _<font style="color:rgb(0, 0, 0);">equals()</font>_ 比较相QW等', 'typing after `_…_` inline code only inserts the text')

  // 4. Enter inside a span splits it into two spans.
  await click(app, await pointBefore(app, '是 SDS', 0))
  await pressKey(app.send, { key: 'Enter', code: 'Enter' })
  await sleep(1200)
  assert.deepEqual(await warnings(app), [], 'no mismatch warning while editing')

  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(async () => (await readFile(file, 'utf8')) !== original, 'save did not write')
  await sleep(500)
  assert.deepEqual(await warnings(app), [], 'save raised no warning')
  const saved = await readFile(file, 'utf8')
  assert.ok(saved.includes(`${FONT1}String 底层</font>`), `split keeps the first half's tags:\n${saved}`)
  assert.ok(saved.includes(`${FONT1}是 SDSXY，有 int、embstr、raw 三种编码；</font>`), `typed text inside the second half:\n${saved}`)
  assert.match(saved, new RegExp(`${FONT2.replace(/[()]/g, '\\$&')}，(?:\\*\\*CPU\\*\\*|</font>\\*\\*${FONT2.replace(/[()]/g, '\\$&')}CPU</font>\\*\\*${FONT2.replace(/[()]/g, '\\$&')})`), `bold applied inside the font:\n${saved}`)
  assert.ok(saved.includes('文字Z</span>后文'), `text typed at the span end continues it:\n${saved}`)
  assert.ok(saved.includes('<span id="anchor"></span>锚点段落'), 'empty anchor span kept')
  assert.ok(saved.includes('untouched <font color="blue">蓝色</font> line'), 'untouched span keeps its bytes')
  assert.ok(saved.includes('A通过 `_<font style="color:rgb(0, 0, 0);">equals()</font>_` 比较相QW等'), `inline code untouched, text typed:\n${saved}`)
  assert.ok(saved.includes(`+ **${FONT2}单线程模型</font>**`), 'bold font before the edit keeps its bytes')
  await stopBuiltElectron(app)

  // Reopen: same text, styles and bold; the span is still editable.
  app = await launch(port + 1)
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('锚点段落')`), 'saved file did not reopen')
  await sleep(800)
  const view = await app.evaluate(`(() => {
    const ed = ${editor}
    return {
      text: ed.textContent,
      spans: ed.querySelectorAll('font.hm-html-span, span.hm-html-span').length,
      boldInFont: [...ed.querySelectorAll('strong')].some((n) => n.textContent === 'CPU' && n.closest('font, .hm-html-span')) ||
        [...ed.querySelectorAll('font.hm-html-span')].some((n) => n.textContent === 'CPU' && n.closest('strong'))
    }
  })()`)
  for (const text of ['String 底层', '是 SDSXY，有', '红色a*b文字Z', '锚点段落']) assert.ok(view.text.includes(text), `reopened text has ${text}`)
  assert.equal(view.boldInFont, true, 'CPU is bold and coloured after reopen')
  assert.ok(view.spans >= 6, `spans after reopen: ${view.spans}`)
  await click(app, await pointBefore(app, '蓝色', 1))
  const again = await selection(app)
  assert.equal(again.collapsed && again.inText && !again.node, true, 'still editable after reopen')
  assert.deepEqual(await warnings(app), [], 'no warning after reopen')
  console.log('PASS html span: caret + partial selection inside <font>/<span>, byte-exact typing, split, bold, anchors and untouched spans kept through save + reopen')
} finally {
  await stopBuiltElectron(app)
}
