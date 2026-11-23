// Editing existing inline code and <kbd> keys (editor-html-token-editing.js;
// user report 2026-11-22: "adding or deleting a character at the start or
// end of inline code is a pain; a click shows the backticks but arrows into
// it do not; with a Chinese IME, changing a key's name goes wrong").
// Real editor, real input (mouse, keys, IME composition through CDP):
//   1. mouse or arrows into inline code: the backticks show either way;
//   2. a click at the START of inline code types at its start;
//   3. ← from just after inline code enters at its end, typing appends;
//      → at its end leaves it, typing goes after;
//   4. IME inside inline code (middle, end, start): the composed text once,
//      inside the code (it used to be torn apart: `ab` → `aabab`);
//   5. IME at the end of a key, twice in a row: both words in the key (the
//      second used to land after the key), also after a Backspace;
// every step: the source reads back as the editor's document, no warning;
// then save, reopen: the same text.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { pressKey } from './lib/human-input.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-token-edit-'))
const pm = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`
const LINES = {
  c1: '甲 `alpha one` 尾一。',
  c2: '乙 `beta two` 尾二。',
  c3: '丙 `gamma three` 尾三。',
  c4: '丁 `delta four` 尾四。',
  c5: '戊 `eps five` 尾五。',
  k1: '己 <kbd>Esc</kbd> 尾六。',
  k2: '庚 <kbd>Tab</kbd> 尾七。'
}
const DOC = ['# 编辑', '', ...Object.values(LINES).flatMap((l) => [l, '']), '末行', ''].join('\n')
const file = join(root, 'tokens.md')
await fs.writeFile(file, DOC)
const port = 9620 + Math.floor(Math.random() * 60)
let app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file, '--horsemd-input-trace'] })
const ev = (expression) => app.evaluate(expression)
const key = (name) => pressKey(app.send, { key: name })
const type = async (text) => { for (const ch of [...text]) { await app.send('Input.insertText', { text: ch }); await sleep(45) } }
// IME: the composition grows one key at a time, then the candidate commits.
const ime = async (keys, commit) => {
  for (let i = 1; i <= keys.length; i++) {
    const text = keys.slice(0, i)
    await app.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
    await sleep(70)
  }
  await app.send('Input.insertText', { text: commit })
  await sleep(350)
}
// Click `dx` px from the caret spot before character `offset` of `text`.
const clickAt = async (text, offset, dx) => {
  const point = await ev(`((text, offset, dx) => {
    const walker = document.createTreeWalker(${pm}, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const at = node.nodeValue.indexOf(text)
      if (at < 0) continue
      node.parentElement.scrollIntoView({ block: 'center' })
      const range = document.createRange(); range.setStart(node, at + offset); range.collapse(true)
      const rect = range.getClientRects()[0]
      return rect ? { x: Math.round(rect.left + dx), y: Math.round(rect.top + rect.height / 2) } : null
    }
    return null
  })(${JSON.stringify(text)}, ${offset}, ${dx})`)
  assert.ok(point, `text on screen: ${text}`)
  for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type: t, ...point, button: 'left', clickCount: 1 })
  await sleep(250)
}
const ticks = () => ev(`document.querySelectorAll('.hm-inline-code-delimiter').length`)
const tags = () => ev(`[...document.querySelectorAll('.hm-html-token-tag')].map((n) => n.textContent).join(' ')`)
const check = async (label, prefix, expected) => {
  await sleep(900)
  const state = await ev(`(() => { const h = globalThis.__hmSourceReprintHarness; const s = h.liveSource()
    return { source: s, equivalent: h.equivalent(s, h.liveDoc()), toasts: [...document.querySelectorAll('.hm-toast-msg')].map((n) => n.textContent) } })()`)
  assert.deepEqual(state.toasts.filter((t) => /不一致|无法安全/.test(t)), [], `${label}: no mismatch warning`)
  assert.equal(state.equivalent, true, `${label}: the source reads back as the editor's document:\n${state.source}`)
  const line = state.source.split('\n').find((l) => l.startsWith(prefix))
  assert.equal(line, expected, `${label}`)
  console.log(`  ✓ ${label}: ${line}`)
  return state.source
}

