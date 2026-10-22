// Air 0.13.251 trace-63191: in a CRLF file, `/code` + Enter at the end made
// a code block; typing a line and pressing Enter in it raised the rich/source
// mismatch warning. The code-block owner spelled the new line break as CRLF
// (the file's style), but micromark keeps `\r\n` inside a code value, so the
// re-parsed block read `text\r\n` against the editor's `text\n`.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-crlf-code-'))
const file = join(root, 'crlf.md')
const original = ['# CRLF', '', '```js', 'const a = 1', '```', '', '译制：我', ''].join('\r\n')
await writeFile(file, original)
const inspectPort = 9800 + process.pid % 150
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port: 29700 + process.pid % 250, appArgs: [file, '--horsemd-input-trace', `--inspect=${inspectPort}`]
})
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const send = app.send.bind(app)
const waitFor = async (fn, label, attempts = 120) => {
  for (let i = 0; i < attempts; i++) { const v = await fn(); if (v) return v; await sleep(100) }
  throw new Error(label)
}
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
const warnings = () => app.evaluate(`[...document.querySelectorAll('.toast, [class*=toast], [role=dialog]')].map(n => n.innerText).filter((t) => /不一致|未被覆盖|mismatch|not overwritten/i.test(t))`)
const clickEndOf = async (text) => {
  const point = await app.evaluate(`(() => {
    const p = [...(${editor}).querySelectorAll('p')].find((n) => n.textContent === ${JSON.stringify(text)})
    p.scrollIntoView({ block: 'center' })
    const r = document.createRange(); r.selectNodeContents(p); const b = r.getBoundingClientRect()
    return { x: b.right - 2, y: b.top + b.height / 2 }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await sleep(200)
}

try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('译制')`), 'fixture did not open')
  await sleep(1200)

  // New code block from the slash menu, then a line + Enter inside it.
  await clickEndOf('译制：我')
  await pressKey(send, { key: 'Enter' })
  await sleep(200)
  await typeTextLikeUser(send, '/code')
  await sleep(400)
  await pressKey(send, { key: 'Enter' })
  await waitFor(() => app.evaluate(`(${editor}).querySelectorAll('.cm-editor').length === 2`), 'slash menu did not insert a code block')
  await sleep(300)
  await typeTextLikeUser(send, '老师当年')
  await pressKey(send, { key: 'Enter' })
  await typeTextLikeUser(send, 'x')
  await sleep(1500)
  assert.deepEqual(await warnings(), [], 'new code block in a CRLF file raised a mismatch warning')

  // An authored CRLF code block: Enter inside it too.
  await app.evaluate(`(() => {
    const line = (${editor}).querySelector('.cm-line')
    const r = document.createRange(); r.selectNodeContents(line); const b = r.getBoundingClientRect()
    globalThis.__pt = { x: b.right + 1, y: b.top + b.height / 2 }
  })()`)
  const pt = await app.evaluate('globalThis.__pt')
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(200)
  await pressKey(send, { key: 'Enter' })
  await typeTextLikeUser(send, 'b')
  await sleep(1500)
  assert.deepEqual(await warnings(), [], 'Enter in an authored CRLF code block raised a mismatch warning')

  assert.equal(await mainMenu('Save'), true, 'Save menu item not found')
  await waitFor(async () => (await readFile(file, 'utf8')) !== original, 'save did not write')
  const saved = await readFile(file, 'utf8')
  assert.ok(!/[^\r]\n/.test(saved), `saved file mixes line endings: ${JSON.stringify(saved)}`)
  assert.equal(saved, ['# CRLF', '', '```js', 'const a = 1', 'b', '```', '', '译制：我', '', '```', '老师当年', 'x', '```', ''].join('\r\n'),
    `saved bytes: ${JSON.stringify(saved)}`)
  assert.deepEqual(await warnings(), [], 'save raised a warning')
  console.log('PASS CRLF code block: Enter in a new and an authored code block keeps rich/source in sync; file stays CRLF')
} finally {
  await stopBuiltElectron(app)
}
