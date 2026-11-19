// Formulas with `|` in table cells, in the real editor (#179 follow-up):
// `$\left\| x \right\|$` in a cell shows single bars (GitHub, markdown-it)
// and its row is saved byte for byte; `$|y|$` typed in a cell is saved as
// `$\|y\|$`, so the reopened table keeps its columns. No rich/source warning.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = join(tmpdir(), `horsemd-table-math-pipes-${process.pid}`)
const file = join(root, 'table-math.md')
const port = Number(process.env.CDP_PORT || 9888)
const warning = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|Save paused/i
const row1 = '| 绝对值 | $\\left\\| x \\right\\|$ |'
const fixture = ['# 表格公式', '', '| 名称 | 公式 |', '|---|---|', row1, '| 手打 | 文字 |', '', 'after table', ''].join('\n')

const waitFor = async (check, message, attempts = 150) => {
  for (let i = 0; i < attempts; i++) {
    const value = await check()
    if (value) return value
    await sleep(80)
  }
  throw new Error(message)
}
const editor = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`
const tableState = (app) => app.evaluate(`(() => {
  const rows = [...(${editor})?.querySelectorAll('table tr') || []]
  return {
    cells: rows.map((row) => row.querySelectorAll('th,td').length),
    maths: rows.map((row) => [...row.querySelectorAll('[data-type="math_inline"]')].map((m) => m.dataset.value)),
    errors: (${editor})?.querySelectorAll('.katex-error').length ?? -1,
    toasts: [...document.querySelectorAll('[class*="toast"]')].filter((n) => n.offsetParent).map((n) => n.textContent || '').join(' | ')
  }
})()`)
const open = async (profile) => {
  const app = await launchBuiltElectron({ profileDir: join(root, profile), port, appArgs: [file] })
  await waitFor(() => app.evaluate(`!!(${editor})?.querySelector('table [data-type="math_inline"] .katex')`), 'table formula did not render')
  await sleep(500)
  return app
}

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
await writeFile(file, fixture)
let app = await open('p1')
try {
  let state = await tableState(app)
  assert.deepEqual(state.maths[1], ['\\left| x \\right|'], `\\| in a cell is a single bar: ${JSON.stringify(state)}`)
  assert.equal(state.errors, 0)
  assert.equal(await app.evaluate(`!!document.querySelector('.tab-close.dirty')`), false, 'opening made the document dirty')

  // Type `$|y|$` at the end of the second row's formula cell.
  const placed = await app.evaluate(`(() => {
    const cell = (${editor}).querySelectorAll('table tr')[2].querySelectorAll('td')[1]
    const text = [...cell.querySelectorAll('*')].map((n) => n.firstChild).find((n) => n?.nodeType === 3 && n.nodeValue.includes('文字'))
    const range = document.createRange(); range.setStart(text, text.nodeValue.length); range.collapse(true)
    getSelection().removeAllRanges(); getSelection().addRange(range); (${editor}).focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.ok(placed)
  await sleep(120)
  await typeTextLikeUser(app.send, ' $|y|$')
  await waitFor(async () => (await tableState(app)).maths[2]?.[0] === '|y|', 'typed formula did not convert')
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'no save button after typing')
  await app.evaluate(`document.querySelector('.hm-save-fab').click()`)
  await waitFor(async () => (await readFile(file, 'utf8')).includes('$\\|y\\|$'), 'saved file has no escaped formula')
  const saved = await readFile(file, 'utf8')
  assert.ok(saved.includes(row1), `untouched formula row changed:\n${saved}`)
  assert.match(saved, /\| 手打 \| 文字 ?\$\\\|y\\\|\$ \|/, `typed formula row:\n${saved}`)
  state = await tableState(app)
  assert.ok(!warning.test(state.toasts), `warning toast: ${state.toasts}`)
} finally {
  await stopBuiltElectron(app)
}

app = await open('p2')
try {
  const state = await tableState(app)
  assert.deepEqual(state.cells, [2, 2, 2], `reopened table lost its columns: ${JSON.stringify(state)}`)
  assert.deepEqual(state.maths.slice(1), [['\\left| x \\right|'], ['|y|']], JSON.stringify(state))
  assert.equal(await app.evaluate(`!!document.querySelector('.tab-close.dirty')`), false, 'reopening made the document dirty')
  console.log('PASS table math pipes UI: \\| reads as |, untouched row kept byte for byte, typed |y| saved as \\|y\\|, table intact after reopening')
} finally {
  await stopBuiltElectron(app)
  await rm(root, { recursive: true, force: true })
}
