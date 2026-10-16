import assert from 'node:assert/strict'
import { convertSourceParagraphLineToList } from '../src/renderer/src/components/editor-block-list-source.js'

const source = [
  '# Title',
  '',
  'Normal paragraph.',
  '',
  '  Indented paragraph.',
  '',
  '- Existing list item.'
].join('\n')

const normalOffset = source.indexOf('Normal') + 3
const indentedOffset = source.indexOf('Indented') + 2

assert.equal(
  convertSourceParagraphLineToList(source, normalOffset, 'bullet_list'),
  source.replace('Normal paragraph.', '- Normal paragraph.')
)
assert.equal(
  convertSourceParagraphLineToList(source, normalOffset, 'ordered_list'),
  source.replace('Normal paragraph.', '1. Normal paragraph.')
)
assert.equal(
  convertSourceParagraphLineToList(source, indentedOffset, 'task_list'),
  source.replace('  Indented paragraph.', '  - [ ] Indented paragraph.')
)
assert.equal(convertSourceParagraphLineToList(source, source.indexOf('# Title'), 'bullet_list'), null)
assert.equal(convertSourceParagraphLineToList(source, source.indexOf('Existing'), 'bullet_list'), null)
assert.equal(convertSourceParagraphLineToList(source, normalOffset, 'unknown'), null)

console.log('PASS block list source: only the targeted authored paragraph line receives the requested list marker')
