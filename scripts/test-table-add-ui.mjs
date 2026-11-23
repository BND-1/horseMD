// #181 tables: column lines, easy add row / column, keyboard rows, drag to
// resize. Real editor, real mouse and keys through CDP:
//   1. inner cells draw a vertical line;
//   2. the pointer at a column boundary shows a「+」above the header at that
//      boundary (outside the table, not covered) and marks the boundary; a
//      click inserts a column THERE (caret in its header);
//   3. at a row boundary the「+」is left of the table at that line and inserts
//      a row there; the outer edges count (after the last column, under the
//      last row); inside a cell and away from the table: nothing;
//   4. Mod+Enter in a cell inserts a row under that row, same column (Typora);
//      Tab in the last cell adds a row; Tab elsewhere only moves; Enter is
//      still an in-cell line break;
//   4b. right-click › 表格: insert row above / below, column left / right,
//      delete row / column (header row: no row above, not deletable); no
//      「+」on a hovered grid line (Crepe's, half hidden — removed);
//   5. a column edge shows col-resize; pressing it and moving sideways resizes
//      at once (no hold), one colwidth transaction; a click there changes
//      nothing;
//   6. reading mode: no insert buttons;
// every step: the source reads back as the editor's document, no warning;
// then save, reopen: the same text.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { MOD_MODIFIER, pressKey } from './lib/human-input.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-table-add-'))
const pm = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`
const DOC = [
  '# 表格', '',
  // The table sits below the first screen: a jump to the start shows.
  ...Array.from({ length: 40 }, (_, i) => [`段落 ${i + 1}。`, '']).flat(),
  '前文。', '',
  '| 编号 | 名称 | 说明 |',
  '| --- | :---: | --- |',
  '| 1 | 苹果 | 红色的水果 |',
  '| 2 | 香蕉 | 黄色 |', '',
  '后文。', ''
].join('\n')
const file = join(root, 'table.md')
await fs.writeFile(file, DOC)
const port = 9680 + Math.floor(Math.random() * 60)
let app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file, '--horsemd-input-trace'] })
const ev = (expression) => app.evaluate(expression)
const key = (name, modifiers = 0) => pressKey(app.send, { key: name, modifiers })
const type = async (text) => { for (const ch of [...text]) { await app.send('Input.insertText', { text: ch }); await sleep(45) } }
const mouse = async (type, point, extra = {}) => app.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', ...extra })
const move = async (point) => { await mouse('mouseMoved', point, { button: 'none' }); await sleep(40) }
const click = async (point) => {
  await move(point)
  await mouse('mousePressed', point, { buttons: 1, clickCount: 1 })
  await mouse('mouseReleased', point, { buttons: 0, clickCount: 1 })
  await sleep(250)
}
const cells = () => ev(`[...(${pm}).querySelectorAll('.milkdown-table-block th, .milkdown-table-block td')].map((n) => {
  const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, text: n.textContent, row: n.parentElement.rowIndex, col: n.cellIndex }
})`)
const cellAt = async (row, col) => (await cells()).find((c) => c.row === row && c.col === col)
const inside = (c, dx = 20) => ({ x: Math.round(c.x + dx), y: Math.round((c.y + c.b) / 2) })
const tableRect = () => ev(`(() => { const r = (${pm}).querySelector('.milkdown-table-block table.children').getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height } })()`)
const sourceLines = async () => (await ev('globalThis.__hmSourceReprintHarness.liveSource()')).split('\n').filter((l) => l.startsWith('|'))
const check = async (label) => {
  await sleep(900)
  const state = await ev(`(() => { const h = globalThis.__hmSourceReprintHarness; const s = h.liveSource()
    return { source: s, equivalent: h.equivalent(s, h.liveDoc()), toasts: [...document.querySelectorAll('.hm-toast-msg')].map((n) => n.textContent) } })()`)
  assert.deepEqual(state.toasts.filter((t) => /不一致|无法安全/.test(t)), [], `${label}: no mismatch warning`)
  assert.equal(state.equivalent, true, `${label}: the source reads back as the editor's document:\n${state.source}`)
  const rows = state.source.split('\n').filter((l) => l.startsWith('|'))
  console.log(`  ✓ ${label}`)
  return rows
}

