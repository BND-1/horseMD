// Code-block language picker accepts any name (Typora parity). Milkdown's
// picker only selected from its list: Enter in the search box did nothing and
// an unknown name showed "No result", so a niche language could not be set.
// Enter, or a click on the "Use …" row, now sets the typed name as the fence
// info string. Real mouse + keyboard input; save, exact bytes, cold reopen.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-code-lang-'))
const file = join(root, 'code.md')
const original = ['# Code', '', '```js', 'const a = 1', '```', '', 'middle', '', '```', 'plain block', '```', '',
  '```python', 'print(1)', '```', '', 'end', ''].join('\n')
await writeFile(file, original)
const inspectPort = 9600 + process.pid % 200
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (fn, label) => {
  for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(80) }
  throw new Error(label)
}
const launch = () => launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port: 29100 + process.pid % 300, appArgs: [file, '--horsemd-input-trace', `--inspect=${inspectPort}`]
})
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

let app = await launch()
const click = async (expr) => {
  const at = await app.evaluate(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  assert.ok(at, `nothing to click: ${expr}`)
  await sleep(120)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await app.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  }
}
const block = (i) => `(${editor}).querySelectorAll('.milkdown-code-block')[${i}]`
const buttonText = (i) => app.evaluate(`${block(i)}.querySelector('.language-button').textContent.trim()`)
const openPicker = async (i) => {
  await click(`${block(i)}.querySelector('.language-button')`)
  await waitFor(() => app.evaluate(`document.activeElement?.matches?.('.search-input') && ${block(i)}.contains(document.activeElement)`), 'search box not focused')
}
const type = (text) => app.send('Input.insertText', { text })
const pressEnter = async () => {
  for (const t of ['rawKeyDown', 'char', 'keyUp']) {
    await app.send('Input.dispatchKeyEvent', { type: t, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(t === 'char' ? { text: '\r' } : {}) })
  }
}
const pickerOpen = (i) => app.evaluate(`!!${block(i)}.querySelector('.language-picker .list-wrapper')`)
try {
  await waitFor(() => app.evaluate(`(${editor})?.querySelectorAll('.milkdown-code-block .language-button').length === 3`), 'fixture did not open')
  await sleep(1500)

  // 1. Unknown name + Enter.
  await openPicker(0)
  const placeholder = await app.evaluate('document.activeElement.placeholder')
  await type('zig')
  await sleep(250)
  const row = await app.evaluate(`${block(0)}.querySelector('.language-list-item.no-result')?.textContent`)
  assert.match(row || '', /zig/, `no-result row not relabelled: ${JSON.stringify(row)}`)
  await pressEnter()
  await waitFor(async () => (await buttonText(0)) === 'zig', `Enter did not set the language (button: ${await buttonText(0)})`)
  assert.equal(await pickerOpen(0), false, 'picker stayed open after Enter')

  // 2. Unknown name + click on the "Use …" row (block without a language).
  await openPicker(1)
  await type('vhdl-2008x')
  await sleep(250)
  await click(`${block(1)}.querySelector('.language-list-item.no-result')`)
  await waitFor(async () => (await buttonText(1)) === 'vhdl-2008x', 'click on the row did not set the language')

  // 3. A known alias typed in full keeps what was typed ("py").
  await openPicker(2)
  await type('py')
  await sleep(250)
  await pressEnter()
  await waitFor(async () => (await buttonText(2)) === 'py', 'alias was not kept')

  // Picking from the list still works.
  await openPicker(2)
  await type('rust')
  await sleep(250)
  await click(`${block(2)}.querySelector('.language-list-item[data-language="Rust"]')`)
  await waitFor(async () => (await buttonText(2)) === 'Rust', 'list click no longer sets the language')

  assert.equal(await mainMenu('Save'), true, 'Save menu item not found')
  await sleep(1500)
  const saved = await readFile(file, 'utf8')
  const expected = original.replace('```js', '```zig').replace('```\nplain block', '```vhdl-2008x\nplain block').replace('```python', '```Rust')
  assert.equal(saved, expected, `saved bytes:\n${saved}`)
  const toasts = await app.evaluate(`[...document.querySelectorAll('.toast, [class*=toast], [role=dialog]')].map(n => n.innerText).filter(Boolean)`)
  assert.ok(!toasts.some((t) => /不一致|未被覆盖|mismatch|not overwritten/i.test(t)), `warning shown: ${JSON.stringify(toasts)}`)

  await stopBuiltElectron(app)
  app = await launch()
  await waitFor(() => app.evaluate(`(${editor})?.querySelectorAll('.milkdown-code-block .language-button').length === 3`), 'reopen failed')
  assert.deepEqual(await app.evaluate(`[...(${editor}).querySelectorAll('.milkdown-code-block .language-button')].map(b => b.textContent.trim())`), ['zig', 'vhdl-2008x', 'Rust'])
  console.log(`PASS code-block custom language: Enter / row click set an unknown name, alias kept, list pick intact; save exact + reopen (placeholder: ${placeholder})`)
} finally {
  await stopBuiltElectron(app)
}
