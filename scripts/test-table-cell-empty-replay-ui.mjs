import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { pressKey } from './lib/human-input.mjs'
import { sleep } from './lib/cdp.mjs'

const tracePath = process.env.TABLE_CELL_INPUT_TRACE
const forced = process.env.TABLE_CELL_FORCE === '1'
let source = [
  '# Table cell regression', '',
  '| 字段 | 必填 | 说明|',
  '| ----------------------------------- | -: | ------------------- |',
  '| `days`                              |  否 | 默认 7 |',
  '| `min_ratio`                         |  否 | **涨幅阈值**，默认 2 |',
  '| `min_base`                          |  否 | 默认 100 |',
  '| `category_name`                     |  否 | 末级品类 |',
  '| `price_min` / `price_max`            |  否 | 价格 |',
  '| `commission_min` / `commission_max`  |  否 | 比例 |',
  '| `top_n`                             |  否 | 默认 20 |',
  '', 'Do not change this suffix.', ''
].join('\n')
if (tracePath) {
  const entries = (await readFile(tracePath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const failure = entries.find(entry => entry.type === 'markdown-sync-integrity' && entry.source?.includes('`min_ratio`'))
  assert.ok(failure, 'trace has no matching table failure snapshot')
  source = failure.source
}
const sourceRow = source.split('\n').find(line => /^\|\s*`min_ratio`\s*\|/.test(line))
assert.ok(sourceRow && sourceRow.includes('否'), 'target row missing')
const targetOffset = source.indexOf(sourceRow) + sourceRow.indexOf('否')
const emptySource = source.slice(0, targetOffset) + source.slice(targetOffset + 1)
const filledSource = source.slice(0, targetOffset) + '是' + source.slice(targetOffset + 1)
const root = await mkdtemp(join(tmpdir(), 'horsemd-table-cell-replay-'))
const file = join(root, 'table.md')
await writeFile(file, source)
const editor = "([...document.querySelectorAll('.ProseMirror')].find(n => n.offsetParent))"
const waitFor = async (check, message) => {
  for (let i = 0; i < 120; i++) {
    const value = await check()
    if (value) return value
    await sleep(80)
  }
  throw new Error(message)
}
const toggle = app => app.evaluate(`(() => {
  const b = [...document.querySelectorAll('.status-btn')].find(n => n.offsetParent && /源码|Source/.test(n.title || n.textContent || ''))
  b?.click(); return !!b
})()`)
const sourceValue = app => app.evaluate("([...document.querySelectorAll('textarea.source-editor')].find(n => n.offsetParent)?.value) ?? null")
const place = app => app.evaluate(`(() => {
  const e = ${editor}
  const row = [...e.querySelectorAll('tr')].find(n => n.cells[0]?.textContent.trim() === 'min_ratio')
  const p = row?.cells[1]?.querySelector('p')
  if (!p) return false
  p.scrollIntoView({ block: 'center' }); e.focus()
  const r = document.createRange(); r.selectNodeContents(p); r.collapse(false)
  const s = getSelection(); s.removeAllRanges(); s.addRange(r)
  return true
})()`)
const snapshot = app => app.evaluate(`(() => {
  // Keep the same document under test even when source mode hides it.
  const e = globalThis.__hmTableReplayEditor || ${editor}
  if (!e?.isConnected) throw new Error('target editor was unexpectedly unmounted')
  const row = [...e.querySelectorAll('tr')].find(n => n.cells[0]?.textContent.trim() === 'min_ratio')
  return {
    value: row?.cells[1]?.textContent || '',
    columns: [...e.querySelectorAll('tr')].map(n => n.cells.length),
    integrity: (globalThis.__hmSourceIntegrityTrace || []).filter(e => e.ok === false).map(e => ({ reason: e.preservationReason, site: e.validationSite })),
    rejected: (globalThis.__hmSourceSyncCoordinatorTrace || []).filter(e => e.phase === 'rejected').map(e => e.reason),
    published: (globalThis.__hmSourceSyncCoordinatorTrace || []).filter(e => e.phase === 'published').map(e => ({ family: e.family, boundary: e.boundary })),
    toast: document.querySelector('.hm-toast')?.textContent || null
  }
})()`)
const assertClean = (result, label) => {
  console.log(label, JSON.stringify(result))
  assert.equal(result.integrity.length, 0, label + ': first integrity rejection')
  assert.equal(result.rejected.length, 0, label + ': coordinator rejection')
  assert.equal(result.toast, null, label + ': warning toast')
  assert.ok(result.published.some(e => e.family === 'table-cell-plain-text-replace'), label + ': focused owner did not publish')
}
const start = profile => launchBuiltElectron({
  profileDir: join(root, profile), cleanProfile: false,
  port: Number(process.env.CDP_PORT || 27500 + process.pid % 200),
  appArgs: [file, '--horsemd-input-trace']
})
let app = await start('profile')
try {
  await waitFor(() => app.evaluate(`${editor}?.querySelector('table')` + ' ? true : false'), 'table did not mount')
  await sleep(400)
  await app.evaluate(`(globalThis.__hmTableReplayEditor = ${editor}, true)`)
  const before = await snapshot(app)
  assert.equal(await place(app), true)
  await pressKey(app.send, { key: 'Backspace' })
  if (forced) assert.equal(await toggle(app), true)
  await sleep(600)
  const deleted = await snapshot(app)
  assertClean(deleted, 'EMPTY')
  assert.equal(deleted.value, '')
  assert.deepEqual(deleted.columns, before.columns, 'table column count changed')
  if (forced) assert.ok(deleted.published.some(e => e.boundary.includes('forced-flush')), 'forced flush not exercised')
  if (!forced) assert.equal(await toggle(app), true)
  assert.equal(await waitFor(() => sourceValue(app), 'empty source did not open'), emptySource, 'emptying rewrote unrelated source bytes')
  await toggle(app)
  await sleep(150)
  assert.equal(await place(app), true)
  // Chromium IME composition, not a bulk committed-text surrogate.
  await app.send('Input.imeSetComposition', { text: 's', selectionStart: 1, selectionEnd: 1 })
  await app.send('Input.imeSetComposition', { text: 'shi', selectionStart: 3, selectionEnd: 3 })
  await app.send('Input.insertText', { text: '是' })
  await sleep(650)
  const filled = await snapshot(app)
  assertClean(filled, 'REFILLED')
  assert.equal(filled.value, '是')
  assert.deepEqual(filled.columns, before.columns)
  assert.equal(await toggle(app), true)
  assert.equal(await waitFor(() => sourceValue(app), 'filled source did not open'), filledSource, 'refill rewrote unrelated source bytes')
  await app.evaluate("document.querySelector('.hm-save-fab')?.click()")
  await waitFor(async () => (await readFile(file, 'utf8')) === filledSource, 'disk differs from expected full source')
  const traceInfo = await app.evaluate('window.api.getInputTraceInfo()')
  const events = (await readFile(traceInfo.path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(events.some(e => /integrity-failure|preserve-held/.test(e.type)), false, 'hidden first divergence exists')
  assert.ok(events.some(e => e.type === 'compositionstart') && events.some(e => e.type === 'compositionend'), 'real composition lifecycle missing')
  await stopBuiltElectron(app)
  app = await start('cold-profile')
  await waitFor(() => app.evaluate(`${editor}?.querySelector('table')` + ' ? true : false'), 'cold table did not mount')
  await app.evaluate(`(globalThis.__hmTableReplayEditor = ${editor}, true)`)
  const cold = await snapshot(app)
  assert.equal(cold.value, '是')
  assert.deepEqual(cold.columns, before.columns)
  await toggle(app)
  assert.equal(await waitFor(() => sourceValue(app), 'cold source did not open'), filledSource, 'cold reopen changed bytes')
  console.log('PASS table empty/refill: first divergence zero, exact entire source, stable columns, IME lifecycle, disk and cold reopen')
} finally {
  await stopBuiltElectron(app)
  console.log('Evidence retained:', root)
}
