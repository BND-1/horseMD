// Part of one list item's text, copied with Ctrl/Cmd+C, put the list marker
// into text/markdown ("- pha **bold** om" / "1. …"): selection.content()
// keeps the list and list-item ancestors. md-paste prefers that flavor, so
// pasting it into another item added a nested item instead of the text.
// A selection inside one paragraph must copy only its inline content; a
// selection across items still copies as a list. A whole item (e.g. one
// line of an ordered list) pasted into another list item inserts only its
// text; two or more items paste as a list.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-list-copy-'))
const file = join(root, 'lists.md')
const original = ['# Lists', '', '- alpha **bold** omega', '- target', '- other', '',
  '1. first *em* item', '2. goal', '3. third', '', '> quote **q** text', '', 'plain end', ''].join('\n')
await writeFile(file, original)
const inspectPort = 9400 + process.pid % 200
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port: 28900 + process.pid % 300, appArgs: [file, '--horsemd-input-trace', `--inspect=${inspectPort}`]
})
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (fn, label) => {
  for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(80) }
  throw new Error(label)
}
// Menu accelerators can't be fired over CDP: click the menu item in main.
const mainMenu = async (label) => {
  const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
  const ws = new WebSocket(list[0].webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  const expr = `(() => { const { Menu } = require('electron'); const find = (items) => { for (const it of items) { if (it.label === ${JSON.stringify(label)}) return it; if (it.submenu) { const f = find(it.submenu.items); if (f) return f } } }; const it = find(Menu.getApplicationMenu().items); it.click(); return !!it })()`
  const done = new Promise((resolve) => ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d) }))
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, includeCommandLineAPI: true } }))
  const res = await done
  ws.close()
  return res.result?.result?.value
}
const keyboardCopy = async () => {
  await app.evaluate('globalThis.__copyPayload = null')
  for (const type of ['rawKeyDown', 'keyUp']) await app.send('Input.dispatchKeyEvent', {
    type, key: 'c', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67,
    modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['copy']
  })
  return waitFor(() => app.evaluate('globalThis.__copyPayload'), 'Cmd/Ctrl+C did not copy')
}
// Select inside the paragraph whose text is `text`: from `start` in its first
// text node to `end` in its last one.
const selectIn = (selector, text, start, end) => app.evaluate(`(() => {
  const p = [...(${editor}).querySelectorAll(${JSON.stringify(selector)})].find(n => n.textContent === ${JSON.stringify(text)})
  p.scrollIntoView({ block: 'center' }); (${editor}).focus()
  const first = p.firstChild, last = p.lastChild
  getSelection().setBaseAndExtent(first, ${start}, last, ${end} < 0 ? last.length : ${end})
})()`)
const caretAtEnd = (selector, text) => app.evaluate(`(() => {
  const p = [...(${editor}).querySelectorAll(${JSON.stringify(selector)})].find(n => n.textContent === ${JSON.stringify(text)})
  ;(${editor}).focus(); const t = p.lastChild; getSelection().setBaseAndExtent(t, t.length, t, t.length)
})()`)
const paste = (payload) => app.evaluate(`(() => {
  const data = new DataTransfer()
  data.setData('text/markdown', ${JSON.stringify(payload.markdown)})
  data.setData('text/plain', ${JSON.stringify(payload.plain)})
  data.setData('text/html', ${JSON.stringify(payload.html)})
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
  ;(${editor}).dispatchEvent(event)
  return event.defaultPrevented
})()`)
const items = (tag) => app.evaluate(`[...(${editor}).querySelectorAll(${JSON.stringify(tag + ' > .milkdown-list-item-block > li')})].map(li => li.querySelector('p')?.textContent)`)
try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('plain end')`), 'fixture did not open')
  await sleep(1500)
  await app.evaluate(`document.addEventListener('copy', event => {
    globalThis.__copyPayload = { plain: event.clipboardData.getData('text/plain'),
      html: event.clipboardData.getData('text/html'), markdown: event.clipboardData.getData('text/markdown') }
  })`)

  // Bullet item: "pha " + bold "bold" + " om".
  await selectIn('ul li p', 'alpha bold omega', 2, 3)
  await sleep(150)
  const bullet = await keyboardCopy()
  assert.equal(bullet.plain, 'pha bold om')
  assert.match(bullet.markdown, /^pha \*\*bold\*\* om\s*$/, `bullet partial markdown: ${JSON.stringify(bullet.markdown)}`)
  assert.doesNotMatch(bullet.html, /<li/, 'bullet partial copy put a list item into text/html')
  await caretAtEnd('ul li p', 'target')
  await sleep(150)
  assert.equal(await paste(bullet), true, 'bullet paste not handled')
  await sleep(500)
  assert.deepEqual(await items('ul'), ['alpha bold omega', 'targetpha bold om', 'other'])

  // Ordered item: "rst " + em "em" + " it".
  await selectIn('ol li p', 'first em item', 2, 3)
  await sleep(150)
  const ordered = await keyboardCopy()
  assert.equal(ordered.plain, 'rst em it')
  assert.match(ordered.markdown, /^rst \*em\* it\s*$/, `ordered partial markdown: ${JSON.stringify(ordered.markdown)}`)
  await caretAtEnd('ol li p', 'goal')
  await sleep(150)
  assert.equal(await paste(ordered), true, 'ordered paste not handled')
  await sleep(500)
  assert.deepEqual(await items('ol'), ['first em item', 'goalrst em it', 'third'])

  // Blockquote: part of the quoted line copies without "> ".
  await selectIn('blockquote p', 'quote q text', 2, 2)
  await sleep(150)
  const quote = await keyboardCopy()
  assert.match(quote.markdown, /^ote \*\*q\*\* t\s*$/, `quote partial markdown: ${JSON.stringify(quote.markdown)}`)

  // Across two items still copies as a list.
  await app.evaluate(`(() => {
    const ps = [...(${editor}).querySelectorAll('ul li p')]
    ;(${editor}).focus(); getSelection().setBaseAndExtent(ps[1].firstChild, 0, ps[2].firstChild, ps[2].firstChild.length)
  })()`)
  await sleep(150)
  const across = await keyboardCopy()
  assert.match(across.markdown, /^[-*] targetpha/m, `multi-item copy lost its list markdown: ${JSON.stringify(across.markdown)}`)

  // The whole text of one item still copies as that item (#98).
  await selectIn('ol li p', 'third', 0, -1)
  await sleep(150)
  const whole = await keyboardCopy()
  assert.match(whole.markdown, /^\d+\.\s+third\s*$/, `whole-item copy lost its list markdown: ${JSON.stringify(whole.markdown)}`)

  // ...but pasted into ANOTHER list item it inserts only its text: a whole
  // line copied from an ordered list and pasted into a bullet item must not
  // bring "3." along or nest an item.
  await caretAtEnd('ul li p', 'other')
  await sleep(150)
  assert.equal(await paste(whole), true, 'whole-item paste not handled')
  await sleep(500)
  assert.deepEqual(await items('ul'), ['alpha bold omega', 'targetpha bold om', 'otherthird'])

  // Two or more items keep their list structure when pasted into an item.
  await caretAtEnd('ol li p', 'third')
  await sleep(150)
  assert.equal(await paste(across), true, 'multi-item paste not handled')
  await sleep(500)
  const pastedItems = await app.evaluate(`[...(${editor}).querySelectorAll('ol li ul > .milkdown-list-item-block > li')].map(li => li.querySelector('p')?.textContent)`)
  assert.deepEqual(pastedItems, ['targetpha bold om', 'other'], 'multi-item paste lost its list structure')

  assert.equal(await mainMenu('Save'), true, 'Save menu item not found')
  await sleep(1500)
  const saved = await readFile(file, 'utf8')
  assert.equal(saved, original
    .replace('- target', '- targetpha **bold** om')
    .replace('- other', '- otherthird')
    .replace('2. goal', '2. goalrst *em* it')
    .replace('3. third\n', '3. third\n\n   - targetpha **bold** om\n   - other\n'), `saved bytes:\n${saved}`)
  const toasts = await app.evaluate(`[...document.querySelectorAll('.toast, [class*=toast], [role=dialog]')].map(n => n.innerText).filter(Boolean)`)
  assert.ok(!toasts.some((t) => /不一致|未被覆盖|mismatch|not overwritten/i.test(t)), `warning shown: ${JSON.stringify(toasts)}`)
  console.log('PASS list partial copy: text inside one list item / quote copies without its marker; a whole item pasted into another item inserts only its text; multi-item copy/paste stays a list; save exact')
} finally {
  await stopBuiltElectron(app)
}