try {
  for (let i = 0; i < 80; i++) {
    if (await ev(`Boolean((${pm})?.querySelector('.milkdown-table-block td')) && Boolean(globalThis.__hmSourceReprintHarness)`)) break
    await sleep(150)
  }
  await sleep(1000)

  // The caret stays at the document start (never clicked); the table is
  // scrolled into view.
  await ev(`(${pm}).querySelector('.milkdown-table-block').scrollIntoView({ block: 'center' })`)
  await sleep(400)

  // 1. Column lines.
  const lines = await ev(`[...(${pm}).querySelectorAll('.milkdown-table-block tr:first-child > *')].map((n) => getComputedStyle(n).borderRightWidth)`)
  assert.deepEqual(lines.map((w) => Number.parseFloat(w) > 0), [true, true, false], `inner cells draw a vertical line, the last one none: ${lines}`)
  console.log('  ✓ inner column lines')

  // 1b. ⌘Z right after a「+」: the insert is undone where it was — the page
  // does not jump to the document start (Air trace 2026-11-23: the caret had
  // never left the start, undo restored it there).
  const scrollTop = () => ev(`document.querySelector('.editor-scroll:not([style*="display: none"])') ? [...document.querySelectorAll('.editor-scroll')].find((n) => n.offsetParent)?.scrollTop : -1`)
  const caretInTable = () => ev(`(() => { const s = window.getSelection(); return Boolean(s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement).closest('.milkdown-table-block')) })()`)
  const plusAt = async (kind, point) => {
    await move(point)
    await sleep(200)
    const b = await ev(`(() => { const n = [...document.querySelectorAll('.hm-table-insert[data-kind="${kind}"]')].find((x) => x.closest('.milkdown')?.offsetParent && x.dataset.show === 'true'); if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    assert.ok(b, `${kind}「+」shows`)
    return b
  }
  for (const kind of ['col', 'row']) {
    const c = await cellAt(1, 1)
    const before = await sourceLines()
    const top0 = await scrollTop()
    assert.ok(top0 > 300, `the table is below the first screen: ${top0}`)
    const point = kind === 'col' ? { x: Math.round(c.r - 2), y: Math.round((c.y + c.b) / 2) } : { x: Math.round(c.x + 30), y: Math.round(c.b - 1) }
    await click(await plusAt(kind, point))
    await sleep(300)
    assert.notDeepEqual(await sourceLines(), before, `${kind}「+」inserted`)
    await key('z', MOD_MODIFIER)
    await sleep(600)
    assert.deepEqual(await sourceLines(), before, `⌘Z removes the inserted ${kind}`)
    const top1 = await scrollTop()
    assert.ok(Math.abs(top1 - top0) < 80, `⌘Z after the ${kind}「+」keeps the page where it was: ${top0} → ${top1}`)
    assert.equal(await caretInTable(), true, `the caret is in the table after ⌘Z (${kind})`)
  }
  await check('⌘Z after a「+」does not jump to the document start')

  // 2. Nothing inside a cell; a column boundary: a「+」above the header at it
  // (outside the table) and the boundary marked.
  const shown = () => ev(`Object.fromEntries([...document.querySelectorAll('.hm-table-insert')].filter((n) => n.closest('.milkdown')?.offsetParent).map((n) => {
    const r = n.getBoundingClientRect(); const line = n.previousElementSibling.getBoundingClientRect()
    return [n.dataset.kind, n.dataset.show === 'true' ? { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom, left: r.left, right: r.right, hit: n.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)), line: { x: line.left + line.width / 2, y: line.top + line.height / 2, w: line.width, h: line.height } } : null]
  }))`)
  const c11 = await cellAt(1, 1)
  await move(inside(c11, 30))
  await sleep(200)
  assert.deepEqual(await shown(), { col: null, row: null }, 'inside a cell: no insert buttons')
  let t = await tableRect()
  await move({ x: Math.round(c11.r - 2), y: Math.round((c11.y + c11.b) / 2) })
  await sleep(200)
  let s1 = await shown()
  assert.ok(s1.col, 'a column boundary shows the column「+」')
  assert.ok(Math.abs(s1.col.x - c11.r) <= 2 && s1.col.bottom <= t.y - 2, `the column「+」is above the header at the boundary: ${JSON.stringify({ s1, c11, t })}`)
  assert.ok(Math.abs(s1.col.line.x - c11.r) <= 2 && Math.abs(s1.col.line.h - t.h) <= 2, 'the boundary is marked over the whole table')
  assert.equal(s1.col.hit, true, 'the column「+」is not covered')
  // The pointer goes up to it: it stays; a click inserts a column there.
  await move({ x: Math.round(c11.r), y: Math.round(t.y - 6) })
  await move({ x: Math.round(s1.col.x), y: Math.round(s1.col.y) })
  await sleep(500)
  assert.ok((await shown()).col, 'the column「+」stays while the pointer goes to it')
  await click({ x: Math.round(s1.col.x), y: Math.round(s1.col.y) })
  await type('产地')
  let rows = await check('column「+」at the 名称 | 说明 boundary inserts a column there, typing goes into its header')
  assert.match(rows[0], /^\| 编号 +\| 名称 +\| 产地 +\| 说明 +\|$/, rows[0])
  assert.match(rows[1], /^\| --- \| :-+: \| -+ \| --- \|$/, `the new column has no alignment, the centred one keeps it: ${rows[1]}`)
  assert.equal(rows.every((r) => r.split('|').length === 6), true, rows.join('\n'))

  // 3. A row boundary: a「+」left of the table at it; a click inserts a row
  // there, caret in its first cell.
  const c10 = await cellAt(1, 0)
  await move({ x: Math.round(c10.x + 30), y: Math.round(c10.b - 1) })
  await sleep(200)
  t = await tableRect()
  s1 = await shown()
  assert.ok(s1.row, 'a row boundary shows the row「+」')
  assert.ok(Math.abs(s1.row.y - c10.b) <= 2 && s1.row.right <= t.x - 2, `the row「+」is left of the table at the boundary: ${JSON.stringify({ s1, c10, t })}`)
  assert.equal(s1.row.hit, true, 'the row「+」is not covered')
  await move({ x: Math.round(t.x - 4), y: Math.round(c10.b) })
  await move({ x: Math.round(s1.row.x), y: Math.round(s1.row.y) })
  await sleep(500)
  assert.ok((await shown()).row, 'the row「+」stays while the pointer goes to it')
  await click({ x: Math.round(s1.row.x), y: Math.round(s1.row.y) })
  await type('3')
  rows = await check('row「+」under row 1 inserts a row there, typing goes into its first cell')
  assert.match(rows[2], /^\| 1 /, rows[2])
  assert.match(rows[3], /^\| 3 +\|( +\|){3}$/, rows[3])
  // The outer edges count too: after the last column, under the last row.
  const lastCol = (await cells()).filter((c) => c.row === 1).at(-1)
  await move({ x: Math.round(lastCol.r - 1), y: Math.round((lastCol.y + lastCol.b) / 2) })
  await sleep(200)
  s1 = await shown()
  assert.ok(s1.col && Math.abs(s1.col.x - lastCol.r) <= 2, 'the right edge of the last column offers a column')
  const lastRow = (await cells()).filter((c) => c.col === 0).at(-1)
  await move({ x: Math.round(lastRow.x + 30), y: Math.round(lastRow.b - 1) })
  await sleep(200)
  s1 = await shown()
  assert.ok(s1.row && Math.abs(s1.row.y - lastRow.b) <= 2, 'the bottom of the last row offers a row')
  await move({ x: Math.round(t.x + 20), y: Math.round(t.b + 120) })
  await sleep(700)
  assert.deepEqual(await shown(), { col: null, row: null }, 'away from the table: nothing')
  console.log('  ✓ insert buttons at column / row boundaries (outer edges too), not over cells')

  // 4. Keyboard: Mod+Enter under row 1, same column.
  await click(inside(await cellAt(1, 1), 20))
  await key('Enter', MOD_MODIFIER)
  await type('梨')
  rows = await check('Mod+Enter inserts a row under the current one, same column')
  assert.equal(rows.length, 6, rows.join('\n'))
  assert.match(rows[2], /^\| 1 /, rows[2])
  assert.match(rows[3], /^\| +\| 梨 +\| +\| +\|$/, rows[3])
  // Tab elsewhere moves only; Tab in the last cell adds a row.
  const last = (await cells()).at(-1)
  await click(inside(last, 20))
  const before = (await sourceLines()).length
  await key('Tab')
  await type('4')
  rows = await check('Tab in the last cell adds a row, caret in its first cell')
  assert.equal(rows.length, before + 1, rows.join('\n'))
  assert.match(rows.at(-1), /^\| 4 +\|/, rows.at(-1))
  await key('Tab')
  rows = await check('Tab in another cell only moves')
  assert.equal(rows.length, before + 1, 'no row added')
  await type('x')
  await key('Enter')
  await type('y')
  rows = await check('Enter is still a line break inside a cell')
  assert.match(rows.at(-1), /^\| 4 +\| x<br>y +\|/, rows.at(-1))

  // 4b. Right-click › 表格.
  const cellWith = async (text) => (await cells()).find((c) => c.text === text)
  const rightClick = async (point) => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await mouse(type, point, { button: 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 })
    }
    await sleep(300)
  }
  const menuItems = () => ev(`Object.fromEntries([...document.querySelectorAll('[data-table-action]')].map((n) => [n.dataset.tableAction, !n.disabled]))`)
  const pick = async (action) => {
    assert.equal(await ev(`(() => { const n = document.querySelector('[data-table-action="${action}"]'); if (!n || n.disabled) return false; n.click(); return true })()`), true, `menu item ${action}`)
    await sleep(200)
  }
  const emptyRow = /^\|( +\|)+$/
  const tableBefore = (await sourceLines()).join('\n')
  await rightClick(inside(await cellWith('名称')))
  assert.deepEqual(await menuItems(), { rowAbove: false, rowBelow: true, colLeft: true, colRight: true, deleteRow: false, deleteCol: true }, 'header row: no row above, not deletable')
  await key('Escape')
  await sleep(200)
  await rightClick(inside(await cellWith('香蕉')))
  assert.deepEqual(await menuItems(), { rowAbove: true, rowBelow: true, colLeft: true, colRight: true, deleteRow: true, deleteCol: true })
  await pick('rowAbove')
  rows = await check('表格 › 在上方插入行')
  assert.match(rows[rows.findIndex((r) => r.includes('香蕉')) - 1], emptyRow, `an empty row above 香蕉:\n${rows.join('\n')}`)
  // The caret is in the new row: delete it from there.
  const banana = await cellWith('香蕉')
  await rightClick(inside((await cells()).find((c) => c.row === banana.row - 1 && c.col === 0)))
  await pick('deleteRow')
  rows = await check('表格 › 删除行')
  assert.equal(rows.join('\n'), tableBefore, 'deleting the new row gives the table back')
  await rightClick(inside(await cellWith('香蕉')))
  await pick('colLeft')
  rows = await check('表格 › 在左侧插入列')
  assert.match(rows[0], /^\| 编号 +\| +\| 名称 /, rows[0])
  assert.equal(rows[1].split('|')[2].trim(), '---', `a new column has no alignment: ${rows[1]}`)
  const left = await cellWith('香蕉')
  await rightClick(inside((await cells()).find((c) => c.row === left.row && c.col === left.col - 1)))
  await pick('deleteCol')
  rows = await check('表格 › 删除列')
  assert.equal(rows.join('\n'), tableBefore, 'deleting the new column gives the table back')
  await rightClick(inside(await cellWith('香蕉')))
  await pick('colRight')
  rows = await check('表格 › 在右侧插入列')
  assert.match(rows[0], /^\| 编号 +\| 名称 +\| +\| 产地 /, rows[0])
  await rightClick(inside(await cellWith('香蕉')))
  await pick('rowBelow')
  rows = await check('表格 › 在下方插入行')
  assert.match(rows[rows.findIndex((r) => r.includes('香蕉')) + 1], emptyRow)

  // No「+」on a hovered grid line (Crepe's; removed).
  const g = await cellWith('苹果')
  await move({ x: Math.round(g.r - 1), y: Math.round((g.y + g.b) / 2) })
  await move({ x: Math.round((g.x + g.r) / 2), y: Math.round(g.b - 1) })
  await sleep(300)
  assert.equal(await ev(`[...(${pm}).querySelectorAll('.line-handle .add-button')].some((n) => n.getClientRects().length > 0)`), false, 'no「+」on a hovered grid line')
  console.log('  ✓ no grid-line「+」')

  // 5. Column edges: col-resize cursor, drag at once, a click changes nothing.
  const c = await cellAt(2, 0)
  const edge = { x: Math.round(c.r - 2), y: Math.round((c.y + c.b) / 2) }
  await move(edge)
  await sleep(150)
  assert.equal(await ev(`Boolean((${pm}).querySelector('.milkdown-table-block.hm-col-edge'))`), true, 'a column edge shows the resize cursor')
  assert.equal(await ev(`getComputedStyle((${pm}).querySelector('.milkdown-table-block td')).cursor`), 'col-resize')
  await move(inside(c))
  await sleep(100)
  assert.equal(await ev(`Boolean((${pm}).querySelector('.milkdown-table-block.hm-col-edge'))`), false, 'away from an edge: the text cursor')
  const widthOf = () => ev(`Math.round((${pm}).querySelector('.milkdown-table-block th').getBoundingClientRect().width)`)
  const colwidth = () => ev(`(${pm}).querySelector('.milkdown-table-block th').getAttribute('data-colwidth') || ''`)
  const w0 = await widthOf()
  await click(edge)
  assert.equal(await colwidth(), '', 'a click on an edge changes nothing')
  // A quick drag from 7 px off the line, wobbling vertically first (a
  // trackpad press): resizes at once, no hold.
  const near = { x: Math.round(c.r - 7), y: Math.round((c.y + c.b) / 2) }
  await move(near)
  await mouse('mousePressed', near, { buttons: 1, clickCount: 1 })
  await mouse('mouseMoved', { x: near.x, y: near.y + 3 }, { buttons: 1 })
  for (let dx = 2; dx <= 30; dx += 4) { await mouse('mouseMoved', { x: near.x + dx, y: near.y + 4 }, { buttons: 1 }); await sleep(16) }
  await mouse('mouseReleased', { x: near.x + 30, y: near.y + 4 }, { buttons: 0, clickCount: 1 })
  await sleep(400)
  const wq = Number(await colwidth())
  assert.ok(Math.abs(wq - (w0 + 30)) <= 3, `a quick drag from 7 px off the line resizes: ${w0} → ${wq}`)
  assert.equal(await caretInTable(), true)
  // The line moved with the column: find it again.
  const c2 = await cellAt(2, 0)
  edge.x = Math.round(c2.r - 2)
  await move(edge)
  await mouse('mousePressed', edge, { buttons: 1, clickCount: 1 })
  for (let dx = 4; dx <= 60; dx += 8) { await mouse('mouseMoved', { x: edge.x + dx, y: edge.y }, { buttons: 1 }); await sleep(16) }
  const live = await widthOf()
  await mouse('mouseReleased', { x: edge.x + 60, y: edge.y }, { buttons: 0, clickCount: 1 })
  await sleep(400)
  assert.ok(Math.abs(live - (wq + 60)) <= 3, `the column follows the drag at once: ${wq} → ${live}`)
  assert.ok(Math.abs(Number(await colwidth()) - (wq + 60)) <= 3, `the width is kept: ${await colwidth()}`)
  assert.equal(await ev(`document.body.classList.contains('hm-table-resizing')`), false)
  await check('dragging a column edge resizes without a hold')

  // 6. Reading mode: no bars.
  await key('R', MOD_MODIFIER | 8)
  await sleep(500)
  await move(inside(await cellAt(1, 1)))
  await sleep(300)
  await move({ x: Math.round((await cellAt(1, 1)).r - 2), y: Math.round(((await cellAt(1, 1)).y + (await cellAt(1, 1)).b) / 2) })
  await sleep(300)
  assert.deepEqual(await shown(), { col: null, row: null }, 'no insert buttons in reading mode')
  await key('R', MOD_MODIFIER | 8)
  await sleep(500)
  console.log('  ✓ reading mode shows no insert buttons')

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
  console.log('PASS table add / resize (#181): column lines;「+」at a hovered column / row boundary (outside the table) inserts exactly there; right-click 表格 inserts above / below / left / right and deletes rows / columns; no grid-line「+」; Mod+Enter row below, Tab in the last cell adds a row, Enter stays a cell line break; column edges drag to resize at once; no bars in reading mode; save and reopen')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await fs.rm(root, { recursive: true, force: true })
}
