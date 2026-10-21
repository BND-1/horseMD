// Issue #152 (Windows 0.13.250): after pasting a big table (and dragging its
// rows) every save refused with 「原文件未被覆盖」. Two paste paths left a
// document a GFM table can't spell, so the source-sync gate failed closed:
// - Excel / WPS / web tables carry merged cells (colspan / rowspan);
// - pasting a table (or several blocks) INTO a table cell: Milkdown's
//   clipboard plugin replaced the selection and split the table in three.
// Now merged cells split into a plain grid, and a paste inside a cell fills
// the cells from the caret (or joins blocks into the cell with <br>).
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const realTables = `[...(${editor}).querySelectorAll('table')].filter(t => !t.closest('.drag-preview'))`
const source = ['# 粘贴表格', '', '第一段文字。', '', '粘贴到这里', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', '最后一段。', ''].join('\n')

const excelHtml = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><body><!--StartFragment--><table border=0 width=400>
<col width=100 span=4>
<tr height=19><td colspan=2 width=200>合并标题</td><td>C</td><td>D</td></tr>
<tr height=19><td rowspan=2>跨两行</td><td>b1</td><td x:num>3.5</td><td>&nbsp;</td></tr>
<tr height=19><td>b2</td><td x:num>4</td><td>第一行<br>第二行</td></tr>
<tr height=19><td>x</td><td>y</td><td>z|竖线</td><td>尾</td></tr>
<!--EndFragment--></table></body></html>`
const excelText = '合并标题\t\tC\tD\n跨两行\tb1\t3.5\t \n\tb2\t4\t"第一行\n第二行"\nx\ty\tz|竖线\t尾\n'
const mdTable = ['| 编号 | 名称 | 价格 |', '| --- | --- | --- |', '| 1 | 商品1 | 0.00 |', '| 2 | 商品2 | 3.70 |'].join('\n')
const webBlocksHtml = '<table><caption>表题</caption><thead><tr><th>名</th><th>要点</th></tr></thead><tbody>' +
  '<tr><th>行头</th><td><p>第一段</p><p>第二段</p></td></tr>' +
  '<tr><td>b</td><td><ul><li>一</li><li>二</li></ul></td></tr>' +
  '<tr><td><h3>小标题</h3></td><td><table><tr><th>内1</th><td>内2</td></tr></table></td></tr></tbody></table>'
const plainHtml = '<html><body><table><tr><td>h1</td><td>h2</td></tr><tr><td>c</td><td>d</td></tr><tr><td>e</td><td>f</td></tr></table></body></html>'

const cases = [
  {
    label: 'Excel table with merged cells pasted on an empty line, then a row dragged',
    at: 'line', html: excelHtml, text: excelText, drag: { table: 0, from: 3, to: 1 },
    tables: 2,
    rows: [
      ['合并标题', '', 'C', 'D'], ['x', 'y', 'z|竖线', '尾'], ['跨两行', 'b1', '3.5', ''], ['', 'b2', '4', '第一行第二行']
    ]
  },
  {
    label: 'Markdown table pasted inside a table cell fills the cells',
    at: 'cell', text: mdTable, tables: 1,
    rows: [['A', 'B', ''], ['编号', '名称', '价格'], ['1', '商品1', '0.00'], ['2', '商品2', '3.70']]
  },
  {
    label: 'HTML table pasted inside a table cell fills the cells',
    at: 'cell', html: plainHtml, text: 'h1\th2\nc\td\ne\tf\n', tables: 1,
    rows: [['A', 'B'], ['h1', 'h2'], ['c', 'd'], ['e', 'f']]
  },
  {
    label: 'Excel table with merged cells pasted inside a table cell',
    at: 'cell', html: excelHtml, text: excelText, tables: 1,
    rows: [['A', 'B', '', ''], ['合并标题', '', 'C', 'D'], ['跨两行', 'b1', '3.5', ''], ['', 'b2', '4', '第一行第二行'], ['x', 'y', 'z|竖线', '尾']]
  },
  {
    // Web / Notion / Confluence: block content in cells and <th> row headers
    // used to split the table into several tables with text in between.
    label: 'Web table with paragraphs, lists, heading, nested table and <th> row headers in cells',
    at: 'line', html: webBlocksHtml, text: 'x', drag: { table: 0, from: 3, to: 1 }, tables: 2,
    rows: [['名', '要点'], ['小标题', '内1 | 内2'], ['行头', '第一段第二段'], ['b', '• 一• 二']],
    cellSource: '| 行头 | 第一段<br>第二段 |'
  },
  {
    label: 'One-row HTML table pasted inside a cell fills that row only',
    at: 'cell', html: '<table><tr><td>S1</td><td>S2</td></tr></table>', text: 'S1\tS2\n', tables: 1,
    rows: [['A', 'B'], ['S1', 'S2']]
  },
  {
    label: 'Heading + list pasted inside a table cell joins into the cell',
    at: 'cell', text: '# 小标题\n\n- 一\n- 二\n', tables: 1,
    rows: [['A', 'B'], ['1小标题一二', '2']], cellSource: '| 1小标题<br>一<br>二 |'
  }
]

const root = await mkdtemp(join(tmpdir(), 'horsemd-table-paste-'))
let failures = 0
const launch = (file, profile, index) => launchBuiltElectron({
  profileDir: join(root, profile), cleanProfile: false,
  port: 29600 + index * 2 + (profile.endsWith('reopen') ? 1 : 0) + process.pid % 20,
  appArgs: [file, '--horsemd-input-trace']
})
const waitForOn = (app) => async (check, message, attempts = 80) => {
  for (let i = 0; i < attempts; i += 1) { const value = await check(); if (value) return value; await sleep(100) }
  throw new Error(message)
}
const tableRows = (app) => app.evaluate(`${realTables}.map(t => [...t.querySelectorAll('tr')].map(r => [...r.querySelectorAll('th,td')].map(c => c.textContent.trim())))`)

for (const [index, testCase] of cases.entries()) {
  const file = join(root, `doc-${index}.md`)
  await writeFile(file, source)
  let app = await launch(file, `profile-${index}`, index)
  let send = app.send.bind(app)
  let waitFor = waitForOn(app)
  try {
    await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('最后一段')`), 'document did not open')
    await sleep(1200)
    await app.evaluate(`(() => {
      window.__toasts = []
      const seen = new WeakSet()
      new MutationObserver(() => {
        for (const node of document.querySelectorAll('.hm-toast-msg')) if (!seen.has(node)) { seen.add(node); window.__toasts.push(node.textContent) }
      }).observe(document.body, { childList: true, subtree: true })
    })()`)
    // Caret: end of the「粘贴到这里」line + Enter, or end of the cell "1".
    const point = await app.evaluate(`(() => {
      const target = ${JSON.stringify(testCase.at === 'cell' ? '1' : '粘贴到这里')}
      const scope = ${testCase.at === 'cell' ? `${realTables}[0].querySelectorAll('td')[0]` : editor}
      const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT); let n
      while ((n = w.nextNode())) { const i = n.nodeValue.indexOf(target); if (i < 0) continue
        const r = document.createRange(); r.setStart(n, i + target.length); r.collapse(true)
        const b = r.getClientRects()[0] || r.getBoundingClientRect(); return { x: Math.round(b.left + 1), y: Math.round(b.top + b.height / 2) } }
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
    await sleep(250)
    if (testCase.at === 'line') { await pressKey(send, { key: 'Enter', code: 'Enter', text: '\r' }); await sleep(400) }
    await app.evaluate(`(() => {
      const data = new DataTransfer()
      data.setData('text/plain', ${JSON.stringify(testCase.text)})
      ${testCase.html ? `data.setData('text/html', ${JSON.stringify(testCase.html)})` : ''}
      ;(${editor}).dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    })()`)
    await sleep(900)

    if (testCase.drag) {
      // The row drag handle drives Crepe's moveRowCommand on drop.
      const { table, from, to } = testCase.drag
      const block = `[...(${editor}).querySelectorAll('.milkdown-table-block')][${table}]`
      const cellAt = (r) => app.evaluate(`(() => { const t = [...(${block}).querySelectorAll('table')].find(t => !t.closest('.drag-preview')); const c = t.querySelectorAll('tr')[${r}].querySelector('th,td'); c.scrollIntoView({ block: 'center' }); const b = c.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()`)
      const src = await cellAt(from)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...src })
      await sleep(400)
      const dst = await cellAt(to)
      await app.evaluate(`(async () => {
        const handle = (${block}).querySelector('[data-role="row-drag-handle"]')
        const dt = new DataTransfer()
        handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${src.x}, clientY: ${src.y} }))
        await new Promise(r => setTimeout(r, 60))
        for (let k = 1; k <= 6; k++) { window.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${src.x}, clientY: ${src.y} + (${dst.y} - ${src.y}) * k / 6 })); await new Promise(r => setTimeout(r, 50)) }
        window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${dst.x}, clientY: ${dst.y} }))
        window.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
      })()`)
      await sleep(900)
    }

    const live = await tableRows(app)
    assert.equal(live.length, testCase.tables, `table count: ${JSON.stringify(live)}`)
    const pasted = testCase.at === 'cell' ? live[0] : live[0]
    assert.deepEqual(pasted, testCase.rows, `pasted table: ${JSON.stringify(pasted)}`)
    for (const table of live) {
      const widths = new Set(table.map((row) => row.length))
      assert.equal(widths.size, 1, `table is not a plain grid: ${JSON.stringify(table)}`)
    }

    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button not shown')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    const saved = await waitFor(async () => {
      const text = await readFile(file, 'utf8')
      return text !== source && text
    }, 'file was not written', 50)
    await sleep(600)
    const toasts = await app.evaluate('window.__toasts.slice()')
    assert.equal(toasts.some((text) => warningPattern.test(text)), false, `warning: ${JSON.stringify(toasts)}`)
    assert.deepEqual(await app.evaluate('(globalThis.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).map(e => e.preservationReason)'), [])
    assert.ok(saved.startsWith('# 粘贴表格\n\n第一段文字。\n\n粘贴到这里\n\n'), `head changed: ${JSON.stringify(saved)}`)
    assert.ok(saved.endsWith('\n\n最后一段。\n'), `tail changed: ${JSON.stringify(saved)}`)
    if (testCase.cellSource) assert.ok(saved.includes(testCase.cellSource), `cell source: ${JSON.stringify(saved)}`)
    await stopBuiltElectron(app)

    // Reopen: the saved Markdown shows the same tables.
    app = await launch(file, `profile-${index}-reopen`, index)
    waitFor = waitForOn(app)
    await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('最后一段')`), 'reopen did not load')
    await sleep(800)
    assert.deepEqual(await tableRows(app), live, `reopen differs: ${JSON.stringify(saved)}`)
    console.log(`ok   ${testCase.label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${testCase.label}: ${String(error?.message || error).slice(0, 900)}`)
    try {
      console.log('DIAGNOSTIC', JSON.stringify(await app.evaluate(`({
        toasts: window.__toasts,
        bad: (globalThis.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).slice(-2).map(e => ({ reason: e.preservationReason, site: e.validationSite, candidate: e.candidate, canonical: e.canonical }))
      })`)).slice(0, 4000))
    } catch {}
  } finally {
    await stopBuiltElectron(app)
  }
}
console.log(failures ? `FAIL table paste: ${failures}/${cases.length} failed` : 'PASS table paste: merged cells split into a plain grid, pastes inside a cell keep the table whole, saves write and reopen identically')
process.exit(failures ? 1 : 0)
