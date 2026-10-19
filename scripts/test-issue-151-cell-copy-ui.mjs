// #151: selecting PART of one table cell's text and pressing Ctrl/Cmd+C put a
// whole one-cell table into text/markdown (selection.content() carries the
// table/row/cell ancestors). The md-paste handler prefers that flavor, so
// pasting into another cell nested a table. A selection inside one cell must
// copy only its inline content; a multi-cell drag still copies as a table.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-issue-151-'))
const file = join(root, 'cells.md')
await writeFile(file, ['# Cells', '', '| Key | Value |', '| --- | --- |',
  '| alpha **bold** omega | target |', '| other | row two |', ''].join('\n'))
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port: 28600 + process.pid % 300, appArgs: [file, '--horsemd-input-trace']
})
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (fn, label) => {
  for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(80) }
  throw new Error(label)
}
const keyboardCopy = async () => {
  await app.evaluate('globalThis.__copyPayload = null')
  for (const type of ['rawKeyDown', 'keyUp']) await app.send('Input.dispatchKeyEvent', {
    type, key: 'c', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67,
    modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['copy']
  })
  return waitFor(() => app.evaluate('globalThis.__copyPayload'), 'Cmd/Ctrl+C did not copy')
}
const tableState = () => app.evaluate(`(() => {
  const e = ${editor}
  return { tables: e.querySelectorAll('table table').length, all: [...e.querySelectorAll('td p, th p')].map(n => n.textContent) }
})()`)
try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('row two')`), 'fixture did not open')
  await sleep(1500)
  await app.evaluate(`document.addEventListener('copy', event => {
    globalThis.__copyPayload = { plain: event.clipboardData.getData('text/plain'),
      html: event.clipboardData.getData('text/html'), markdown: event.clipboardData.getData('text/markdown') }
  })`)

  // Partial text of one cell: "pha " + bold "bold" + " om".
  await app.evaluate(`(() => {
    const p = [...(${editor}).querySelectorAll('td p')].find(n => n.textContent === 'alpha bold omega')
    p.scrollIntoView({ block: 'center' }); (${editor}).focus()
    const first = p.firstChild, last = p.lastChild
    getSelection().setBaseAndExtent(first, 2, last, 3)
  })()`)
  await sleep(150)
  const partial = await keyboardCopy()
  assert.equal(partial.plain, 'pha bold om')
  assert.doesNotMatch(partial.markdown, /\|/, `partial cell copy serialized a table: ${JSON.stringify(partial.markdown)}`)
  assert.match(partial.markdown, /^pha \*\*bold\*\* om\s*$/, `partial cell markdown: ${JSON.stringify(partial.markdown)}`)
  assert.doesNotMatch(partial.html, /<table|<td/, 'partial cell copy put a table into text/html')

  // Paste that payload into another cell: text lands inline, no nested table.
  await app.evaluate(`(() => {
    const p = [...(${editor}).querySelectorAll('td p')].find(n => n.textContent === 'target')
    ;(${editor}).focus(); getSelection().setBaseAndExtent(p.firstChild, 6, p.firstChild, 6)
  })()`)
  await sleep(150)
  const consumed = await app.evaluate(`(() => {
    const data = new DataTransfer()
    data.setData('text/markdown', ${JSON.stringify(partial.markdown)})
    data.setData('text/plain', ${JSON.stringify(partial.plain)})
    data.setData('text/html', ${JSON.stringify(partial.html)})
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
    ;(${editor}).dispatchEvent(event)
    return event.defaultPrevented
  })()`)
  assert.equal(consumed, true, 'paste not handled')
  await sleep(600)
  const after = await tableState()
  assert.equal(after.tables, 0, 'paste into a cell nested a table')
  assert.deepEqual(after.all, ['Key', 'Value', 'alpha bold omega', 'targetpha bold om', 'other', 'row two'])

  // Whole-row range across cells still copies as a table.
  await app.evaluate(`(() => {
    const cells = [...(${editor}).querySelectorAll('td p, th p')]
    const first = cells.find(n => n.textContent === 'other'), last = cells.find(n => n.textContent === 'row two')
    ;(${editor}).focus(); getSelection().setBaseAndExtent(first.firstChild, 0, last.firstChild, last.firstChild.length)
  })()`)
  await sleep(150)
  const row = await keyboardCopy()
  assert.match(row.markdown, /\|/, `multi-cell copy lost its table markdown: ${JSON.stringify(row.markdown)}`)
  console.log('PASS #151 cell copy: partial cell text copies as inline markdown (no table), pastes into another cell without nesting; multi-cell copy still a table')
} finally {
  await stopBuiltElectron(app)
}
