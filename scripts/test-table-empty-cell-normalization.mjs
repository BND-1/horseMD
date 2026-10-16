import assert from 'node:assert/strict'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'

const nextWithNewTable = [
  '# Demo',
  '',
  '| Name | Notes |',
  '| --- | --- |',
  '| <br /> | <br /> |'
].join('\n')

const inserted = preserveRichMarkdownSource('# Demo\n', '# Demo\n', nextWithNewTable)
assert.equal(inserted.preserved, true)
assert.match(inserted.markdown, /\|\s*\|\s*\|/)
assert.doesNotMatch(inserted.markdown, /\|\s*<br\s*\/?>/i)

const withRealBreak = [
  '# Demo',
  '',
  '| Name | Notes |',
  '| --- | --- |',
  '| horse | first<br>second |',
  '| <br /> | <br /> |'
].join('\n')
const normalized = preserveRichMarkdownSource('', '', withRealBreak)
assert.match(normalized.markdown, /first<br>second/)
assert.doesNotMatch(normalized.markdown, /\|\s*<br\s*\/?>/i)

console.log('PASS table empty-cell normalization: new tables keep empty cells as GFM blanks')
