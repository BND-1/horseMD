import assert from 'node:assert/strict'
import {
  preserveOwnedTypedBulletInputRule,
  preserveRichMarkdownSource
} from '../src/renderer/src/markdown-source-preservation.js'

const source = '前文\n\n1. 已有\n\n\\-\n'
const previousCanonical = '前文\n\n1. 已有\n\n\\-\n'
const canonical = '前文\n\n1. 已有\n\n* <br />\n'
const sourceOffset = source.indexOf('\\-')
const sourceSlotRawStart = source.length - 1

// Replays the RS-41/RS-44 trace shape: generic preservation has already
// rewritten the newly-created bullet to Crepe's default marker, while the
// physical input intent still owns the captured escaped marker line.
const generic = preserveRichMarkdownSource(source, previousCanonical, canonical)
assert.equal(generic.markdown, '前文\n\n1. 已有\n\n* \n')

const owned = preserveOwnedTypedBulletInputRule({
  source,
  currentSource: source,
  preservedSource: generic.markdown,
  canonical,
  previousCanonical,
  sourceOffset,
  sourceSlotRawStart,
  canonicalOffset: canonical.indexOf('* '),
  marker: '-'
})
assert.equal(owned, '前文\n\n1. 已有\n\n- \n')
assert.equal(owned.slice(0, source.indexOf('\\-')), source.slice(0, source.indexOf('\\-')))
assert.equal(owned.endsWith('\n'), true)

// Once an unrelated edit makes the captured snapshot stale, the helper must
// retain the old raw-slot proof and reject instead of merging by guesswork.
const stale = preserveOwnedTypedBulletInputRule({
  source,
  currentSource: source.replace('前文', '前文改'),
  preservedSource: generic.markdown.replace('前文', '前文改'),
  canonical,
  previousCanonical,
  sourceOffset,
  sourceSlotRawStart,
  canonicalOffset: canonical.indexOf('* '),
  marker: '-'
})
assert.equal(stale, null)

// Human cadence regression from PID 38820: after exiting an existing bullet
// list, the dash callback has already published a standalone `\\-`. Crepe then
// serializes the old sibling bullets and the new empty bullet as one loose list.
// Exact source-row ownership must replace ONLY the new item; using the whole
// canonical list block duplicates the previous bullets.
const middleSource = [
  '# 无序列表测试', '',
  '- 看了呢分',
  '- 1\\. 当然会更多人', '',
  '\\-', '',
  '2. 斛律v哦', ''
].join('\n')
const middlePrevious = [
  '# 无序列表测试', '',
  '* 看了呢分', '',
  '* 1\\. 当然会更多人', '',
  '\\-', '',
  '2. 斛律v哦', ''
].join('\n')
const middleCanonical = [
  '# 无序列表测试', '',
  '* 看了呢分', '',
  '* 1\\. 当然会更多人', '',
  '* <br />', '',
  '2. 斛律v哦', ''
].join('\n')
const middleOwned = preserveOwnedTypedBulletInputRule({
  source: middleSource,
  currentSource: middleSource,
  preservedSource: middleSource,
  canonical: middleCanonical,
  previousCanonical: middlePrevious,
  sourceOffset: middleSource.indexOf('\\-'),
  sourceSlotRawStart: null,
  // Deliberately stale after Space: the real PM position remapped into the
  // preceding existing list item. Exact `\\-` ownership must still win.
  canonicalOffset: middleCanonical.indexOf('* 1\\. 当然会更多人'),
  marker: '-'
})
assert.equal(
  middleOwned,
  middleSource.replace('\\-\n\n2. 斛律v哦', '- \n\n2. 斛律v哦'),
  'owned middle escaped marker must rebuild only the new empty bullet item'
)
assert.equal((middleOwned.match(/- 看了呢分/g) || []).length, 1, 'previous bullet list must not be duplicated')

console.log('PASS RS-41 source sync regressions: escaped marker ownership stays local, including human mid-document list exit')
