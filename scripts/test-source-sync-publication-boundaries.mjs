import assert from 'node:assert/strict'
import fs from 'node:fs'

const editorPath = new URL('../src/renderer/src/components/Editor.jsx', import.meta.url)
const editor = fs.readFileSync(editorPath, 'utf8')

const listStart = editor.indexOf('pendingListConversion === pending')
const listEnd = editor.indexOf('view.focus()', listStart)
assert.ok(listStart >= 0 && listEnd > listStart, 'list conversion command block not found')
const listCommandBlock = editor.slice(listStart, listEnd)

assert.match(
  listCommandBlock,
  /sourceSyncBridge\.publish\(\{[\s\S]*boundary: 'list-conversion-command-snapshot'/,
  'list conversion command snapshot must publish through SourceSyncBridge'
)
assert.doesNotMatch(
  listCommandBlock,
  /lastMarkdownRef\.current\s*=|canonicalMarkdownRef\.current\s*=|onChange\?\.\(/,
  'list conversion command snapshot regained direct publication authority'
)
assert.match(
  listCommandBlock,
  /publication was temporarily stale[\s\S]*userEditUntil = Date\.now\(\) \+ 1000/,
  'temporarily rejected list publication must retain dirty retry state'
)

for (const boundary of [
  'inline-code-value-change',
  'frontmatter-value-change',
  'slash-code-block-atomic',
  'list-conversion-command-snapshot'
]) {
  assert.ok(editor.includes(boundary), `missing SourceSync boundary: ${boundary}`)
}

console.log(
  'PASS source sync publication boundaries: list command snapshot cannot bypass Coordinator; migrated specialty boundaries remain registered'
)
