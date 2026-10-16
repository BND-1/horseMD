import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { pressKey } from './lib/human-input.mjs'
import { sleep } from './lib/cdp.mjs'

const forced = process.env.RECONCILE_FORCE === '1'
const input = process.env.RECONCILE_INPUT_PATH
const original = input ? await readFile(input, 'utf8') : [
  '# Regression', '', 'Before the first list.', '',
  '- reads an existing `judged_*.jsonl`;', '- untouched successor;', '',
  'A code fence between two independent edits.', '', '```text', 'keep this code', '```', '',
  '- first later item;', '- responsiveness was attempted 10 times;', '- final later item;', '',
  'Unchanged suffix.', ''
].join('\n')
const target = '- reads an existing `judged_*.jsonl`;'
assert.equal(original.split(target).length, 2, 'expected a unique source anchor')
const source = original.replace(target + '\n', target + '\n- x\n')
const root = await mkdtemp(join(tmpdir(), 'horsemd-unchanged-source-'))
const file = join(root, 'replay.md')
await writeFile(file, source)
const editor = "([...document.querySelectorAll('.ProseMirror')].find(n => n.offsetParent))"
const waitFor = async (check, label) => {
  for (let i = 0; i < 120; i++) {
    const value = await check()
    if (value) return value
    await sleep(80)
  }
  throw new Error(label)
}
const place = (app, text) => app.evaluate(`(() => {
  const e = ${editor}
  const p = [...(e?.querySelectorAll('p') || [])].find(n => n.textContent === ${JSON.stringify(text)})
  if (!p) return false
  p.scrollIntoView({ block: 'center' })
  const range = document.createRange(); range.selectNodeContents(p); range.collapse(false)
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
  e.focus()
  return true
})()`)
const toggle = app => app.evaluate(`(() => {
  const b = [...document.querySelectorAll('.status-btn')].find(n => n.offsetParent && /源码|Source/.test(n.title || n.textContent || ''))
  b?.click(); return !!b
})()`)
const getSource = app => app.evaluate("([...document.querySelectorAll('textarea.source-editor')].find(n => n.offsetParent)?.value) ?? null")
const start = profile => launchBuiltElectron({
  profileDir: join(root, profile), cleanProfile: false,
  port: Number(process.env.CDP_PORT || 27000 + process.pid % 200),
  appArgs: [file, '--horsemd-input-trace']
})
let app = await start('profile')
try {
  await waitFor(() => app.evaluate(`${editor}?.textContent.includes('reads an existing')`), 'document not mounted')
  await sleep(450)
  assert.equal(await place(app, 'x'), true)
  await pressKey(app.send, { key: 'Backspace' })
  await pressKey(app.send, { key: 'Backspace' })
  await sleep(700)
  // The first Backspace empties an item; the second merges it into the
  // preceding item, leaving an editor-only trailing paragraph. Source already
  // has its original five/two items. Measure the NEXT deletion independently.
  await app.evaluate(`(() => {
    for (const key of ['__hmSourceSyncCoordinatorTrace', '__hmSourceIntegrityTrace', '__hmFlushTrace']) globalThis[key] = []
    return true
  })()`)
  const traceInfo = await app.evaluate('window.api.getInputTraceInfo()')
  await app.evaluate("window.api.writeInputTrace({ type: 'reconcile-measure-start' })")
  const traceBefore = (await readFile(traceInfo.path, 'utf8')).length
  await pressKey(app.send, { key: 'Backspace' })
  if (forced) assert.equal(await toggle(app), true, 'immediate source switch missing')
  await sleep(650)
  await app.evaluate("window.api.writeInputTrace({ type: 'reconcile-measure-end' })")
  const events = (await readFile(traceInfo.path, 'utf8')).slice(traceBefore).trim().split('\n').filter(Boolean).map(s => JSON.parse(s))
  const summary = await app.evaluate(`({
    coordinator: (globalThis.__hmSourceSyncCoordinatorTrace || []).map(e => ({ phase: e.phase, reason: e.reason, revision: e.revision, boundary: e.boundary })),
    integrity: (globalThis.__hmSourceIntegrityTrace || []).filter(e => e.ok === false).map(e => ({ reason: e.preservationReason, site: e.validationSite })),
    toast: document.querySelector('.hm-toast')?.textContent || null
  })`)
  console.log('FIRST_DELETION', JSON.stringify({ ...summary, events: events.filter(e => /held|failure/.test(e.type)).map(e => ({ type: e.type, reason: e.reason })) }))
  assert.equal(events.some(e => e.type === 'no-op-preserve-held'), false, 'equivalent source deletion remained held')
  assert.ok(summary.coordinator.some(e => e.phase === 'published'), 'expected validated publication')
  if (input) assert.ok(summary.coordinator.some(e => e.phase === 'published' && e.reason === 'unchanged-source-document-equivalent'), 'real trace must exercise unchanged-source reconciliation')
  assert.equal(summary.integrity.length, 0, 'first deletion failed integrity')
  assert.equal(summary.toast, null)
  if (forced) assert.ok(summary.coordinator.some(e => e.phase === 'published' && e.boundary === 'forced-flush'), 'forced flush was not exercised')
  if (!forced) assert.equal(await toggle(app), true)
  const unchanged = await waitFor(() => getSource(app), 'source view did not open')
  assert.ok(unchanged === original, 'empty paragraph cleanup must preserve every authored source byte')
  await toggle(app)
  await sleep(200)
  assert.equal(await place(app, 'responsiveness was attempted 10 times;'), true)
  await pressKey(app.send, { key: 'Enter' })
  await pressKey(app.send, { key: 'Enter' })
  await sleep(750)
  assert.equal(await app.evaluate("document.querySelector('.hm-toast')?.textContent || null"), null, 'later list edit caused a stale cross-fence failure')
  assert.equal(await toggle(app), true)
  const finalSource = await waitFor(() => getSource(app), 'source view failed after later list exit')
  await app.evaluate("document.querySelector('.hm-save-fab')?.click()")
  await waitFor(async () => (await readFile(file, 'utf8')) === finalSource, 'disk/source mismatch')
  await stopBuiltElectron(app)
  app = await start('cold-profile')
  await waitFor(() => app.evaluate(`${editor}?.textContent.includes('reads an existing')`), 'cold reopen failed')
  assert.equal(await toggle(app), true)
  const reopened = await waitFor(() => getSource(app), 'cold source view failed')
  assert.ok(reopened === finalSource, 'cold reopen changed source bytes')
  if (input) assert.ok(await readFile(input, 'utf8') === original, 'read-only input changed')
  console.log('PASS unchanged source: no held/rejection, byte-identical cleanup, independent later list exit, disk and cold reopen')
} finally {
  await stopBuiltElectron(app)
  console.log('Evidence retained:', root)
}
