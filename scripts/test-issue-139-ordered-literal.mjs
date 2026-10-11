import assert from 'node:assert/strict'
import { canonicalFreshTextToSource } from '../src/renderer/src/lib/markdown-preservation/core.js'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'

for (const value of ['1\\. LEFT', '12\\) LEFT', '0\\.\tLEFT', '999999999\\. LEFT', '> 1\\. LEFT', '   1\\. LEFT']) {
  assert.equal(canonicalFreshTextToSource(value, {preserveOrderedPrefix:true}), value, 'necessary ordered-marker escape removed: ' + value)
}
for (const [input, expected] of [
  ['1\\.', '1.'], ['1\\.2', '1.2'], ['Chapter 1\\. LEFT', 'Chapter 1. LEFT'],
  ['1234567890\\. LEFT', '1234567890. LEFT']
]) assert.equal(canonicalFreshTextToSource(input), expected, 'ordinary inline/unfinished punctuation changed')
for (const value of ['`1\\. LEFT`', '```text\n1\\. LEFT\n```', '<pre>1\\. LEFT</pre>']) {
  assert.equal(canonicalFreshTextToSource(value), value, 'literal region changed')
}
const source = '# AUDIT\n\nANCHOR\n\nTAIL\n'
const next = '# AUDIT\n\n1\\. LEFT  \nRIGHT\n\nTAIL\n'
const result = preserveRichMarkdownSource(source, source, next)
assert.equal(result.preserved, true)
assert.equal(result.markdown, next, 'HTML text paragraph must not become a Markdown ordered list')
assert.equal(canonicalFreshTextToSource('2\\. TEXT', {preserveOrderedPrefix:true,initialLinePrefix:'3. '}), '2. TEXT', 'existing list-item content was treated as a new block')
assert.equal(canonicalFreshTextToSource('1\\. TEXT', {preserveOrderedPrefix:true,initialLinePrefix:'Chapter '}), '1. TEXT', 'mid-paragraph fragment was treated as a new block')
console.log('PASS ordered literal: six protected prefixes, four inline controls, three literal regions and exact-baseline replay')