try {
  for (let i = 0; i < 80; i++) {
    if (await ev(`Boolean((${pm})?.pmViewDesc) && Boolean(globalThis.__hmSourceReprintHarness)`)) break
    await sleep(150)
  }
  await sleep(1000)

  // 1. Mouse or arrows: the backticks show either way.
  await clickAt('alpha one', 3, 0)
  assert.equal(await ticks(), 2, 'a click in inline code shows the backticks')
  await clickAt('尾一', 0, 2)
  assert.equal(await ticks(), 0, 'outside: no backticks')
  await key('ArrowLeft') // ' 尾一' → before the space
  await key('ArrowLeft') // crosses into the code's end
  assert.equal(await ticks(), 2, 'arrows into inline code show the backticks too')
  await key('ArrowLeft')
  assert.equal(await ticks(), 2, 'still inside')
  console.log('  ✓ backticks show for a click and for arrows')

  // 2. A click at the start of inline code types at its start.
  await clickAt('beta two', 0, 2)
  assert.equal(await ticks(), 2, 'a click at the start of inline code is inside')
  await type('x')
  await check('typing at the start of inline code', '乙', '乙 `xbeta two` 尾二。')

  // 3. ← from just after inline code enters at its end; → leaves it.
  await clickAt('尾三', 0, 2)
  await key('ArrowLeft') // before the space: right after the code, outside
  assert.equal(await ticks(), 0, 'right after the code: outside')
  await key('ArrowLeft')
  assert.equal(await ticks(), 2, '← from after the code: inside at its end')
  await type('s')
  await check('typing at the end after ←', '丙', '丙 `gamma threes` 尾三。')
  await key('ArrowRight')
  assert.equal(await ticks(), 0, '→ at the end: outside')
  await type('!')
  await check('→ then typing goes after the code', '丙', '丙 `gamma threes`! 尾三。')
  await key('Backspace')
  await key('Backspace')
  await check('Backspace from outside deletes the code\'s last character', '丙', '丙 `gamma three` 尾三。')

  // 4. IME inside inline code: middle, end, start.
  await clickAt('delta four', 5, 0)
  await ime('xi', '西')
  await check('IME in the middle of inline code', '丁', '丁 `delta西 four` 尾四。')
  await clickAt('eps five', 8, -2)
  assert.equal(await ticks(), 2, 'click at the code end: inside')
  await ime('ab', 'ab')
  await check('IME at the end of inline code (once, inside)', '戊', '戊 `eps fiveab` 尾五。')
  await ime('cd', 'cd')
  await check('a second IME word at the end stays inside', '戊', '戊 `eps fiveabcd` 尾五。')
  await clickAt('eps five', 0, 2)
  await ime('zhong', '中')
  await check('IME at the start of inline code', '戊', '戊 `中eps fiveabcd` 尾五。')

  // 5. IME at the end of a key, twice; and after a Backspace.
  await clickAt('Esc', 3, -2)
  assert.equal(await tags(), '<kbd> </kbd>', 'click at the key end: inside')
  await ime('ape', 'ape')
  await check('IME at the end of a key', '己', '己 <kbd>Escape</kbd> 尾六。')
  assert.equal(await tags(), '<kbd> </kbd>', 'still inside after the commit')
  await ime('ctrl', 'ctrl')
  await check('a second IME word stays in the key', '己', '己 <kbd>Escapectrl</kbd> 尾六。')
  await clickAt('Tab', 3, -2)
  await key('Backspace')
  await ime('x', 'x')
  await check('IME after a Backspace at the key end', '庚', '庚 <kbd>Tax</kbd> 尾七。')
  await key('ArrowRight')
  assert.equal(await tags(), '', '→ leaves the key')
  await ime('ni', '你')
  await check('IME after leaving the key goes after it', '庚', '庚 <kbd>Tax</kbd>你 尾七。')

  // Save, reopen: the same text.
  const expected = await ev('globalThis.__hmSourceReprintHarness.liveSource()')
  await ev(`document.querySelector('.hm-save-fab')?.click()`)
  for (let i = 0; i < 40 && (await fs.readFile(file, 'utf8')) === DOC; i++) await sleep(150)
  assert.equal(await fs.readFile(file, 'utf8'), expected, 'saved bytes are the synced source')
  await stopBuiltElectron(app, { removeProfile: true })
  app = await launchBuiltElectron({ profileDir: join(root, 'profile2'), port: port + 1, appArgs: [file, '--horsemd-input-trace'] })
  for (let i = 0; i < 80; i++) {
    if (await app.evaluate(`Boolean(globalThis.__hmSourceReprintHarness)`)) break
    await sleep(150)
  }
  await sleep(1000)
  const reopened = await app.evaluate(`(() => { const h = globalThis.__hmSourceReprintHarness; const s = h.liveSource(); return { s, eq: h.equivalent(s, h.liveDoc()) } })()`)
  assert.equal(reopened.s, expected, 'reopened source is the saved text')
  assert.equal(reopened.eq, true, 'reopened document matches its source')
  console.log('PASS token edit: inline code / <kbd> edges by mouse and arrows (backticks either way), typing at the start and end, IME inside (middle, end, start, twice), save and reopen')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await fs.rm(root, { recursive: true, force: true })
}
