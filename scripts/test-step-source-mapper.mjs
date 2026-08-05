import assert from 'node:assert/strict'
import { StepSourceMapper } from '../src/renderer/src/lib/step-source-mapper.js'

// Existing doc: heading + two paragraphs. PM block positions from the app's
// doc (content ranges).
const source = '# 已有标题\n\n正文内容\n\n结尾段落\n'
const blocks = [
  { type: 'heading', pmStart: 1, pmEnd: 5, text: '已有标题' },
  { type: 'paragraph', pmStart: 8, pmEnd: 12, text: '正文内容' },
  { type: 'paragraph', pmStart: 15, pmEnd: 19, text: '结尾段落' }
]

const m = new StepSourceMapper()
assert.deepEqual(m.bootstrap(source, blocks), { ok: true }, 'existing doc bootstraps')

// typing 追 / 加 at the end of the last paragraph (pm 19 = end of content)
assert.equal(m.applyStep({ kind: 'ReplaceStep', from: 19, to: 19, text: '追', blockType: 'text' }).ok, true)
assert.equal(m.applyStep({ kind: 'ReplaceStep', from: 20, to: 20, text: '加', blockType: 'text' }).ok, true)
assert.equal(m.getSource(), '# 已有标题\n\n正文内容\n\n结尾段落追加\n')

// Enter: block split at pm 21 (end of 追加 content)
assert.equal(m.applyStep({ kind: 'ReplaceStep', from: 21, to: 21, text: '', blockType: 'paragraph' }).ok, true)
assert.equal(m.getSource(), '# 已有标题\n\n正文内容\n\n结尾段落追加\n\n')

// typing in the NEW empty paragraph (this was the failing case: pmPos in the
// structural-edit-created block must map to after the separator)
assert.equal(m.applyStep({ kind: 'ReplaceStep', from: 22, to: 22, text: '新', blockType: 'text' }).ok, true)
assert.equal(m.getSource(), '# 已有标题\n\n正文内容\n\n结尾段落追加\n\n新\n')
assert.equal(m.applyStep({ kind: 'ReplaceStep', from: 23, to: 23, text: '段', blockType: 'text' }).ok, true)
assert.equal(m.getSource(), '# 已有标题\n\n正文内容\n\n结尾段落追加\n\n新段\n')

// backspace deletes 段 then 新
assert.equal(m.applyStep({ kind: 'ReplaceStep', from: 23, to: 24, text: '', blockType: null }).ok, true)
assert.equal(m.getSource(), '# 已有标题\n\n正文内容\n\n结尾段落追加\n\n新\n')
assert.equal(m.applyStep({ kind: 'ReplaceStep', from: 22, to: 23, text: '', blockType: null }).ok, true)
assert.equal(
  m.getSource(),
  '# 已有标题\n\n正文内容\n\n结尾段落追加\n',
  'an emptied trailing paragraph collapses back to the authored terminal newline'
)

// ---- fail-closed checks ----
const m2 = new StepSourceMapper()
m2.bootstrap('# 甲\n\n乙\n', [
  { type: 'paragraph', pmStart: 1, pmEnd: 3, text: '甲' },
  { type: 'paragraph', pmStart: 5, pmEnd: 7, text: '乙' }
])
// unknown step kind: must not touch the source
assert.equal(m2.applyStep({ kind: 'AddMarkStep', from: 1, to: 2, text: '' }).ok, false)
assert.equal(m2.getSource(), '# 甲\n\n乙\n')
// unmapped position: must not touch the source
assert.equal(m2.applyStep({ kind: 'ReplaceStep', from: 100, to: 100, text: 'X', blockType: 'text' }).ok, false)
assert.equal(m2.getSource(), '# 甲\n\n乙\n')
// list markers: bootstrap strips the marker and maps list text linearly
const m3 = new StepSourceMapper()
const r3 = m3.bootstrap('- 甲\n\n- 乙\n', [
  { type: 'bullet_list', pmStart: 3, pmEnd: 4, text: '甲' },
  { type: 'bullet_list', pmStart: 8, pmEnd: 9, text: '乙' }
])
assert.equal(r3.ok, true, 'list marker bootstrap aligns text after the marker')
assert.equal(m3.applyStep({ kind: 'ReplaceStep', from: 9, to: 9, text: '追', blockType: 'text' }).ok, true)
assert.equal(m3.applyStep({ kind: 'ReplaceStep', from: 10, to: 10, text: '加', blockType: 'text' }).ok, true)
assert.equal(m3.getSource(), '- 甲\n\n- 乙追加\n', 'typing inside a list item maps after the marker')

// mismatched bootstrap (unrelated text): fail closed, keep source untouched
const m4 = new StepSourceMapper()
const r4 = m4.bootstrap('# 甲\n\n乙\n', [
  { type: 'paragraph', pmStart: 1, pmEnd: 3, text: '完全不同' },
  { type: 'paragraph', pmStart: 5, pmEnd: 7, text: '乙' }
])
assert.equal(r4.ok, false, 'text mismatch must fail closed at bootstrap')
assert.equal(m4.getSource(), '# 甲\n\n乙\n')

console.log('PASS step-source mapper: typing/Enter/backspace reconstruct source; unmapped steps fail closed')
