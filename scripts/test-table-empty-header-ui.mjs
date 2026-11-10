// A table whose header row lost its cells (fuzz seed 5619: prosemirror-
// tables' fixTables cannot add body cells to a header row, so the row stayed
// empty). Milkdown leaves a row without cells out of the Markdown, so the
// first body row became the header and one row was lost on reopen — and the
// projection guard did not see it (empty rows have no text).
//
// Now: the editor fills the header row with header cells carrying each
// column's alignment (editor-table-header-cells.js), the serializer writes
// an empty header row for a table that has none (remark-text-handler.js
// tableStringifyHandler), and the guard compares row counts.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { open, sleep } from './lib/probe-session.mjs'

const source = '# t\n\n| A | B |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |\n\nend\n'
const s = await open('table-empty-header', source, 9640)
try {
  await s.clickText('end')
  // Remove every header cell in one transaction, as the fuzzer's table
  // handles once did.
  const shape = JSON.parse(await s.trace(`(() => {
    const view = globalThis.__hmSourceReprintHarness.view()
    let tablePos = null
    view.state.doc.forEach((node, offset) => { if (node.type.name === 'table') tablePos = offset })
    const table = view.state.doc.nodeAt(tablePos)
    const header = table.firstChild
    const from = tablePos + 2
    view.dispatch(view.state.tr.delete(from, from + header.content.size))
    const now = view.state.doc.nodeAt(tablePos)
    const rows = []
    now.forEach((row) => { const cells = []; row.forEach((cell) => cells.push(cell.type.name + ':' + (cell.attrs.alignment || '-') + ':' + cell.textContent)); rows.push(cells.join(',')) })
    return rows
  })()`))
  assert.deepEqual(shape, ['table_header:left:,table_header:right:', 'table_cell:left:1,table_cell:right:2', 'table_cell:left:3,table_cell:right:4'], 'header row refilled with each column\'s alignment')
  await sleep(1200)
  const markdown = await s.source()
  assert.match(markdown, /\|\s*\|\s*\|\n\|\s*:-+\s*\|\s*-+:\s*\|\n\|\s*1\s*\|\s*2\s*\|\n\|\s*3\s*\|\s*4\s*\|/, `every body row kept, alignment kept: ${JSON.stringify(markdown)}`)
  assert.deepEqual((await s.toasts()).filter((text) => /不一致|无法安全|暂停/.test(text)), [], 'no sync warning')
  await s.app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await sleep(800)
  const saved = await readFile(s.file, 'utf8')
  assert.equal(saved, markdown, 'saved bytes = source mode')
  const reopened = JSON.parse(await s.trace(`(() => { const d = globalThis.__hmSourceReprintHarness.parse(${JSON.stringify(saved)}); let rows = 0; d.forEach((n) => { if (n.type.name === 'table') rows = n.childCount }); return rows })()`))
  assert.equal(reopened, 3, 'reopened table has the header row and both body rows')
  // The serializer alone (a table that has no header cells at all).
  const serialized = JSON.parse(await s.trace(`(() => {
    const h = globalThis.__hmSourceReprintHarness
    const cell = (t) => ({ type: 'table_cell', attrs: { alignment: null }, content: [{ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] }] })
    const doc = h.docFromJSON({ type: 'doc', content: [{ type: 'table', content: [{ type: 'table_header_row', content: [] }, { type: 'table_row', content: [cell(), cell()] }, { type: 'table_row', content: [cell('a'), cell('3')] }] }] })
    let rows = 0
    h.parse(h.serialize(doc)).forEach((n) => { if (n.type.name === 'table') rows = n.childCount })
    return rows
  })()`))
  assert.equal(serialized, 3, 'a header row without cells is written as an empty header row')
  console.log('PASS table empty header: refilled with header cells and alignment, every row written, saved file reopens with all rows')
} finally {
  await s.close()
}
