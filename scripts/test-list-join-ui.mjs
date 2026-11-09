// Lists an edit puts directly next to each other join when the file reads
// them as one — same marker (editor-list-join.js, Typora parity). Real keys:
// - `- ` on the line above a list: the new item is the list's first;
// - `1. ` on the line after an ordered list: it continues (item 3, `3.`
//   in the file — never a `1)` the user did not type);
// - `- ` typed above a `*` list, or lists written apart with different
//   markers: two lists in Markdown, they stay two (`* b` kept);
// - deleting the paragraph between two lists joins them.
// Each: no sync warning, and the saved file reopens with the same lists.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { open, sleep } from './lib/probe-session.mjs'

const shape = `(() => { const d = globalThis.__hmSourceReprintHarness.liveDoc(); const out = []
  d.forEach((n) => { if (n.type.name === 'paragraph' && !n.content.size) return; out.push(n.type.name.endsWith('list') ? n.type.name + '(' + n.childCount + ')' : n.type.name) })
  return out.join(' ') })()`

const cases = [
  { name: 'typed bullet list above a list joins it', source: '# t\n\npara\n\n- x\n- y\n', steps: async (s) => { await s.clickText('para'); await s.key('Enter'); await s.type('- '); await s.type('new') }, shape: 'heading paragraph bullet_list(3)', file: '# t\n\npara\n\n- new\n- x\n- y\n' },
  { name: 'typed 1. after an ordered list continues it', source: '1. a\n2. b\n\nend\n', steps: async (s) => { await s.clickText('b'); await s.key('Enter'); await s.key('Enter'); await s.type('1. '); await s.type('c') }, shape: 'ordered_list(3) paragraph', file: '1. a\n2. b\n3. c\n\nend\n' },
  { name: 'typed `- ` above a `*` list stays a list of its own (other marker)', source: '# t\n\npara\n\n* x\n* y\n', steps: async (s) => { await s.clickText('para'); await s.key('Enter'); await s.type('- '); await s.type('new') }, shape: 'heading paragraph bullet_list(1) bullet_list(2)' },
  { name: 'lists written apart stay two', source: '- a\n* b\n\nend\n', steps: async (s) => { await s.clickText('b'); await s.type('z') }, shape: 'bullet_list(1) bullet_list(1) paragraph', file: '- a\n* bz\n\nend\n' },
  // Inside a later item (not the first): the list-boundary pass read
  // ProseMirror's forEach offset as the item index and never looked into
  // items after the first (fuzz seed 5210) — the fallback writer then saved
  // one list where the editor showed two.
  { name: 'bullet list made next to a nested list in the second item joins it', source: '- a\n- b\n\n  second\n  - n A\n  - n B\n- c\n', steps: async (s) => { await s.clickText('second', 2); await s.key('8', { code: 'Digit8', modifiers: (process.platform === 'darwin' ? 4 : 2) | 1 }) }, shape: 'bullet_list(3)', nested: 3, file: '- a\n- b\n\n  - second\n  - n A\n  - n B\n- c\n' },
  { name: 'deleting the paragraph between two lists joins them', source: '- a\n\nmid\n\n- b\n\nend\n', steps: async (s) => { await s.clickText('mid'); for (let i = 0; i < 4; i += 1) await s.key('Backspace') }, shape: 'bullet_list(2) paragraph' }
]

let failures = 0
let port = 9580
for (const testCase of cases) {
  const s = await open(`list-join-${port}`, testCase.source, port)
  port += 1
  try {
    await testCase.steps(s)
    await sleep(1500)
    const live = JSON.parse(await s.trace(shape))
    assert.equal(live, testCase.shape, 'editor lists')
    if (testCase.nested) assert.equal(JSON.parse(await s.trace(`(() => { const d = globalThis.__hmSourceReprintHarness.liveDoc(); const item = d.firstChild.child(1); const lists = []; item.forEach((n) => { if (n.type.name.endsWith('list')) lists.push(n.childCount) }); return lists.join(',') })()`)), String(testCase.nested), 'nested lists')
    const source = await s.source()
    if (testCase.file) assert.equal(source, testCase.file, 'source')
    assert.deepEqual((await s.toasts()).filter((text) => /不一致|无法安全|暂停/.test(text)), [], 'sync warning')
    await s.app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(800)
    const saved = await readFile(s.file, 'utf8')
    assert.equal(saved, source, 'saved bytes = source mode')
    const reopened = JSON.parse(await s.trace(`(() => { const h = globalThis.__hmSourceReprintHarness; const d = h.parse(${JSON.stringify(saved)}); const out = []; d.forEach((n) => { if (n.type.name === 'paragraph' && !n.content.size) return; out.push(n.type.name.endsWith('list') ? n.type.name + '(' + n.childCount + ')' : n.type.name) }); return out.join(' ') })()`))
    assert.equal(reopened, testCase.shape, 'reopened lists')
    console.log(`ok   ${testCase.name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${testCase.name}: ${String(error.message).slice(0, 500)}`)
  } finally {
    await s.close()
  }
}
if (failures) {
  console.log(`FAIL list join: ${failures}/${cases.length}`)
  process.exit(1)
}
console.log(`PASS list join: ${cases.length} cases — lists an edit makes adjacent join, authored separate lists stay apart, no warning, saved file reopens the same`)
