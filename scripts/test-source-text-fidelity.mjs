import assert from 'node:assert/strict'
import {
  applyTextareaSourceEdit,
  preserveTextareaSourceEdit,
  sourceOffsetFromTextareaOffset,
  textareaOffsetFromSourceOffset,
  updateTextareaSourceFromDom
} from '../src/renderer/src/source-text-fidelity.js'

const crlf = '\uFEFF# 标题\r\n第一行\r\n第二行\r\n'
assert.equal(
  preserveTextareaSourceEdit(crlf, '\uFEFF# 标题\n第一行X\n第二行\n'),
  '\uFEFF# 标题\r\n第一行X\r\n第二行\r\n',
  'a source-mode text edit must not normalize CRLF or remove the BOM'
)
assert.equal(
  preserveTextareaSourceEdit(crlf, '\uFEFF# 标题\n第一行\n新增行\n第二行\n'),
  '\uFEFF# 标题\r\n第一行\r\n新增行\r\n第二行\r\n',
  'new source-mode lines should inherit the local line ending'
)

const mixed = 'LF\nCRLF\r\n尾部'
assert.equal(
  preserveTextareaSourceEdit(mixed, 'LF\nCRLFX\n尾部'),
  'LF\nCRLFX\r\n尾部',
  'untouched mixed line endings must remain byte-identical'
)

const rawCaret = '\uFEFF一\r\n二\r\n三'
for (let textareaOffset = 0; textareaOffset <= '\uFEFF一\n二\n三'.length; textareaOffset += 1) {
  const rawOffset = sourceOffsetFromTextareaOffset(rawCaret, textareaOffset)
  assert.equal(
    textareaOffsetFromSourceOffset(rawCaret, rawOffset),
    textareaOffset,
    `textarea/source offset round-trip failed at ${textareaOffset}`
  )
}

const typed = {
  value: '\uFEFF# 标题\n第一行X\n第二行\n',
  __horsemdSourceRawValue: crlf
}
assert.equal(updateTextareaSourceFromDom(typed), '\uFEFF# 标题\r\n第一行X\r\n第二行\r\n')

const replaced = {
  value: '\uFEFF# 标题\n第一行\n第二行\n',
  __horsemdSourceRawValue: crlf
}
assert.equal(
  applyTextareaSourceEdit(replaced, '\uFEFF# 标题\n第一行\n替换\n'),
  '\uFEFF# 标题\r\n第一行\r\n替换\r\n'
)
assert.equal(replaced.value, '\uFEFF# 标题\n第一行\n替换\n')

console.log('PASS source textarea fidelity: CRLF, BOM, mixed EOL and offsets')
