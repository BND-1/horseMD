// A single list item pasted into another list item inserts only its text;
// the raw-Markdown source hint must be that item's own Markdown without the
// marker / checkbox (continuation lines lose the marker-width indent).
import assert from 'node:assert/strict'
import { listItemInlineMarkdown } from '../src/renderer/src/components/editor-md-paste.js'

assert.equal(listItemInlineMarkdown('3. third\n'), 'third')
assert.equal(listItemInlineMarkdown('- alpha **bold** omega'), 'alpha **bold** omega')
assert.equal(listItemInlineMarkdown('* [ ] task *em*'), 'task *em*')
assert.equal(listItemInlineMarkdown('12) twelve'), 'twelve')
assert.equal(listItemInlineMarkdown('1. line one\n   line two\r\n'), 'line one\nline two')
assert.equal(listItemInlineMarkdown('  - indented'), 'indented')
assert.equal(listItemInlineMarkdown('plain text'), null)
console.log('PASS md paste list item: marker / checkbox stripped from a single pasted item')
