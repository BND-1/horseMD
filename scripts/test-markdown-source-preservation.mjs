import assert from 'node:assert/strict'
import {
  generatedScratchMarkdown,
  preserveCoalescedEmptyBulletExitBeforeSibling,
  preserveCrossListSelectionDeleteToEmptyBullet,
  preserveEmptyOrderedItemBackspaceMergeBeforeNestedList,
  preserveGeneratedBulletMarkers,
  preserveRichMarkdownSource,
  preserveTypedBulletInputRule,
  replaceMarkdownFrontmatterBlock,
  replaceMarkdownListBlock,
  restoreTypedBulletMarker
} from '../src/renderer/src/markdown-source-preservation.js'
import { sourceVisibleIndex } from '../src/renderer/src/mode-visible-map.js'
import { areMarkdownListSlotsEquivalent } from '../src/renderer/src/lib/source-structure-fingerprint.js'
import {
  canonicalFreshTextToSource,
  commonChange
} from '../src/renderer/src/lib/markdown-preservation/core.js'
import { preserveEmptyListItemTextChange } from '../src/renderer/src/lib/markdown-preservation/lists.js'
import { preserveEscapedStandaloneThematicBreakInputRule } from '../src/renderer/src/lib/markdown-preservation/paragraphs.js'
import {
  preserveLocallyAlignedTextChange,
  preserveUniquelyAnchoredTextChange
} from '../src/renderer/src/lib/markdown-preservation/regions.js'
import {
  applySlashBlockSourceIntent,
  captureSlashBlockSourceIntent
} from '../src/renderer/src/components/editor-slash-source.js'

const source = [
  '# 一级标题',
  '## 二级标题',
  '这里是区间：0~9。',
  '',
  '- 第一项末尾\\',
  '  这是同一个列表项中的换行',
  '- 第二项',
  '',
  '这一段不要修改。'
].join('\n')

const slashSource = '前文\r\n\r\n# /code\r\n\r\n后文\r\n'
const slashIntent = captureSlashBlockSourceIntent({
  source: slashSource,
  queryText: '/code',
  sourceOffset: slashSource.indexOf('/code') + 5,
  id: 'code'
})
assert.ok(slashIntent, 'slash code intent must locate its exact authored block')
assert.equal(
  applySlashBlockSourceIntent({ intent: slashIntent, blockMarkdown: '```js\n\n```\n' }),
  '前文\r\n\r\n```js\r\n\r\n```\r\n\r\n后文\r\n',
  'slash code conversion must atomically replace only its block and retain CRLF'
)
const slashMathSource = '前文\r\n\r\n/math\r\n\r\n后文\r\n'
const slashMathIntent = captureSlashBlockSourceIntent({
  source: slashMathSource,
  queryText: '/math',
  sourceOffset: slashMathSource.indexOf('/math') + 5,
  id: 'math'
})
assert.equal(
  applySlashBlockSourceIntent({ intent: slashMathIntent, blockMarkdown: '$$\nx^2 + 1\n$$\n' }),
  '前文\r\n\r\n$$\r\nx^2 + 1\r\n$$\r\n\r\n后文\r\n',
  'slash math conversion must atomically replace only its query row and retain CRLF'
)
assert.equal(
  applySlashBlockSourceIntent({ intent: slashMathIntent, blockMarkdown: '$$\n\n$$\n' }),
  '前文\r\n\r\n$$\r\n$$\r\n\r\n后文\r\n',
  'slash-created empty math must discard the isolated serializer blank row'
)
assert.equal(
  applySlashBlockSourceIntent({ intent: slashMathIntent, blockMarkdown: '$$\nx^2 + 1\n' }),
  null,
  'slash math must reject a display block without its closing dollars'
)
assert.equal(
  applySlashBlockSourceIntent({ intent: slashIntent, blockMarkdown: '$$\nx^2 + 1\n$$\n' }),
  null,
  'a normal code command must not claim a display-math serializer result'
)
assert.equal(
  captureSlashBlockSourceIntent({
    source: '/code\n\n/code\n',
    queryText: '/code',
    sourceOffset: null,
    id: 'code'
  }),
  null,
  'an unmapped repeated slash query must fail closed instead of replacing the wrong block'
)
const repeatedSlashSource = '/code\n\n正文\n\n/code\n'
const repeatedSlashIntent = captureSlashBlockSourceIntent({
  source: repeatedSlashSource,
  queryText: '/code',
  sourceOffset: repeatedSlashSource.lastIndexOf('/code') + 5,
  id: 'code'
})
assert.equal(
  applySlashBlockSourceIntent({ intent: repeatedSlashIntent, blockMarkdown: '```\n\n```\n' }),
  '/code\n\n正文\n\n```\n\n```\n',
  'a mapped repeated slash query must replace only the selected occurrence'
)
const mixedEndingSlashSource = '旧式行尾\r\n邻近行尾\n/code'
const mixedEndingSlashIntent = captureSlashBlockSourceIntent({
  source: mixedEndingSlashSource,
  queryText: '/code',
  sourceOffset: mixedEndingSlashSource.length,
  id: 'code'
})
assert.equal(
  applySlashBlockSourceIntent({ intent: mixedEndingSlashIntent, blockMarkdown: '```\n内容\n```\n' }),
  '旧式行尾\r\n邻近行尾\n```\n内容\n```',
  'a final slash block without its own EOL must inherit the nearest preceding line ending'
)

assert.equal(
  sourceVisibleIndex('硬换行  \n下一行').text,
  sourceVisibleIndex('硬换行\\\n下一行').text,
  'equivalent Markdown hard-break spellings must share one visible stream'
)

/* assert.equal(
  areMarkdownListSlotsEquivalent(
    '1. 内容\n2. <br />\n',
    '1. 内容\n1. \n'
  ),
  true,
  'list markers may be normalized when the item slots are identical'
) */
/* assert.equal(
  areMarkdownListSlotsEquivalent(
    '1. 内容\n1. \n3. \n',
    '1. 内容\n2. <br />\n3. <br />\n',
    { strictOrderedNumbers: true }
  ),
  false,
  'strict list-slot validation must reject a silently renumbered empty item'
) */

// This is the equivalent Markdown emitted by Crepe before any user edit.
const canonical = [
  '# 一级标题',
  '',
  '## 二级标题',
  '',
  '这里是区间：0\\~9。',
  '',
  '* 第一项末尾\\',
  '  这是同一个列表项中的换行',
  '',
  '* 第二项',
  '',
  '这一段不要修改。'
].join('\n')

const appended = preserveRichMarkdownSource(source, canonical, canonical + '！')
assert.equal(appended.preserved, true)
assert.equal(appended.markdown, source + '！')

const changedText = preserveRichMarkdownSource(
  source,
  canonical,
  canonical.replace('这一段不要修改。', '这一段已经修改。')
)
assert.equal(changedText.preserved, true)
assert.equal(changedText.markdown, source.replace('这一段不要修改。', '这一段已经修改。'))

const mismatch = preserveRichMarkdownSource('原文 A', '原文 B', '原文 C')
assert.equal(mismatch.preserved, false)
assert.equal(mismatch.markdown, '原文 A')
assert.equal(mismatch.reason, 'visible-stream-mismatch')

// PID 52425 event 127: after a source/canonical-diverged document had safely
// persisted `1. -sf `, typing body text at the editor line end produced the
// canonical `1. -sf aef`. The trailing space is invisible to the visible-index
// mapper, whose backward affinity used to place `aef` before that space and
// persist `1. -sfaef `. A locally-aligned pure insertion at the raw line end
// must cross only the authored horizontal-whitespace tail.
const trailingSpaceAppendSource = '前文\n\n1. -sf \n\n后文\n'
const trailingSpaceAppendPrevious = trailingSpaceAppendSource
const trailingSpaceAppendNext = '前文\n\n1. -sf aef\n\n后文\n'
const trailingSpaceAppendChange = commonChange(trailingSpaceAppendPrevious, trailingSpaceAppendNext)
const trailingSpaceAppend = preserveLocallyAlignedTextChange({
  source: trailingSpaceAppendSource,
  previous: trailingSpaceAppendPrevious,
  next: trailingSpaceAppendNext,
  ...trailingSpaceAppendChange
})
assert.equal(trailingSpaceAppend?.reason, 'locally-aligned-change')
assert.equal(
  trailingSpaceAppend?.markdown,
  trailingSpaceAppendNext,
  'text typed after one authored trailing space must stay after that space'
)

const hardBreakTailSource = '前文\n\n1. -sf  \n\n后文\n'
const hardBreakTailNext = '前文\n\n1. -sf  aef\n\n后文\n'
const hardBreakTailChange = commonChange(hardBreakTailSource, hardBreakTailNext)
const hardBreakTailAppend = preserveLocallyAlignedTextChange({
  source: hardBreakTailSource,
  previous: hardBreakTailSource,
  next: hardBreakTailNext,
  ...hardBreakTailChange
})
assert.equal(
  hardBreakTailAppend?.markdown,
  hardBreakTailNext,
  'line-end insertion must preserve an authored two-space tail before the new body text'
)

const beforeTrailingSpaceSource = '前文\n\n1. -sf \n\n后文\n'
const beforeTrailingSpaceNext = '前文\n\n1. -sfX \n\n后文\n'
const beforeTrailingSpaceChange = commonChange(beforeTrailingSpaceSource, beforeTrailingSpaceNext)
const beforeTrailingSpaceInsert = preserveLocallyAlignedTextChange({
  source: beforeTrailingSpaceSource,
  previous: beforeTrailingSpaceSource,
  next: beforeTrailingSpaceNext,
  ...beforeTrailingSpaceChange
})
assert.equal(
  beforeTrailingSpaceInsert?.markdown,
  beforeTrailingSpaceNext,
  'an insertion explicitly before the trailing space must not be shifted past it'
)

// RS-59 / PID 97146 trace line 70: an authored standalone literal dash is
// represented as `\\-`. After filling that formerly-empty paragraph, typing
// more text makes canonical rewrite the same paragraph as `-【】`. If an earlier
// source/canonical marker spelling already diverges (`-` vs `*`), ordinal visible
// mapping must not bind the dash paragraph's zero-width boundary to the end of
// the preceding `哈哈；` line and persist `哈哈；-【】`.
const escapedStandaloneExpandSource = '- 前文\n\n哈哈；\n\n\\-\n\n***\n'
const escapedStandaloneExpandPrevious = '* 前文\n\n哈哈；\n\n\\-\n\n***\n'
const escapedStandaloneExpandNext = '* 前文\n\n哈哈；\n\n-【】\n\n***\n'
const escapedStandaloneExpand = preserveRichMarkdownSource(
  escapedStandaloneExpandSource,
  escapedStandaloneExpandPrevious,
  escapedStandaloneExpandNext
)
assert.equal(escapedStandaloneExpand.preserved, true)
assert.equal(escapedStandaloneExpand.reason, 'mapped-line-change')
assert.equal(
  escapedStandaloneExpand.markdown,
  '- 前文\n\n哈哈；\n\n-【】\n\n***\n',
  'expanding an escaped standalone punctuation paragraph must preserve its sibling block boundary'
)

// RS-59 adjacent guard: document-level reference definitions must remain part
// of line identity. Re-indexing the source line in isolation makes `[shortcut]`
// look like literal brackets while canonical's inline link renders as only
// `shortcut`, causing the safe line to be rejected as `unmapped-change`.
const shortcutReferenceEditSource = [
  '[shortcut] 简写引用与 SHORTCUT_AFTER 共存。',
  '',
  '[shortcut]: https://example.com/shortcut',
  '',
  'REF_AFTERX 位于引用定义之后。',
  ''
].join('\n')
const shortcutReferenceEditPrevious = [
  '[shortcut](https://example.com/shortcut) 简写引用与 SHORTCUT\\_AFTER 共存。',
  '',
  'REF\\_AFTERX 位于引用定义之后。',
  ''
].join('\n')
const shortcutReferenceEditNext = shortcutReferenceEditPrevious.replace(
  'SHORTCUT\\_AFTER',
  'SHORTCUT\\_AFTERX'
)
const shortcutReferenceEdit = preserveRichMarkdownSource(
  shortcutReferenceEditSource,
  shortcutReferenceEditPrevious,
  shortcutReferenceEditNext
)
assert.equal(shortcutReferenceEdit.preserved, true)
assert.equal(
  shortcutReferenceEdit.markdown,
  shortcutReferenceEditSource.replace('SHORTCUT_AFTER', 'SHORTCUT_AFTERX'),
  'RS-59 line identity must preserve shortcut-reference authoring while editing the same rendered paragraph'
)
assert.notEqual(
  shortcutReferenceEdit.reason,
  'unmapped-change',
  'document-level reference context must prevent a false RS-59 line mismatch'
)

// PID 58216 event 390: a single empty ordered list between two authored
// bullet regions is lifted to an empty bullet by the first Backspace. The
// canonical serializer merges the left bullet block with that empty row, while
// the authored source still has blank separators around `1. `. Patch only the
// empty row marker so the second Backspace can remove it normally.
const isolatedEmptyOrderedLiftSource = '- 1\\. 是人干v是v\n\n1. \n\n- u高科技\n\n-   1. 二哥你来拿如果\n  - \u200B     就了解了呢\n  * 如果可能老顾客\n'
const isolatedEmptyOrderedLiftPrevious = '* 1\\. 是人干v是v\n\n1. <br />\n\n* u高科技\n\n* <br />\n\n  1. 二哥你来拿如果\n\n* &#x20;    就了解了呢\n\n- 如果可能老顾客\n\n'
const isolatedEmptyOrderedLiftNext = '* 1\\. 是人干v是v\n* <br />\n\n- u高科技\n\n* <br />\n\n  1. 二哥你来拿如果\n\n* &#x20;    就了解了呢\n\n- 如果可能老顾客\n\n'
const isolatedEmptyOrderedLift = preserveRichMarkdownSource(
  isolatedEmptyOrderedLiftSource,
  isolatedEmptyOrderedLiftPrevious,
  isolatedEmptyOrderedLiftNext
)
assert.equal(isolatedEmptyOrderedLift.preserved, true)
assert.equal(isolatedEmptyOrderedLift.reason, 'diverged-isolated-empty-ordered-backspace-lift')
assert.equal(
  isolatedEmptyOrderedLift.markdown,
  '- 1\\. 是人干v是v\n\n- \n\n- u高科技\n\n-   1. 二哥你来拿如果\n  - \u200B     就了解了呢\n  * 如果可能老顾客\n',
  'first Backspace on an isolated empty ordered row must change only its marker while retaining unrelated diverged nested-list spelling byte-for-byte'
)
const isolatedEmptyOrderedLooseLiftNext = isolatedEmptyOrderedLiftNext.replace(
  '* 1\\. 是人干v是v\n* <br />',
  '* 1\\. 是人干v是v\n\n* <br />'
)
const isolatedEmptyOrderedLooseLift = preserveRichMarkdownSource(
  isolatedEmptyOrderedLiftSource,
  isolatedEmptyOrderedLiftPrevious,
  isolatedEmptyOrderedLooseLiftNext
)
assert.equal(isolatedEmptyOrderedLooseLift.preserved, true)
assert.equal(isolatedEmptyOrderedLooseLift.reason, 'diverged-isolated-empty-ordered-backspace-lift')
assert.equal(
  isolatedEmptyOrderedLooseLift.markdown,
  isolatedEmptyOrderedLift.markdown,
  'Crepe loose-list serialization after the Backspace lift must map to the same authored source marker change'
)

// PID 49164 real trace, minimized through the first later block that keeps
// the document in the diverged-list path. A fast human cadence can publish
// `- 1`, then coalesce `.` + Space into Crepe's transient `* 1. ` frame before
// an independent `1\\.` source sync occurs. The diverged-list bridge must own
// that single item and encode the temporary nested ordered slot with its
// required trailing space instead of producing the structurally different
// `- 1.` spelling.
const fastInlineOrderedDivergedSource = '# 无序列表测试\n\n- 可就是被科技部\n- 老板老板娘\n  - s 入了你看你了\n\n吗；啊嗯\n\n- 看了呢分\n\n1. 看了你离开你了\n2. \\\\- 色；了麻烦；看\n\n- 看了你快乐呢\n- 1\n\n2. 斛律v哦\n\n- u高科技\n\n```\n尼玛，吗了解\n了几百块\n```\n\n1. 吗。不开机；口红\n\n2. 斯卡洛尼快乐\n3. 是干嘛的了；吗\n4. ​ 热度三个代表\n\n- 是v的；发布\n\n- 露娜了\n\n啊额绿化\n\n1\n\n-   1. 二哥你来拿如果\n  - ​     就了解了呢\n  * 如果可能老顾客\n\n安乐分\n'
const fastInlineOrderedDivergedPrevious = '# 无序列表测试\n\n* 可就是被科技部\n\n* 老板老板娘\n\n  * s 入了你看你了\n\n吗；啊嗯\n\n* 看了呢分\n\n1. 看了你离开你了\n2. \\\\- 色；了麻烦；看\n\n* 看了你快乐呢\n* 1\n\n2. 斛律v哦\n\n* u高科技\n\n```\n尼玛，吗了解\n了几百块\n```\n\n1. 吗。不开机；口红\n\n2. 斯卡洛尼快乐\n\n3. 是干嘛的了；吗\n\n4. &#x20;热度三个代表\n\n* 是v的；发布\n\n* 露娜了\n\n啊额绿化\n\n1\n\n* <br />\n\n  1. 二哥你来拿如果\n\n* &#x20;    就了解了呢\n\n- 如果可能老顾客\n\n安乐分\n'
const fastInlineOrderedDivergedNext = fastInlineOrderedDivergedPrevious.replace(
  '* 看了你快乐呢\n* 1\n\n2. 斛律v哦',
  '* 看了你快乐呢\n* 1. \n\n2. 斛律v哦'
)
const fastInlineOrderedDiverged = preserveRichMarkdownSource(
  fastInlineOrderedDivergedSource,
  fastInlineOrderedDivergedPrevious,
  fastInlineOrderedDivergedNext
)
assert.equal(fastInlineOrderedDiverged.preserved, true)
assert.equal(fastInlineOrderedDiverged.reason, 'diverged-inline-ordered-input-rule')
assert.match(
  fastInlineOrderedDiverged.markdown,
  /- 看了你快乐呢\n-   1\. \n\n2\. 斛律v哦/,
  'fast coalesced ordered input rule in a diverged document must retain the temporary nested slot trailing space'
)
assert.doesNotMatch(
  fastInlineOrderedDiverged.markdown,
  /- 看了你快乐呢\n- 1\.\n/,
  'fast coalesced ordered input rule must not collapse the transient structure into a bare - 1. source line'
)
assert.match(
  fastInlineOrderedDiverged.markdown,
  /```\n尼玛，吗了解\n了几百块\n```/,
  'the diverged inline ordered bridge must not rewrite the authored fence'
)
assert.match(
  fastInlineOrderedDiverged.markdown,
  /-   1\. 二哥你来拿如果\n  - ​     就了解了呢\n  \* 如果可能老顾客/,
  'the diverged inline ordered bridge must retain unrelated nested-list spelling byte-for-byte'
)

// A paragraph split must remain mappable even when an earlier list has a
// permanent source/canonical marker divergence. The transaction changes only
// the block boundary; it must not enter the global visible-stream fallback.
const splitSource = '# 森林\n\n了科纳克里；你\n\n- 文本\n'
const splitPrevious = '# 森林\n\n了科纳克里；你\n\n* 文本\n'
const splitNext = '# 森林\n\n了科纳克里；\n\n你\n\n* 文本\n'
const split = preserveRichMarkdownSource(splitSource, splitPrevious, splitNext)
assert.equal(split.preserved, true)
assert.equal(split.reason, 'paragraph-split')
assert.equal(
  split.markdown,
  '# 森林\n\n了科纳克里；\n\n你\n\n- 文本\n',
  'a middle paragraph split must preserve the authored list marker and insert only the new boundary'
)

const mismatchAfterEditedLineSource = [
  '审计起点：0~9。',
  '',
  '后文保留单波浪号 A~B 和 C~D。'
].join('\n')
const mismatchAfterEditedLineCanonical = [
  '审计起点：0\\~9。',
  '',
  '后文保留单波浪号 AB 和 CD。'
].join('\n')
const mismatchAfterEditedLine = preserveRichMarkdownSource(
  mismatchAfterEditedLineSource,
  mismatchAfterEditedLineCanonical,
  mismatchAfterEditedLineCanonical.replace('审计起点', '审计起点X')
)
assert.equal(mismatchAfterEditedLine.preserved, true)
assert.equal(mismatchAfterEditedLine.reason, 'locally-aligned-change')
assert.equal(
  mismatchAfterEditedLine.markdown,
  mismatchAfterEditedLineSource.replace('审计起点', '审计起点X'),
  'a later visible-stream mismatch must not normalize untouched syntax on the locally edited line'
)

const headingEditMustNotRewriteUnchangedLists = preserveRichMarkdownSource(
  'SETEXT_TARGET\n=============\n\n- LIST_CHILD\n\n- [ ] TASK_TARGET\n',
  '# SETEXT\\_TARGET\n\n* LIST\\_CHILD\n\n* [ ] TASK\\_TARGET\n',
  '# SETEXT\\_TARGETX\n\n* LIST\\_CHILD\n\n* [ ] TASK\\_TARGET\n'
)
assert.equal(
  headingEditMustNotRewriteUnchangedLists.markdown,
  'SETEXT_TARGETX\n=============\n\n- LIST_CHILD\n\n- [ ] TASK_TARGET\n',
  'an unchanged canonical list must not consume or normalize an unrelated heading edit'
)

// A visible-stream divergence (source keeps a mid-line `* ` as paragraph text
// while remark parses it as a list item) defeats both locally-aligned and
// line-region mapping. A single-canonical-block text change whose block text
// occurs exactly once in the authored source must still reach the source, or
// a rich-text deletion is silently rolled back and resurrects on save.
const divergedDeleteSource = '# 测试\n\n前段。* **输入设备：** 内容\n\n第二段保留。\n'
const divergedDeletePrevious = '# 测试\n\n前段。\n\n* **输入设备：** 内容\n\n第二段保留。\n'
const divergedDeleteNext = '# 测试\n\n前段。\n\n* **内容**\n\n第二段保留。\n'
const divergedDelete = preserveRichMarkdownSource(
  divergedDeleteSource,
  divergedDeletePrevious,
  divergedDeleteNext
)
assert.equal(
  divergedDelete.reason,
  'diverged-block-change',
  'a diverged-stream deletion must map through the unique-block fallback'
)
assert.equal(
  divergedDelete.markdown,
  '# 测试\n\n前段。* **内容**\n\n第二段保留。\n',
  'the deleted text must vanish from source while the authored mid-line syntax survives'
)

// The real-app canonical spelling escapes the literal `*` as `\*` and the
// surviving trailing space as `&#x20;`. The fallback must unescape the
// canonical block to locate the authored occurrence and spell the replacement
// in the author's plain-Markdown form.
const divergedEscapedDeleteSource = '# 测试\n\n前段。* **输入设备：** 内容\n\n第二段保留。\n'
const divergedEscapedDeletePrevious = '# 测试\n\n前段。\\* **输入设备：** 内容\n\n第二段保留。\n'
const divergedEscapedDeleteNext = '# 测试\n\n前段。\\*&#x20;\n\n第二段保留。\n'
const divergedEscapedDelete = preserveRichMarkdownSource(
  divergedEscapedDeleteSource,
  divergedEscapedDeletePrevious,
  divergedEscapedDeleteNext
)
assert.equal(
  divergedEscapedDelete.reason,
  'diverged-block-change',
  'a diverged-stream deletion must map through the unescaped unique-block fallback'
)
assert.equal(
  divergedEscapedDelete.markdown,
  '# 测试\n\n前段。* \n\n第二段保留。\n',
  'the deleted text must vanish while the authored literal `*` spelling survives (no `\\*`, no `&#x20;`)'
)

// A canonical-only empty-paragraph `<br />` placeholder must never reach
// authored source through the diverged-block fallback; those edits belong to
// the paragraph-emptied handlers.
const divergedBrBail = preserveRichMarkdownSource(
  'A\n\nB * **C** D\n',
  'A\n\nB \\* **C** D\n',
  'A\n\n<br />\n'
)
assert.equal(
  /<br\s*\/?>/.test(divergedBrBail.markdown || ''),
  false,
  'a standalone <br /> placeholder must not leak through the diverged-block fallback'
)

// Insertion direction through the same diverged block.
const divergedInsert = preserveRichMarkdownSource(
  divergedDeleteSource,
  divergedDeletePrevious,
  '# 测试\n\n前段。\n\n* **输入设备：** 新内容\n\n第二段保留。\n'
)
assert.equal(divergedInsert.preserved, true)
assert.equal(
  divergedInsert.markdown,
  '# 测试\n\n前段。* **输入设备：** 新内容\n\n第二段保留。\n',
  'a diverged-stream insertion must reach the source block'
)

// A normal standalone paragraph can be unique as a Markdown block even when
// its short text occurs many times inside headings, lists, and blockquotes.
// The real user document below permanently diverges because `- - text` is
// parsed as a nested list and ```text``` is serialized as inline code. Editing
// the standalone `测试` paragraph must still save instead of being
// rejected merely because other blocks contain the word “测试”.
const divergedOrdinarySource = [
  '# 测试',
  '',
  '## 你好',
  '',
  '- 你好 1. 2. 测试',
  '- - 测试 1. 你好',
  '- 测试 - 测试 1. 2. 测试',
  '',
  '```你好```',
  '',
  '> 你是谁',
  '>',
  '> 1',
  '>',
  '>',
  '',
  '测试',
  '',
  '> 测试',
  '>',
  '> 测试',
  ''
].join('\n')
const divergedOrdinaryCanonical = [
  '# 测试',
  '',
  '## 你好',
  '',
  '* 你好 1. 2. 测试',
  '',
  '* <br />',
  '',
  '  * 测试 1. 你好',
  '',
  '* 测试 - 测试 1. 2. 测试',
  '',
  '`你好`',
  '',
  '> 你是谁',
  '>',
  '> 1',
  '',
  '测试',
  '',
  '> 测试',
  '>',
  '> 测试',
  ''
].join('\n')
const divergedOrdinaryEdit = preserveRichMarkdownSource(
  divergedOrdinarySource,
  divergedOrdinaryCanonical,
  divergedOrdinaryCanonical.replace('\n测试\n\n> 测试', '\n测试普通编辑X\n\n> 测试')
)
assert.equal(
  divergedOrdinaryEdit.preserved,
  true,
  'a uniquely identified standalone block edit must not be paused by unrelated canonical divergence'
)
assert.equal(
  divergedOrdinaryEdit.markdown,
  divergedOrdinarySource.replace('\n测试\n\n> 测试', '\n测试普通编辑X\n\n> 测试'),
  'the ordinary paragraph edit must reach source without normalizing any unrelated block'
)

const repeatedDivergedParagraphSource = [
  '# A',
  '',
  '相同。* **输入设备：** 内容',
  '',
  '相同。* **输入设备：** 内容',
  '',
  '相同。* **输入设备：** 内容',
  '',
  '相同。* **输入设备：** 内容',
  ''
].join('\n')
const repeatedDivergedParagraphCanonical = repeatedDivergedParagraphSource.replaceAll('。* ', '。\\* ')
const repeatedDivergedRows = repeatedDivergedParagraphCanonical.split('\n')
repeatedDivergedRows[6] = '相同。\\* **内容**'
const repeatedDivergedParagraphEdit = preserveRichMarkdownSource(
  repeatedDivergedParagraphSource,
  repeatedDivergedParagraphCanonical,
  repeatedDivergedRows.join('\n')
)
assert.equal(
  repeatedDivergedParagraphEdit.preserved,
  true,
  'equal-count repeated standalone blocks must map by their canonical/source ordinal'
)
const repeatedExpectedRows = repeatedDivergedParagraphSource.split('\n')
repeatedExpectedRows[6] = '相同。* **内容**'
assert.equal(
  repeatedDivergedParagraphEdit.markdown,
  repeatedExpectedRows.join('\n'),
  'only the edited repeated block occurrence may change'
)

// Repeated block text is ambiguous: the fallback must fail closed and keep
// the authored source untouched instead of guessing which occurrence to edit.
const divergedRepeatedSource =
  '# A\n\n* **输入设备：** 内容\n\n前段。* **输入设备：** 内容\n'
const divergedRepeatedPrevious =
  '# A\n\n* **输入设备：** 内容\n\n前段。\n\n* **输入设备：** 内容\n'
const divergedRepeatedNext =
  '# A\n\n* **输入设备：** 内容\n\n前段。\n\n* **内容**\n'
const divergedRepeated = preserveRichMarkdownSource(
  divergedRepeatedSource,
  divergedRepeatedPrevious,
  divergedRepeatedNext
)
assert.equal(divergedRepeated.preserved, false)
assert.equal(divergedRepeated.reason, 'visible-stream-mismatch')
assert.equal(
  divergedRepeated.markdown,
  divergedRepeatedSource,
  'a repeated block must not be replaced through the unique-block fallback'
)

// A change spanning multiple canonical blocks (deleting a paragraph plus the
// following list item) must not use the block fallback; it keeps the existing
// fail-closed behavior.
const divergedMultiBlock = preserveRichMarkdownSource(
  divergedDeleteSource,
  divergedDeletePrevious,
  '# 测试\n\n第二段保留。\n'
)
assert.equal(
  divergedMultiBlock.preserved,
  false,
  'a multi-block diverged change must stay fail-closed'
)
assert.equal(
  divergedMultiBlock.markdown,
  divergedDeleteSource,
  'a multi-block diverged change must not corrupt the authored source'
)

const crlfSource = '\uFEFF# Windows 标题\r\n\r\n正文 0~9。\r\n\r\n- 紧凑一\r\n- 紧凑二\r\n'
const crlfCanonical = '# Windows 标题\n\n正文 0\\~9。\n\n* 紧凑一\n\n* 紧凑二\n'
const crlfTextEdited = preserveRichMarkdownSource(
  crlfSource,
  crlfCanonical,
  crlfCanonical.replace('正文', '正文X')
)
assert.equal(crlfTextEdited.preserved, true)
assert.equal(
  crlfTextEdited.markdown,
  crlfSource.replace('正文', '正文X'),
  'ordinary rich edits must retain UTF-8 BOM, CRLF, list compactness, and untouched escapes'
)

const crlfHeadingChanged = preserveRichMarkdownSource(
  crlfSource,
  crlfCanonical,
  crlfCanonical.replace('# Windows 标题', '## Windows 标题')
)
assert.equal(crlfHeadingChanged.preserved, true)
assert.equal(
  crlfHeadingChanged.markdown,
  crlfSource.replace('# Windows 标题', '## Windows 标题'),
  'a structural first-line edit must retain BOM and CRLF'
)

const crlfParagraphSplit = preserveRichMarkdownSource(
  crlfSource,
  crlfCanonical,
  crlfCanonical.replace('正文 0\\~9。', '正文\n\n0\\~9。')
)
assert.equal(crlfParagraphSplit.preserved, true)
assert.equal(
  crlfParagraphSplit.markdown,
  crlfSource.replace('正文 0~9。', '正文\r\n\r\n0~9。'),
  'new rich-text block separators must follow the source CRLF convention'
)

const unrelatedFormattingSource = [
  '| A | B |',
  '| --- | --- |',
  '| one | two |',
  '',
  '- tight one',
  '- tight two',
  '',
  'Hard break first\\',
  'target after break',
  '',
  '```js',
  'const after = true',
  '```'
].join('\n')
const unrelatedFormattingCanonical = [
  '| A   | B   |',
  '| --- | --- |',
  '| one | two |',
  '',
  '* tight one',
  '',
  '* tight two',
  '',
  'Hard break first\\',
  'target after break',
  '',
  '```js',
  'const after = true',
  '```'
].join('\n')
const paragraphInsertedAfterHardBreak = preserveRichMarkdownSource(
  unrelatedFormattingSource,
  unrelatedFormattingCanonical,
  unrelatedFormattingCanonical.replace(
    'target after break\n\n```js',
    'target after break\n\nXYZ\n\n```js'
  )
)
assert.equal(paragraphInsertedAfterHardBreak.preserved, true)
assert.equal(paragraphInsertedAfterHardBreak.reason, 'middle-block-before-authored-fence')
assert.equal(
  paragraphInsertedAfterHardBreak.markdown,
  unrelatedFormattingSource.replace(
    'target after break\n\n```js',
    'target after break\n\nXYZ\n\n```js'
  ),
  'unrelated table/list formatting must not merge a newly inserted paragraph into a hard-break line'
)

const listTextEdited = preserveRichMarkdownSource(
  source,
  canonical,
  canonical.replace('第一项末尾', '第一项末尾（已修改）')
)
assert.equal(listTextEdited.preserved, true)
assert.equal(listTextEdited.reason, 'batched-list-row-changes')
assert.equal(
  listTextEdited.markdown,
  source.replace('第一项末尾', '第一项末尾（已修改）'),
  'editing list text must not change authored markers or insert loose-list blank lines'
)

const frontmatterSource = [
  '---',
  'name: deploy',
  'description: untouched source spelling',
  '---',
  '',
  '# Keep this heading',
  '',
  'Here is 0~9, which must not be escaped.'
].join('\n')
const frontmatterNext = [
  '---',
  'name: publish',
  'description: changed in rich mode',
  '---',
  '',
  '# Keep this heading',
  '',
  'Here is 0\\~9, which must not be escaped.'
].join('\n')
assert.equal(
  replaceMarkdownFrontmatterBlock({
    source: frontmatterSource,
    next: frontmatterNext,
    sourceOffset: 8,
    nextOffset: 8
  }),
  frontmatterSource.replace(
    'name: deploy\ndescription: untouched source spelling',
    'name: publish\ndescription: changed in rich mode'
  )
)

const tableSource = [
  '# 保持标题格式',
  '',
  '这里是区间：0~9。',
  '',
  'A | B',
  '--- | ---',
  'old-a | old-b',
  '',
  '这段不要改。'
].join('\n')
const tableCanonical = tableSource
  .replace('0~9', '0\\~9')
  .replace('A | B\n--- | ---\nold-a | old-b', [
    '| A     | B     |',
    '| ----- | ----- |',
    '| old-a | old-b |'
  ].join('\n'))
const tableNext = tableCanonical.replace('| old-a | old-b |', '| old-a | old-b |\n| new-a | new-b |')
const tableChanged = preserveRichMarkdownSource(tableSource, tableCanonical, tableNext)
assert.equal(tableChanged.preserved, true)
assert.equal(tableChanged.reason, 'table-block-change')
assert.equal(tableChanged.markdown, [
  '# 保持标题格式',
  '',
  '这里是区间：0~9。',
  '',
  '| A     | B     |',
  '| ----- | ----- |',
  '| old-a | old-b |',
  '| new-a | new-b |',
  '',
  '这段不要改。'
].join('\n'))

const tableCellEdited = preserveRichMarkdownSource(
  tableSource,
  tableCanonical,
  tableCanonical.replace('old-a', 'edited-a')
)
assert.equal(tableCellEdited.preserved, true)
assert.equal(
  tableCellEdited.markdown,
  tableSource.replace('old-a', 'edited-a'),
  'editing table text must not normalize the table or unrelated prose'
)

const tableCanonicalRealigned = [
  '| A            |              B |',
  '| :----------- | -------------: |',
  '| TABLE\\_CELL | second<br>line |'
].join('\n')
const tableCanonicalRealignedNext = [
  '| A             |              B |',
  '| :------------ | -------------: |',
  '| TABLE\\_CELLX | second<br>line |'
].join('\n')
const tableRealignedTextEdit = preserveRichMarkdownSource(
  'A | B\n:--- | ---:\nTABLE_CELL | second<br>line',
  tableCanonicalRealigned,
  tableCanonicalRealignedNext
)
assert.equal(tableRealignedTextEdit.reason, 'table-text-change')
assert.equal(
  tableRealignedTextEdit.markdown,
  'A | B\n:--- | ---:\nTABLE_CELLX | second<br>line',
  'serializer column padding changes must not reformat an authored table during a cell text edit'
)

const listSource = [
  '# 保持标题格式',
  '',
  '这里是区间：0~9。',
  '',
  '- Alpha',
  '  - Child',
  '- Beta',
  '',
  '两个列表之间的正文。',
  '',
  '- [ ] 不要转换的任务',
  '',
  '这段不要改。'
].join('\n')
const listCanonical = [
  '# 保持标题格式',
  '',
  '这里是区间：0\\~9。',
  '',
  '* Alpha',
  '  * Child',
  '',
  '* Beta',
  '',
  '两个列表之间的正文。',
  '',
  '* [ ] 不要转换的任务',
  '',
  '这段不要改。'
].join('\n')
const listNext = [
  '# 保持标题格式',
  '',
  '这里是区间：0\\~9。',
  '',
  '1. Alpha',
  '   1. Child',
  '2. Beta',
  '',
  '两个列表之间的正文。',
  '',
  '* [ ] 不要转换的任务',
  '',
  '这段不要改。'
].join('\n')

const listItemInserted = preserveRichMarkdownSource(
  listSource,
  listCanonical,
  listCanonical.replace('* Beta', '* Inserted\n\n* Beta')
)
assert.equal(listItemInserted.preserved, true)
assert.equal(listItemInserted.markdown, [
  '# 保持标题格式',
  '',
  '这里是区间：0~9。',
  '',
  '- Alpha',
  '  - Child',
  '- Inserted',
  '- Beta',
  '',
  '两个列表之间的正文。',
  '',
  '- [ ] 不要转换的任务',
  '',
  '这段不要改。'
].join('\n'), 'adding one item must keep the authored compact-list and bullet style')

// A delayed markdownUpdated can batch several independent edits before the
// preservation layer sees a new canonical snapshot. Distinct neighbouring
// `-`, `+` and `*` lists must still retain their own authored spelling rather
// than inheriting the serializer's marker from whichever list is first.
const mixedMarkerSource = [
  '- dash-one',
  '- dash-two',
  '',
  '+ plus-one',
  '+ plus-two',
  '',
  '* star-one',
  '* star-two',
  '',
  '1) paren-one',
  '2) paren-two'
].join('\n')
const mixedMarkerCanonical = [
  '* dash-one',
  '',
  '* dash-two',
  '',
  '- plus-one',
  '',
  '- plus-two',
  '',
  '* star-one',
  '',
  '* star-two',
  '',
  '1. paren-one',
  '2. paren-two'
].join('\n')
const mixedMarkerBatch = preserveRichMarkdownSource(
  mixedMarkerSource,
  mixedMarkerCanonical,
  [
    '* dash-one',
    '',
    '* dash-two',
    '',
    '* dash-three',
    '',
    '- plus-one',
    '',
    '- plus-two',
    '',
    '- plus-three',
    '',
    '* star-one',
    '',
    '<br />',
    '',
    '1. paren-one',
    '2. paren-two'
  ].join('\n')
)
assert.equal(mixedMarkerBatch.preserved, true)
assert.equal(mixedMarkerBatch.markdown, [
  '- dash-one',
  '- dash-two',
  '- dash-three',
  '',
  '+ plus-one',
  '+ plus-two',
  '+ plus-three',
  '',
  '* star-one',
  '',
  '1) paren-one',
  '2) paren-two'
].join('\n'), 'batched independent list edits must retain per-list markers and omit transient empty blocks')

const mixedMarkerFirstItemBatch = preserveRichMarkdownSource(
  mixedMarkerSource,
  mixedMarkerCanonical,
  mixedMarkerCanonical
    .replace('- plus-one', '- plus-one-X')
    .replace('* star-two', '* star-two-X')
)
assert.equal(
  mixedMarkerFirstItemBatch.markdown,
  mixedMarkerSource
    .replace('+ plus-one', '+ plus-one-X')
    .replace('* star-two', '* star-two-X'),
  'changing a neighbouring list first item must not absorb, duplicate, or rewrite later list blocks'
)

const equalCountCrossListMove = preserveRichMarkdownSource(
  '- dash-one\n- dash-two\n\n+ plus-one\n+ plus-two',
  '* dash-one\n\n* dash-two\n\n- plus-one\n\n- plus-two',
  '* dash-one\n\n* dash-two\n\n* dash-three\n\n- plus-one'
)
assert.equal(
  equalCountCrossListMove.markdown,
  '- dash-one\n- dash-two\n- dash-three\n\n+ plus-one',
  'equal total row counts must not make an insertion in one list inherit a deleted row identity from another list'
)

const equalCountDeleteNextFirst = preserveRichMarkdownSource(
  '- dash-one\n- dash-two\n\n+ plus-one\n+ plus-two',
  '* dash-one\n\n* dash-two\n\n- plus-one\n\n- plus-two',
  '* dash-one\n\n* dash-two\n\n* dash-three\n\n- plus-two'
)
assert.equal(
  equalCountDeleteNextFirst.markdown,
  '- dash-one\n- dash-two\n- dash-three\n\n+ plus-two',
  'deleting the next list first item must use a surviving fence instead of falling into generic offset mapping'
)

const equalCountDeleteNextFirstCrlf = preserveRichMarkdownSource(
  '- dash-one\r\n- dash-two\r\n\r\n+ plus-one\r\n+ plus-two',
  '* dash-one\n\n* dash-two\n\n- plus-one\n\n- plus-two',
  '* dash-one\n\n* dash-two\n\n* dash-three\n\n- plus-two'
)
assert.equal(
  equalCountDeleteNextFirstCrlf.markdown,
  '- dash-one\r\n- dash-two\r\n- dash-three\r\n\r\n+ plus-two',
  'the surviving-fence batch path must retain CRLF as well as per-list markers'
)

const unownedMultiListBatch = preserveRichMarkdownSource(
  '- dash-one\n- dash-two\n\n+ plus-one\n+ plus-two',
  '* dash-one\n\n* dash-two\n\n- plus-one\n\n- plus-two',
  '* dash-one\n\n* dash-two\n\n* dash-three'
)
assert.equal(unownedMultiListBatch.preserved, false)
assert.equal(unownedMultiListBatch.reason, 'unmapped-batched-list-change')
assert.equal(
  unownedMultiListBatch.markdown,
  '- dash-one\n- dash-two\n\n+ plus-one\n+ plus-two',
  'an unowned multi-list batch must fail closed before any generic mapper can corrupt list boundaries'
)

const typedListItemAppended = preserveRichMarkdownSource(
  '- 第一项\n\n',
  '* 第一项\n\n',
  '* 第一项\n\n* 第二项\n\n'
)
assert.equal(
  typedListItemAppended.markdown,
  '- 第一项\n- 第二项\n\n',
  'a newly typed compact list must keep its authored marker when Enter adds another item'
)

// A pre-existing diverged list can precede a newly-created ordered list. The
// diverged nested-list mapper must preserve the target list's actual authored
// kind: only a source row written as `- 1. text` may receive `- 2. text`.
const divergedOrderedContinuation = preserveRichMarkdownSource(
  [
    '- 1. source nested',
    '- source sibling',
    '',
    '###### target',
    '',
    '1. first',
    '',
    'after'
  ].join('\n'),
  [
    '* <br />',
    '',
    '  1. source nested',
    '',
    '* source sibling',
    '',
    '###### target',
    '',
    '1. first',
    '',
    'after'
  ].join('\n'),
  [
    '* <br />',
    '',
    '  1. source nested',
    '',
    '* source sibling',
    '',
    '###### target',
    '',
    '1. first',
    '2. <br />',
    '',
    'after'
  ].join('\n')
)
assert.equal(divergedOrderedContinuation.preserved, true)
assert.equal(
  divergedOrderedContinuation.markdown,
  [
    '- 1. source nested',
    '- source sibling',
    '',
    '###### target',
    '',
    '1. first',
    '2. ',
    '',
    '',
    'after'
  ].join('\n'),
  'a newly-created ordered item must not inherit the diverged mapper’s bullet wrapper'
)

assert.equal(
  preserveRichMarkdownSource(
    '已有正文追加正文\n\n- \n',
    '已有正文追加正文\n\n* <br />\n\n',
    '已有正文追加正文\n\n* 新列表项\n\n'
  ).markdown,
  '已有正文追加正文\n\n- 新列表项\n\n',
  'filling a newly-created final list item must retain its following empty paragraph newline'
)

const listItemAppendedBeforeParagraph = preserveRichMarkdownSource(
  '- first\n- second\n\nparagraph',
  '* first\n\n* second\n\nparagraph',
  '* first\n\n* second\n\n* new\n\nparagraph'
)
assert.equal(
  listItemAppendedBeforeParagraph.markdown,
  '- first\n- second\n- new\n\nparagraph',
  'an item appended at a following paragraph boundary must inherit the compact list marker'
)

assert.equal(
  preserveTypedBulletInputRule({
    source: '1. first\n2. second\n\n',
    insertionSource: '1. first\n2. second\n\n* typed dash\n\nfollowing\n',
    previousCanonical: '1. first\n2. second\n\n<br />\n\n',
    canonical: '1. first\n2. second\n\n* typed dash\n\nfollowing\n',
    sourceOffset: 0,
    sourceSlotRawStart: '1. first\n2. second\n\n'.length,
    canonicalOffset: '1. first\n2. second\n\n'.length,
    marker: '-'
  }),
  '1. first\n2. second\n\n- typed dash\n\nfollowing\n',
  'a tail input-rule slot must restore the physical dash even when duplicate text makes its visible offset unusable'
)

assert.equal(
  preserveTypedBulletInputRule({
    source: '1. first\r\n2. second\r\n\r\n',
    insertionSource: '1. first\r\n2. second\r\n\r\n* typed dash\r\n\r\nfollowing\r\n',
    previousCanonical: '1. first\n2. second\n\n<br />\n\n',
    canonical: '1. first\n2. second\n\n* typed dash\n\nfollowing\n',
    sourceOffset: 0,
    sourceSlotRawStart: '1. first\r\n2. second\r\n\r\n'.length,
    canonicalOffset: '1. first\n2. second\n\n'.length,
    marker: '-'
  }),
  '1. first\r\n2. second\r\n\r\n- typed dash\r\n\r\nfollowing\r\n',
  'a CRLF tail input-rule replacement must keep an exact two-EOL block boundary without splitting CRLF bytes'
)

assert.equal(
  restoreTypedBulletMarker({
    markdown: '* 第一项\n* 第二项\n\n',
    previousCanonical: '\\-\n',
    canonical: '* 第一项\n\n* 第二项\n\n',
    canonicalOffset: 4,
    marker: '-'
  }),
  '- 第一项\n- 第二项\n\n',
  'the typed bullet marker must apply to the complete newly-created list level'
)

assert.equal(
  restoreTypedBulletMarker({
    markdown: 'intro\n\n* nested-one\n* nested-two\n',
    previousCanonical: 'intro\n',
    canonical: 'intro\n\n* nested-one\n* nested-two\n',
    // Simulates the old paragraph position after an input rule moved it into
    // a nested list: it is no longer close to the serialized marker row.
    canonicalOffset: 999,
    marker: '-'
  }),
  'intro\n\n- nested-one\n- nested-two\n',
  'a stale pre-input position must fall back to the actual changed list row instead of losing the authored bullet marker'
)

assert.equal(
  restoreTypedBulletMarker({
    markdown: '1. 第一项\n2. 第二项\n1) 重新创建项\n',
    previousCanonical: '1. 第一项\n2. 第二项\n',
    canonical: '1. 第一项\n2. 第二项\n1) 重新创建项\n',
    canonicalOffset: '1. 第一项\n2. 第二项\n'.length,
    marker: '1.'
  }),
  '1. 第一项\n2. 第二项\n1. 重新创建项\n',
  'a recreated ordered list must retain its typed dot without rewriting existing numbering'
)

assert.equal(
  preserveGeneratedBulletMarkers(
    '1. 外层\n   1. 子项\n',
    '1) 外层\n   1) 子项\n'
  ),
  '1. 外层\n   1. 子项\n',
  'a second generated serialization must retain ordered punctuation after the input intent is consumed'
)

assert.equal(
  preserveGeneratedBulletMarkers(
    '- dash one\n',
    '* dash one\n* dash two\n'
  ),
  '- dash one\n- dash two\n',
  'a newly appended scratch-list row must inherit the authored dash instead of reverting to Crepe’s star'
)

assert.equal(
  preserveGeneratedBulletMarkers(
    '1. ordered\n\n- dash one\n- dash two\n',
    '1. ordered\n\n* dash one edited\n* dash two\n'
  ),
  '1. ordered\n\n- dash one edited\n- dash two\n',
  'editing the first item of a generated dash list must not expose Crepe’s default star'
)

assert.equal(
  preserveGeneratedBulletMarkers(
    '- first\n- second\n',
    '* first edited\n* second edited\n'
  ),
  '- first edited\n- second edited\n',
  'editing every item while the generated list shape is stable must retain its authored marker by structural row identity'
)

assert.equal(
  preserveGeneratedBulletMarkers(
    '- dash one\n- dash two\n\n+ plus one\n',
    '* dash one\n* dash two\n* plus one\n* plus two\n'
  ),
  '- dash one\n- dash two\n+ plus one\n+ plus two\n',
  'a newly appended row in a later scratch list must inherit that list’s own marker, even if Crepe merges adjacent bullet nodes'
)

assert.equal(
  preserveGeneratedBulletMarkers(
    '- outer one\n- outer two\n',
    '* outer one\n* outer two\n  * child one\n  * child two\n'
  ),
  '- outer one\n- outer two\n  - child one\n  - child two\n',
  'a Tab-created child list must inherit its parent marker instead of serializing as Crepe’s default star'
)


const adjacentListKinds = preserveRichMarkdownSource(
  '* Existing bullet\n\nConvert this paragraph\n\n* [ ] Existing task\n',
  '* Existing bullet\n\nConvert this paragraph\n\n* [ ] Existing task\n',
  '* Existing bullet\n\n1. Convert this paragraph\n\n* [ ] Existing task\n'
)
assert.equal(
  adjacentListKinds.markdown,
  '* Existing bullet\n\n1. Convert this paragraph\n\n* [ ] Existing task\n',
  'a top-level list type change must not merge adjacent bullet, ordered, and task lists'
)

const paragraphBetweenBulletLists = preserveRichMarkdownSource(
  '* Existing bullet\n\nConvert this paragraph\n\n* [ ] Existing task\n',
  '* Existing bullet\n\nConvert this paragraph\n\n* [ ] Existing task\n',
  '* Existing bullet\n\n* Convert this paragraph\n\n* [ ] Existing task\n'
)
assert.equal(
  paragraphBetweenBulletLists.markdown,
  '* Existing bullet\n\n* Convert this paragraph\n\n* [ ] Existing task\n',
  'wrapping a paragraph must replace only that line even when adjacent bullet lists become contiguous'
)

assert.equal(
  replaceMarkdownListBlock({
    source: '- Parent\n  - Child A\n  - Child B\n- Sibling\n',
    previous: '* Parent\n\n  * Child A\n\n  * Child B\n* Sibling\n',
    next: '1. Parent\n\n   * Child A\n\n   * Child B\n2. Sibling\n',
    sourceOffset: 2,
    previousOffset: 2,
    nextOffset: 3
  }),
  '1. Parent\n   - Child A\n   - Child B\n2. Sibling\n',
  'bullet-to-ordered conversion must raise descendant markers to the new parse-safe content indent'
)

assert.equal(
  replaceMarkdownListBlock({
    source: '- Parent\n\t- Child\n- Sibling\n',
    previous: '* Parent\n\n  * Child\n* Sibling\n',
    next: '1. Parent\n\n   * Child\n2. Sibling\n',
    sourceOffset: 2,
    previousOffset: 2,
    nextOffset: 3
  }),
  '1. Parent\n\t- Child\n2. Sibling\n',
  'an authored Tab indent that already satisfies ordered nesting must remain byte-exact'
)

assert.equal(
  replaceMarkdownListBlock({
    source: '- [ ] Task one\n- [x] Task two\n\n1. First\n   1. First child\n2. Second\n',
    previous: '* [ ] Task one\n\n* [x] Task two\n\n1. First\n\n   1. First child\n2. Second\n',
    next: '* [ ] Task one\n\n* [x] Task two\n\n* First\n\n  1. First child\n* Second\n',
    sourceOffset: 31,
    previousOffset: 32,
    nextOffset: 32
  }),
  '- [ ] Task one\n- [x] Task two\n\n- First\n   1. First child\n- Second\n',
  'a list conversion must not duplicate an adjacent list that canonical Markdown merges into the same block'
)

const mixedLooseOuterCompactInnerSource = [
  '1. 用来做推特运营',
  '',
  '   * 发每日更新',
  '   * 搜索值得收藏的内容',
  '2. 自动写公众号',
  '',
  '   * 找选题、写文章',
  '3. 开发 HorseMD',
  '',
  '   * 监控 issue',
  '   * 实现新功能'
].join('\n')
const mixedLooseOuterCompactInnerPrevious = [
  '1. 用来做推特运营',
  '',
  '   * 发每日更新',
  '',
  '   * 搜索值得收藏的内容',
  '2. 自动写公众号',
  '',
  '   * 找选题、写文章',
  '3. 开发 HorseMD',
  '',
  '   * 监控 issue',
  '',
  '   * 实现新功能'
].join('\n')
const mixedLooseOuterCompactInnerNext = mixedLooseOuterCompactInnerPrevious
  .replace(/^\d+\. /gm, '* ')
assert.equal(
  replaceMarkdownListBlock({
    source: mixedLooseOuterCompactInnerSource,
    previous: mixedLooseOuterCompactInnerPrevious,
    next: mixedLooseOuterCompactInnerNext,
    sourceOffset: 2,
    previousOffset: 2,
    nextOffset: 2
  }),
  mixedLooseOuterCompactInnerSource.replace(/^\d+\. /gm, '- '),
  'converting a loose outer list must change only its markers and preserve compact nested-list bytes'
)
assert.equal(
  replaceMarkdownListBlock({
    source: mixedLooseOuterCompactInnerSource,
    previous: mixedLooseOuterCompactInnerPrevious,
    next: mixedLooseOuterCompactInnerNext.replace('用来做推特运营', '用来立即继续输入'),
    sourceOffset: 2,
    previousOffset: 2,
    nextOffset: 2
  }),
  null,
  'an ambiguous combined conversion/text delta must fail closed instead of replacing the canonical list tree'
)

const leadingSpaceListSource = '- 是的v\n- 色粉色\n- \u200B     色粉色分\n'
const leadingSpaceListCanonical = '* 是的v\n* 色粉色\n* &#x20;    色粉色分\n'
assert.equal(
  replaceMarkdownListBlock({
    source: leadingSpaceListSource,
    previous: leadingSpaceListCanonical,
    next: '1. 是的v\n2. 色粉色\n3. &#x20;    色粉色分\n',
    sourceOffset: 2,
    previousOffset: 2,
    nextOffset: 3
  }),
  '1. 是的v\n2. 色粉色\n3. \u200B     色粉色分\n',
  'list conversion must treat U+200B authored leading spaces and canonical &#x20; as the same item text'
)

const listChanged = preserveRichMarkdownSource(listSource, listCanonical, listNext)
assert.equal(listChanged.preserved, true)
assert.equal(listChanged.reason, 'list-type-change')
assert.equal(listChanged.markdown, [
  '# 保持标题格式',
  '',
  '这里是区间：0~9。',
  '',
  '1. Alpha',
  '   1. Child',
  '2. Beta',
  '',
  '两个列表之间的正文。',
  '',
  '- [ ] 不要转换的任务',
  '',
  '这段不要改。'
].join('\n'))

const headingLevelChanged = preserveRichMarkdownSource(
  source,
  canonical,
  canonical.replace('## 二级标题', '### 二级标题')
)
assert.equal(headingLevelChanged.preserved, true)
assert.equal(
  headingLevelChanged.markdown,
  source.replace('## 二级标题', '### 二级标题'),
  'changing one heading level must not add blank lines elsewhere'
)

const splitParagraph = preserveRichMarkdownSource(
  source,
  canonical,
  canonical.replace('这一段不要修改。', '这一段\n\n不要修改。')
)
assert.equal(splitParagraph.preserved, true)
assert.equal(
  splitParagraph.markdown,
  source.replace('这一段不要修改。', '这一段\n\n不要修改。'),
  'splitting one paragraph must not normalize headings or lists'
)

const appendedParagraphWithoutFinalNewline = preserveRichMarkdownSource(
  '第一段内容',
  '第一段内容\n',
  '第一段内容\n\n第二段内容\n'
)
assert.equal(appendedParagraphWithoutFinalNewline.preserved, true)
assert.equal(
  ['appended-paragraph', 'diverged-tail-block-append'].includes(appendedParagraphWithoutFinalNewline.reason),
  true,
  `paragraph append must be owned by an append mapper, got ${appendedParagraphWithoutFinalNewline.reason}`
)
assert.equal(
  appendedParagraphWithoutFinalNewline.markdown,
  '第一段内容\n\n第二段内容',
  'adding a paragraph must keep two Markdown separator newlines without inventing a final newline'
)

const appendedLiteralOrderedMarker = preserveRichMarkdownSource(
  '# 你好\n\n1. 测试\n2. 哪里呢',
  '# 你好\n\n1. 测试\n2. 哪里呢\n\n',
  '# 你好\n\n1. 测试\n2. 哪里呢\n\n3\\.\n'
)
assert.equal(appendedLiteralOrderedMarker.preserved, true)
assert.equal(
  appendedLiteralOrderedMarker.markdown,
  '# 你好\n\n1. 测试\n2. 哪里呢\n\n3\\.',
  'a whole newly appended literal ordered marker must keep its protective escape until Space actually triggers the list input rule'
)

const appendedParagraphWithFinalNewline = preserveRichMarkdownSource(
  '第一段内容\n',
  '第一段内容\n',
  '第一段内容\n\n第二段内容\n'
)
assert.equal(
  appendedParagraphWithFinalNewline.markdown,
  '第一段内容\n\n第二段内容\n',
  'adding a paragraph must retain the authored final-newline style'
)

const appendedParagraphAfterAuthoredBlankLines = preserveRichMarkdownSource(
  '第一段内容\n\n\n',
  '第一段内容\n',
  '第一段内容\n\n第二段内容\n'
)
assert.equal(
  appendedParagraphAfterAuthoredBlankLines.markdown,
  '第一段内容\n\n\n第二段内容\n',
  'adding a paragraph must reuse authored trailing blank lines instead of adding another'
)

const paragraphAfterSettledNewDocumentTitle = preserveRichMarkdownSource(
  '# 看了苏规范\n\n',
  '# 看了苏规范\n\n',
  '# 看了苏规范\n\n阿福两年啦额咖啡呢\n\n'
)
assert.equal(
  ['appended-paragraph', 'diverged-tail-block-append'].includes(paragraphAfterSettledNewDocumentTitle.reason),
  true,
  `title-following paragraph append must be owned by an append mapper, got ${paragraphAfterSettledNewDocumentTitle.reason}`
)
assert.equal(
  paragraphAfterSettledNewDocumentTitle.markdown,
  '# 看了苏规范\n\n阿福两年啦额咖啡呢\n',
  'typing into the trailing paragraph after a settled title must not append text to the heading'
)

const secondParagraphAfterSettledTitle = preserveRichMarkdownSource(
  paragraphAfterSettledNewDocumentTitle.markdown,
  '# 看了苏规范\n\n阿福两年啦额咖啡呢\n\n',
  '# 看了苏规范\n\n阿福两年啦额咖啡呢\n\n阿发了；发挥了；\n\n'
)
assert.equal(
  secondParagraphAfterSettledTitle.markdown,
  '# 看了苏规范\n\n阿福两年啦额咖啡呢\n\n阿发了；发挥了；\n',
  'human-paced consecutive paragraphs must remain separate after canonical snapshots settle'
)

const trailingEmptyParagraphCreated = preserveRichMarkdownSource(
  '# 看了苏规范\n\n',
  '# 看了苏规范\n\n',
  '# 看了苏规范\n\n<br />\n\n'
)
assert.equal(
  ['trailing-empty-block-created', 'diverged-tail-block-append', 'canonical-trailing-newline-drift']
    .includes(trailingEmptyParagraphCreated.reason),
  true,
  `trailing empty paragraph must be owned by an empty/append mapper, got ${trailingEmptyParagraphCreated.reason}`
)
assert.equal(
  trailingEmptyParagraphCreated.markdown,
  '# 看了苏规范\n\n',
  "pressing Enter must not persist Crepe's standalone empty-paragraph <br /> placeholder"
)

assert.equal(
  preserveRichMarkdownSource('', '', '第一段\n\n<br />\n\n第二段\n').markdown,
  '第一段\n\n\n\n第二段\n',
  'a new document must not expose Crepe empty-paragraph placeholders as authored HTML'
)

const trailingEmptyParagraphFilled = preserveRichMarkdownSource(
  trailingEmptyParagraphCreated.markdown,
  '# 看了苏规范\n\n<br />\n\n',
  '# 看了苏规范\n\n阿福两年啦额咖啡呢\n\n'
)
assert.equal(
  ['trailing-empty-block-filled', 'diverged-tail-block-append'].includes(trailingEmptyParagraphFilled.reason),
  true,
  `trailing empty paragraph fill must be owned by an empty/append mapper, got ${trailingEmptyParagraphFilled.reason}`
)
assert.equal(
  trailingEmptyParagraphFilled.markdown,
  '# 看了苏规范\n\n阿福两年啦额咖啡呢\n',
  'typing after Enter must replace the transient empty block with a separate paragraph'
)

// RS-57: Enter at the end of a non-empty trailing blockquote creates an empty
// second quote paragraph that plain Markdown cannot persist without `<br />`.
// Keep authored source unchanged and expose a dedicated reason for integrity.
const trailingEmptyBlockquoteParagraphCreated = preserveRichMarkdownSource(
  '> 千万千万人\n',
  '> 千万千万人\n\n',
  '> 千万千万人\n>\n> <br />\n\n'
)
assert.equal(
  trailingEmptyBlockquoteParagraphCreated.markdown,
  '> 千万千万人\n',
  'creating a trailing empty blockquote paragraph must not persist placeholder quote rows'
)
assert.equal(
  trailingEmptyBlockquoteParagraphCreated.reason,
  'trailing-empty-blockquote-paragraph-created',
  'trailing empty quote paragraph must use its dedicated transient reason'
)

// RS-65 / 0.13.110 PID 29289 trace line 664: the same editor-owned
// empty second quote paragraph can be created in the MIDDLE of a document.
// The following block is a stable fence and must remain byte-for-byte unchanged;
// persisting bare `>` rows cannot reproduce the two-paragraph quote on reparse.
const middleEmptyBlockquoteParagraphCreated = preserveRichMarkdownSource(
  '> lknlkjn.kln\n\n2. 斛律v哦\n',
  '> lknlkjn.kln\n\n2. 斛律v哦\n',
  '> lknlkjn.kln\n>\n> <br />\n\n2. 斛律v哦\n'
)
assert.equal(
  middleEmptyBlockquoteParagraphCreated.markdown,
  '> lknlkjn.kln\n\n2. 斛律v哦\n',
  'creating a middle quote empty paragraph must keep authored bytes unchanged until it receives text'
)
assert.equal(
  middleEmptyBlockquoteParagraphCreated.reason,
  'trailing-empty-blockquote-paragraph-created',
  'middle quote empty paragraph must reuse the strict RS-57 transient contract'
)

const divergedMiddleEmptyBlockquoteParagraphCreated = preserveRichMarkdownSource(
  '- authored marker\n\n> earlier quote\n\n> lknlkjn.kln\n\n2. 斛律v哦\n',
  '* authored marker\n\n> earlier quote\n\n> lknlkjn.kln\n\n2. 斛律v哦\n\n',
  '* authored marker\n\n> earlier quote\n\n> lknlkjn.kln\n>\n> <br />\n\n2. 斛律v哦\n\n'
)
assert.equal(
  divergedMiddleEmptyBlockquoteParagraphCreated.markdown,
  '- authored marker\n\n> earlier quote\n\n> lknlkjn.kln\n\n2. 斛律v哦\n',
  'RS-65 must preserve authored source spelling while locating the changed quote by visible quote ordinal'
)
assert.equal(
  divergedMiddleEmptyBlockquoteParagraphCreated.reason,
  'trailing-empty-blockquote-paragraph-created',
  'RS-65 diverged document must still use the strict quote transient proof'
)

// RS-58: deleting the final escaped literal from a continuation paragraph
// inside a checked task leaves one editor-owned empty paragraph in that item.
// The existing line mapper already proves the raw deletion; reclassify only
// this list-owned terminal continuation so integrity can accept the transient.
const trailingTaskParagraphEmptied = preserveRichMarkdownSource(
  '# 反馈\n\n* [x]  前端\n\n  [\n',
  '# 反馈\n\n* [x] &#x20;前端\n\n  \\[\n\n',
  '# 反馈\n\n* [x] &#x20;前端\n\n  <br />\n\n'
)
assert.equal(
  trailingTaskParagraphEmptied.markdown,
  '# 反馈\n\n* [x]  前端\n',
  'empty trailing task continuation must remove only its authored text row'
)
assert.equal(
  trailingTaskParagraphEmptied.reason,
  'trailing-list-item-paragraph-emptied',
  'empty trailing task continuation must use the dedicated list transient reason'
)
const topLevelEscapedParagraphEmptied = preserveRichMarkdownSource(
  '[\n',
  '\\[\n\n',
  '<br />\n\n'
)
assert.notEqual(
  topLevelEscapedParagraphEmptied.reason,
  'trailing-list-item-paragraph-emptied',
  'top-level escaped punctuation deletion must not receive list-item transient ownership'
)

// RS-60 / PID 11970 trace line 2052: removing a second empty task row does
// not exit to a top-level paragraph. ProseMirror merges the row into the
// preceding task item as one editor-owned trailing empty paragraph. The source
// task body is U+200B, while canonical uses `[ ] <br />`; both are empty task
// syntax and the row itself must disappear without touching the following list.
const emptyTaskItemMergedToContinuation = preserveRichMarkdownSource(
  [
    '* [ ] 3日未日',
    '* [ ] \u200B',
    '1. 微风认为',
    '2. 2维维股份',
    ''
  ].join('\n'),
  [
    '* [ ] 3日未日',
    '* [ ] <br />',
    '',
    '1. 微风认为',
    '2. 2维维股份',
    ''
  ].join('\n'),
  [
    '* [ ] 3日未日',
    '',
    '  <br />',
    '',
    '1. 微风认为',
    '2. 2维维股份',
    ''
  ].join('\n')
)
assert.equal(emptyTaskItemMergedToContinuation.preserved, true)
assert.equal(
  emptyTaskItemMergedToContinuation.reason,
  'empty-task-item-merged-to-continuation',
  'empty task-row Backspace must use the dedicated in-item continuation transient instead of the post-list token'
)
assert.equal(
  emptyTaskItemMergedToContinuation.markdown,
  '* [ ] 3日未日\n1. 微风认为\n2. 2维维股份\n',
  'empty task-row Backspace must remove only that task row and preserve the following ordered list'
)

// RS-63 / 0.13.108 PID 23485 trace line 557: deleting a top-level empty
// bullet after a sibling whose final child is a nested bullet moves one
// editor-owned empty paragraph INSIDE that preceding item, after the nested
// list. This is not RS-51's simple text-paragraph transient, so keep a narrow
// raw-canonical proof and dedicated reason instead of weakening all nested-list
// semantic comparison.
const emptyBulletMergedAfterNestedList = preserveRichMarkdownSource(
  [
    '- sefsf ',
    '- wefsfesf',
    '  * wfewff ',
    '- ',
    ''
  ].join('\n'),
  [
    '* sefsf ',
    '* wefsfesf',
    '',
    '  * wfewff ',
    '* <br />',
    '',
  ].join('\n'),
  [
    '* sefsf ',
    '* wefsfesf',
    '',
    '  * wfewff ',
    '',
    '  <br />',
    '',
  ].join('\n')
)
assert.equal(emptyBulletMergedAfterNestedList.preserved, true)
assert.equal(
  emptyBulletMergedAfterNestedList.reason,
  'empty-list-item-merged-after-nested-list',
  'empty bullet after a nested sibling list must use the dedicated nested-structure continuation transient'
)
assert.equal(
  emptyBulletMergedAfterNestedList.markdown,
  '- sefsf \n- wefsfesf\n  * wfewff \n\n',
  'RS-63 must remove only the empty top-level bullet and retain the nested sibling list byte-for-byte'
)

// RS-64 / 0.13.109 PID 25642 trace line 140: after filling a bullet, Enter
// creates the next empty top-level bullet and Tab nests that empty row under the
// preceding item. Crepe canonical keeps a blank separator before the indented
// `<br />` marker. A compact-source formatter must NOT remove that separator:
// without it `  * ` reparses as paragraph text instead of a nested list item.
const emptyBulletIndentedUnderPreviousItem = preserveRichMarkdownSource(
  '- u高科技\n- 阿尔萨俄方\n- \n',
  '* u高科技\n\n* 阿尔萨俄方\n\n* <br />\n\n',
  '* u高科技\n\n* 阿尔萨俄方\n\n  * <br />\n\n'
)
assert.equal(emptyBulletIndentedUnderPreviousItem.preserved, true)
assert.equal(
  emptyBulletIndentedUnderPreviousItem.reason,
  'batched-list-block-changes',
  'RS-64 should stay on the existing list-block mapper instead of weakening semantic integrity'
)
assert.equal(
  emptyBulletIndentedUnderPreviousItem.markdown,
  '- u高科技\n- 阿尔萨俄方\n\n  * \n',
  'RS-64 must retain the parse-required separator before the newly nested empty bullet'
)

// RS-48: an empty blockquote is a syntax-owned slot, not an ordinary trailing
// paragraph. Filling Crepe's `> <br />` placeholder must keep the new text
// inside the authored `>` row instead of appending a top-level paragraph.
const trailingEmptyBlockquoteFilled = preserveRichMarkdownSource(
  '>\n',
  '> <br />\n\n',
  '> 了就能解开了半年\n\n'
)
assert.equal(
  trailingEmptyBlockquoteFilled.markdown,
  '> 了就能解开了半年\n',
  'filling an empty trailing blockquote must preserve quote ownership'
)
assert.equal(
  preserveRichMarkdownSource(
    '> >\n',
    '> > <br />\n\n',
    '> > 深层引用\n\n'
  ).markdown,
  '> > 深层引用\n',
  'filling a nested empty blockquote must preserve quote depth'
)

const middleSource = '# 标题\n\n前段内容\n\n## 后续标题\n\n后段内容\n'
const middleCanonical = middleSource
const middleEmptyParagraphCreated = preserveRichMarkdownSource(
  middleSource,
  middleCanonical,
  '# 标题\n\n前段内容\n\n<br />\n\n## 后续标题\n\n后段内容\n'
)
assert.equal(
  ['middle-empty-block-created', 'diverged-tail-block-append', 'structural-line-change']
    .includes(middleEmptyParagraphCreated.reason),
  true,
  `middle empty paragraph must be owned by an empty/append mapper, got ${middleEmptyParagraphCreated.reason}`
)
assert.equal(
  middleEmptyParagraphCreated.markdown,
  middleSource,
  'pressing Enter between existing blocks must not leak an editor <br /> placeholder'
)

const middleEmptyParagraphFilled = preserveRichMarkdownSource(
  middleEmptyParagraphCreated.markdown,
  '# 标题\n\n前段内容\n\n<br />\n\n## 后续标题\n\n后段内容\n',
  '# 标题\n\n前段内容\n\n新插入段落\n\n## 后续标题\n\n后段内容\n'
)
assert.equal(middleEmptyParagraphFilled.reason, 'middle-empty-block-filled')
assert.equal(
  middleEmptyParagraphFilled.markdown,
  '# 标题\n\n前段内容\n\n新插入段落\n\n## 后续标题\n\n后段内容\n',
  'filling an empty paragraph between blocks must not merge it into the preceding paragraph'
)

// A middle empty paragraph can be published as two serializer-only `<br />`
// rows. When the user types into the second slot, the common delta is an
// insertion between those rows rather than a text change inside a previous
// placeholder. The authored source has only its blank-line gap, so this must
// become a real Markdown paragraph before the following list.
const middleEmptyListGapSource = [
  '# 森林',
  '',
  '了科纳克里；你',
  '',
  '测试是否中间正常',
  '',
  '- 了很私人化',
  '- 是刚回来',
  '  - 输入功能',
  ''
].join('\n')
const middleEmptyListGapPrevious = [
  '# 森林',
  '',
  '了科纳克里；你',
  '',
  '测试是否中间正常',
  '',
  '<br />',
  '',
  '<br />',
  '',
  '* 了很私人化',
  '',
  '* 是刚回来',
  '',
  '  * 输入功能',
  ''
].join('\n')
const middleEmptyListGapNext = [
  '# 森林',
  '',
  '了科纳克里；你',
  '',
  '测试是否中间正常',
  '',
  '<br />',
  '',
  '测试是否中间正常',
  '',
  '<br />',
  '',
  '* 了很私人化',
  '',
  '* 是刚回来',
  '',
  '  * 输入功能',
  ''
].join('\n')
const middleEmptyListGapFilled = preserveRichMarkdownSource(
  middleEmptyListGapSource,
  middleEmptyListGapPrevious,
  middleEmptyListGapNext
)
assert.equal(middleEmptyListGapFilled.preserved, true)
assert.equal(middleEmptyListGapFilled.reason, 'middle-empty-block-inserted')
assert.equal(
  middleEmptyListGapFilled.markdown,
  [
    '# 森林',
    '',
    '了科纳克里；你',
    '',
    '测试是否中间正常',
    '',
    '测试是否中间正常',
    '',
    '- 了很私人化',
    '- 是刚回来',
    '  - 输入功能',
    ''
  ].join('\n'),
  'typing into a middle serializer gap must preserve all three paragraphs and the following list boundary'
)

const directMiddleParagraphInserted = preserveRichMarkdownSource(
  middleSource,
  middleCanonical,
  '# 标题\n\n前段内容\n\n立即输入段落\n\n## 后续标题\n\n后段内容\n'
)
assert.equal(directMiddleParagraphInserted.reason, 'middle-block-inserted')
assert.equal(
  directMiddleParagraphInserted.markdown,
  '# 标题\n\n前段内容\n\n立即输入段落\n\n## 后续标题\n\n后段内容\n',
  'typing immediately after Enter must preserve the inserted block boundary'
)

const inlineCodeExitedAtLineEnd = preserveRichMarkdownSource(
  'Type target`awdawdwa`\n',
  'Type target`awdawdwa`\n',
  'Type target`awdawdwa`outside\n'
)
assert.equal(
  inlineCodeExitedAtLineEnd.markdown,
  'Type target`awdawdwa`outside\n',
  'plain text typed after closing inline code must stay outside the backticks'
)

const trailingInlineCodeParagraphStarted = preserveRichMarkdownSource(
  '前一段\n\n\\`\n',
  '前一段\n\n\\`\n',
  '前一段\n\n`f`\n'
)
assert.equal(
  trailingInlineCodeParagraphStarted.markdown,
  '前一段\n\n`f`\n',
  'turning a lone backtick paragraph into inline code must keep its block separator'
)

const nonCanonicalTrailingInlineCodeParagraphStarted = preserveRichMarkdownSource(
  '紧凑第一行\n紧凑第二行\n\n中间段落\n\n\n\n连续段落 D\n\n\\`\n',
  '紧凑第一行\n紧凑第二行\n\n中间段落\n\n连续段落 D\n\n\\`\n',
  '紧凑第一行\n紧凑第二行\n\n中间段落\n\n连续段落 D\n\n`f`\n'
)
assert.equal(
  nonCanonicalTrailingInlineCodeParagraphStarted.markdown,
  '紧凑第一行\n紧凑第二行\n\n中间段落\n\n\n\n连续段落 D\n\n`f`\n',
  'a trailing inline-code paragraph must preserve earlier non-canonical blank lines'
)

const emphasisExitedBeforeHardBreak = preserveRichMarkdownSource(
  '__强调__  \n下一行\n',
  '**强调**\n下一行\n',
  '**强调**outside\n下一行\n'
)
assert.equal(
  emphasisExitedBeforeHardBreak.markdown,
  '__强调__outside  \n下一行\n',
  'line-end inline syntax must close before new text without moving authored hard-break spaces'
)

// Typing literal spaces at a line end and then continuing to type more text is
// NOT a hard break: the spaces are serializer-kept text and the caret sits
// after them. New text must land after those spaces, not before them (0.13.71
// trailing-space bug wrote `text了；你   ` instead of `text   了；你`).
const typedAfterTrailingSpaces = preserveRichMarkdownSource(
  '# 测试\n\n将皮机配件       \n\n- slgensklrg \n',
  '# 测试\n\n将皮机配件       \n\n* slgensklrg\n',
  '# 测试\n\n将皮机配件       了；你\n\n* slgensklrg\n'
)
assert.equal(
  typedAfterTrailingSpaces.markdown,
  '# 测试\n\n将皮机配件       了；你\n\n- slgensklrg \n',
  'text typed after literal line-end spaces must append after those spaces'
)

const linkExitedAtLineEnd = preserveRichMarkdownSource(
  '[HorseMD](https://horsemd.yangsir.net/)\n',
  '[HorseMD](https://horsemd.yangsir.net/)\n',
  '[HorseMD](https://horsemd.yangsir.net/)outside\n'
)
assert.equal(
  linkExitedAtLineEnd.markdown,
  '[HorseMD](https://horsemd.yangsir.net/)outside\n',
  'plain text typed after a line-end link must stay outside the link destination'
)

const middleSpacedParagraphFilled = preserveRichMarkdownSource(
  middleEmptyParagraphFilled.markdown,
  '# 标题\n\n前段内容\n\n新插入段落\n\n<br />\n\n<br />\n\n## 后续标题\n\n后段内容\n',
  '# 标题\n\n前段内容\n\n新插入段落\n\n<br />\n\n间隔后段落\n\n## 后续标题\n\n后段内容\n'
)
assert.equal(
  middleSpacedParagraphFilled.markdown,
  '# 标题\n\n前段内容\n\n新插入段落\n\n\n\n间隔后段落\n\n## 后续标题\n\n后段内容\n',
  'an intentional empty paragraph must become blank source lines without persisting <br />'
)

const emptiedMiddleParagraph = preserveRichMarkdownSource(
  '# 测试\n\n你好\n\n再见\n',
  '# 测试\n\n你好\n\n再见\n',
  '# 测试\n\n<br />\n\n再见\n'
)
assert.equal(
  emptiedMiddleParagraph.markdown,
  '# 测试\n\n\n\n再见\n',
  'emptying a middle paragraph must delete its authored text without persisting <br />'
)

const emptiedTrailingParagraph = preserveRichMarkdownSource(
  '# 测试\n\n你好\n',
  '# 测试\n\n你好\n',
  '# 测试\n\n<br />\n'
)
assert.equal(
  emptiedTrailingParagraph.markdown,
  '# 测试\n',
  'emptying the trailing paragraph must delete its authored text, keep the source trailing newline, and never persist <br />'
)

const emptiedFormattedParagraph = preserveRichMarkdownSource(
  '# 测试\n\n**你好**\n\n再见\n',
  '# 测试\n\n**你好**\n\n再见\n',
  '# 测试\n\n<br />\n\n再见\n'
)
assert.equal(
  emptiedFormattedParagraph.markdown,
  '# 测试\n\n\n\n再见\n',
  'emptying a formatted paragraph must remove its whole authored line (including inline syntax)'
)

const emptiedThenTyped = preserveRichMarkdownSource(
  '# 测试\n\n\n\n再见\n',
  '# 测试\n\n<br />\n\n再见\n',
  '# 测试\n\n.\n\n再见\n'
)
assert.equal(
  emptiedThenTyped.markdown,
  '# 测试\n\n.\n\n再见\n',
  'typing into an emptied paragraph must fill its blank line without persisting <br />'
)

const emptiedDotDance = preserveRichMarkdownSource(
  '# 测试\n\n.\n\n再见\n',
  '# 测试\n\n.\n\n再见\n',
  '# 测试\n\n<br />\n\n再见\n'
)
assert.equal(
  emptiedDotDance.markdown,
  '# 测试\n\n\n\n再见\n',
  'deleting the last character of a paragraph must return to the blank-line form without persisting <br />'
)

const emptiedWithUnrelatedEmptyParagraph = preserveRichMarkdownSource(
  '# A\n\n.\n\n# B\n\n正文\n\n# C\n',
  '# A\n\n.\n\n# B\n\n正文\n\n<br />\n\n# C\n',
  '# A\n\n<br />\n\n# B\n\n正文\n\n<br />\n\n# C\n'
)
assert.equal(
  emptiedWithUnrelatedEmptyParagraph.reason,
  'paragraph-emptied',
  'an emptied paragraph must still map when the document has another unrelated empty paragraph'
)
assert.equal(
  emptiedWithUnrelatedEmptyParagraph.markdown,
  '# A\n\n\n\n# B\n\n正文\n\n# C\n',
  'an unrelated empty paragraph elsewhere must not leak <br /> through the localized replacement'
)

const emptiedWithVisibleStreamMismatch = preserveRichMarkdownSource(
  '# 甲\n\n.\n\n# 乙\n\n存取。* **输入设备：** 内容\n',
  '# 甲\n\n.\n\n# 乙\n\n存取。\n\n* **输入设备：** 内容\n',
  '# 甲\n\n<br />\n\n# 乙\n\n存取。\n\n* **输入设备：** 内容\n'
)
assert.equal(
  emptiedWithVisibleStreamMismatch.reason,
  'paragraph-emptied',
  'an emptied paragraph must still map when a mid-line `* ` elsewhere makes remark split the visible stream differently'
)
assert.equal(
  emptiedWithVisibleStreamMismatch.markdown,
  '# 甲\n\n\n\n# 乙\n\n存取。* **输入设备：** 内容\n',
  'a whole-document visible-stream mismatch must not veto the localized empty-paragraph mapping or leak <br />'
)

// The hard boundary invariant: no matter which heuristic path produced the
// result, an internal standalone `<br />` placeholder can never survive into
// authored source. Inline `text<br>text` and table-cell breaks are not
// standalone lines and must stay untouched.
const boundaryInvariantLeak = preserveRichMarkdownSource(
  '# 甲\n\n正文\n',
  '# 甲\n\n正文\n',
  '# 甲\n\n正文X\n\n<br />\n\n# 乙\n'
)
assert.equal(
  /<br\s*\/?>/.test(boundaryInvariantLeak.markdown || ''),
  false,
  'a standalone <br /> placeholder must never reach authored source through any path'
)
const inlineBreakPreserved = preserveRichMarkdownSource(
  '第一行<br>第二行\n',
  '第一行<br>第二行\n',
  '第一行<br>第二行X\n'
)
assert.equal(
  inlineBreakPreserved.markdown,
  '第一行<br>第二行X\n',
  'an inline authored <br> hard break must survive the boundary invariant'
)

// Full-document deletion: the canonical becomes empty, which is unambiguous.
// Every localized mapping below would fail closed on a diverged source and
// resurrect the old content in source mode, in saves, and after a reopen.
const emptiedDivergedSource = '# 测试\n\n价格是 * 优惠价\n\n- 项一\n- 项二\n\n结尾。\n'
const emptiedDivergedCanonical = '# 测试\n\n价格是 \\* 优惠价\n\n* 项一\n* 项二\n\n结尾。\n'
const emptiedDiverged = preserveRichMarkdownSource(
  emptiedDivergedSource,
  emptiedDivergedCanonical,
  ''
)
assert.equal(emptiedDiverged.reason, 'document-emptied')
assert.equal(
  emptiedDiverged.markdown,
  '',
  'deleting every block in rich mode must empty the source even when the visible stream diverges'
)

const emptiedMarkerDiverged = preserveRichMarkdownSource(
  '# 标题\n\n正文。\n\n- 项一\n- 项二\n\n结尾。',
  '# 标题\n\n正文。\n\n* 项一\n* 项二\n\n结尾。',
  ''
)
assert.equal(
  emptiedMarkerDiverged.markdown,
  '',
  'a list-marker divergence must not leave a `# ` remnant behind after a full deletion'
)

const emptiedCrlfBom = preserveRichMarkdownSource(
  '\uFEFF# Windows 标题\r\n\r\n正文。\r\n',
  '# Windows 标题\n\n正文。\n',
  ''
)
assert.equal(
  emptiedCrlfBom.markdown,
  '',
  'a full deletion must empty the file regardless of BOM/CRLF conventions'
)

// RS-45: generated scratch may compact serializer-only loose spacing for a
// populated nested item, but an EMPTY nested item requires the blank separator
// to parse back as a nested list. Dropping it turns `   1. ` into a hard break
// plus literal `1.` inside the parent paragraph.
assert.equal(
  generatedScratchMarkdown('# 你好\n\n1. 测试\n\n   1. <br />\n\n'),
  '# 你好\n\n1. 测试\n\n   1. \n',
  'a generated empty nested ordered item must retain its parse-safe blank line while dropping <br />'
)
assert.equal(
  generatedScratchMarkdown('# 你好\n\n1. 测试\n\n   1. 子项\n\n'),
  '# 你好\n\n1. 测试\n   1. 子项\n',
  'a generated non-empty nested ordered item should remain compact'
)

// RS-49 (0.13.94 real trace): after a transient `* 1. ` input-rule frame,
// Crepe escapes the number once IME/body text makes it literal again. A fresh
// generated document must keep that structural escape: `* 1. text` reparses as
// a nested ordered list, while `* 1\\. text` is one bullet item's paragraph.
assert.equal(
  generatedScratchMarkdown('* 1\\. 是各色个\n\n'),
  '* 1\\. 是各色个\n',
  'generated scratch must preserve an ordered-marker escape at bullet-item body start'
)

// RS-50 (0.13.94 real trace): GFM does not recognize bare `- [ ] ` as a task
// item (`checked` becomes null). Keep an invisible HorseMD sentinel only while
// the task body is truly empty so save/reopen retains checked:false semantics.
assert.equal(
  generatedScratchMarkdown('- [ ] <br />\n\n'),
  '- [ ] \u200B\n',
  'generated empty task item must retain task semantics without exposing <br />'
)
assert.equal(
  generatedScratchMarkdown('- [ ] 任务\n\n'),
  '- [ ] 任务\n',
  'generated non-empty task item must not retain the empty-task sentinel'
)

// RS-70 / 0.13.114 PID 58193 trace line 1050: Enter after a non-empty task
// creates an empty sibling task in the same middle slot. The canonical row is
// `- [ ] <br />`; publishing bare `- [ ]` loses GFM task semantics on reparse.
// Reuse the same source-owned U+200B body sentinel established by RS-50/66.
const middleEmptyTaskSiblingCreated = preserveRichMarkdownSource(
  [
    '# fixture',
    '',
    '- 色个粉色高',
    '',
    '- [ ] 额粉色分',
    '',
    '## after',
    ''
  ].join('\n'),
  [
    '# fixture',
    '',
    '* 色个粉色高',
    '',
    '- [ ] 额粉色分',
    '',
    '## after',
    ''
  ].join('\n'),
  [
    '# fixture',
    '',
    '* 色个粉色高',
    '',
    '- [ ] 额粉色分',
    '- [ ] <br />',
    '',
    '## after',
    ''
  ].join('\n')
)
assert.equal(middleEmptyTaskSiblingCreated.preserved, true)
assert.equal(middleEmptyTaskSiblingCreated.reason, 'middle-empty-block-list-filled')
assert.equal(
  middleEmptyTaskSiblingCreated.markdown,
  [
    '# fixture',
    '',
    '- 色个粉色高',
    '',
    '- [ ] 额粉色分',
    '- [ ] \u200B',
    '',
    '## after',
    ''
  ].join('\n'),
  'Enter after a task item must persist the new empty sibling with the GFM-safe source sentinel'
)
assert.doesNotMatch(
  middleEmptyTaskSiblingCreated.markdown,
  /^- \[ \]$/m,
  'the new empty task sibling must never be published as a bare task marker'
)

// RS-66 / 0.13.111 PID 31051 trace line 616: Slash can create the same
// otherwise-unrepresentable empty task in the MIDDLE of an existing authored
// document. A bare `- [ ] ` reparses as ordinary bracket text, so replacing the
// standalone slash command row must use the same source-owned U+200B sentinel
// as RS-50 without rewriting neighbouring authored list markers or spacing.
const middleEmptyTaskSlashCreated = preserveRichMarkdownSource(
  '- 额发疯\n- 企鹅分\n\n/\n\n1\n',
  '* 额发疯\n* 企鹅分\n\n/\n\n1\n',
  '* 额发疯\n* 企鹅分\n\n- [ ] <br />\n\n1\n'
)
assert.equal(
  middleEmptyTaskSlashCreated.markdown,
  '- 额发疯\n- 企鹅分\n\n- [ ] \u200B\n\n1\n',
  'creating an empty task from a middle slash command must persist a GFM-safe sentinel only in that row'
)
assert.equal(
  middleEmptyTaskSlashCreated.reason,
  'empty-task-slash-created',
  'middle slash-created empty task must use a dedicated source-owned sentinel proof'
)
const batchedEmptyTaskSlashCreated = preserveRichMarkdownSource(
  '/\n\n后文\n',
  '/\n\n后文\n',
  '- [ ] <br />\n\n后文也变了\n'
)
assert.notEqual(
  batchedEmptyTaskSlashCreated.reason,
  'empty-task-slash-created',
  'RS-66 proof must not claim a transaction that changes another canonical block at the same time'
)
const nonEmptyTaskSlashCreated = preserveRichMarkdownSource(
  '/\n',
  '/\n',
  '- [ ] 任务\n'
)
assert.notEqual(
  nonEmptyTaskSlashCreated.reason,
  'empty-task-slash-created',
  'RS-66 proof must not claim a non-empty task conversion'
)

// Leading spaces typed in rich mode are serialized by remark-stringify as the
// `&#x20;` entity (a literal space at line start would be parsed as indentation
// or a list). That is a canonical spelling, never authored source: every
// canonical→source translation must restore the real spaces.
const LEADING_SPACE_SENTINEL = '\u200B'
assert.equal(
  generatedScratchMarkdown('# &#x20;       hello\n'),
  `# ${LEADING_SPACE_SENTINEL}        hello\n`,
  'a generated scratch document must spell leading spaces with an invisible Markdown-safe sentinel, not an entity'
)
assert.equal(
  generatedScratchMarkdown('    &#x20;缩进正文\n'),
  `    ${LEADING_SPACE_SENTINEL} 缩进正文\n`,
  'canonical structural indentation must not hide a generated leading-space entity'
)
assert.equal(
  generatedScratchMarkdown('* 父项\n\n    &#x20;列表续行\n'),
  `* 父项\n\n    ${LEADING_SPACE_SENTINEL} 列表续行\n`,
  'a list continuation with four structural spaces must still restore the authored leading space'
)
assert.equal(
  generatedScratchMarkdown('\t&#x20;制表缩进正文\n'),
  `\t${LEADING_SPACE_SENTINEL} 制表缩进正文\n`,
  'canonical tab indentation must not hide a generated leading-space entity'
)
// A lone `-` typed at line start is serialized with a protective backslash
// (`\-`); restoring the raw char would turn the source line into an empty
// bullet item and fail the document-integrity check. The escape must survive
// every canonical→source translation, while mid-line escapes still restore.
assert.equal(
  canonicalFreshTextToSource('\\-'),
  '\\-',
  'a leading escaped bullet marker must keep its escape'
)
assert.equal(
  canonicalFreshTextToSource('1\\.'),
  '1.',
  'an escaped period after visible text still restores to the typed char'
)
const loneDashChange = preserveRichMarkdownSource(
  '微风微风wef123 \n\nwfwefm    \n',
  '微风微风wef123\n\n<br />\n\nwfwefm\n',
  '微风微风wef123\n\n\\-\n\nwfwefm\n'
)
assert.equal(loneDashChange.preserved, true)
assert.equal(
  loneDashChange.markdown,
  '微风微风wef123 \n\n\\-\n\nwfwefm    \n',
  'filling a middle empty block with a typed dash must keep the serializer escape'
)
// RS-83 / 0.13.128 PID 85614 trace line 630: an already-published
// standalone `\\-` paragraph receives two more hyphens before the next source
// callback. ProseMirror turns it into hr and Crepe serializes `***`; the source
// owner must replace the independent authored row with the typed `---`, not
// append the zero-visible break to the preceding ordered item.
const middleThematicBreakSource = [
  '# RS83', '',
  '- authored marker',
  '- 1\\. literal', '',
  '1. first', '',
  '2. second', '',
  '3. 3fresh', '',
  '\\-', '',
  '1. following', '',
  '2. \u200B leading', ''
].join('\n')
const middleThematicBreakPrevious = [
  '# RS83', '',
  '* authored marker', '',
  '* 1\\. literal', '',
  '1. first', '',
  '2. second', '',
  '3. 3fresh', '',
  '\\-', '',
  '1. following', '',
  '2. &#x20;leading', ''
].join('\n')
const middleThematicBreakNext = middleThematicBreakPrevious.replace(
  '\\-\n\n1. following',
  '***\n\n1. following'
)
const middleThematicBreakExpected = middleThematicBreakSource.replace(
  '\\-\n\n1. following',
  '---\n\n1. following'
)
const middleThematicBreakChange = commonChange(
  middleThematicBreakPrevious,
  middleThematicBreakNext
)
const middleThematicBreakDirect = preserveEscapedStandaloneThematicBreakInputRule({
  source: middleThematicBreakSource,
  previous: middleThematicBreakPrevious,
  next: middleThematicBreakNext,
  ...middleThematicBreakChange
})
assert.equal(middleThematicBreakDirect?.reason, 'escaped-standalone-thematic-break-input-rule')
assert.equal(middleThematicBreakDirect?.markdown, middleThematicBreakExpected)
const middleThematicBreakPublic = preserveRichMarkdownSource(
  middleThematicBreakSource,
  middleThematicBreakPrevious,
  middleThematicBreakNext
)
assert.equal(middleThematicBreakPublic.preserved, true)
assert.equal(middleThematicBreakPublic.reason, 'escaped-standalone-thematic-break-input-rule')
assert.equal(middleThematicBreakPublic.markdown, middleThematicBreakExpected)
assert.doesNotMatch(middleThematicBreakPublic.markdown, /3\. 3fresh---/)
const middleThematicBreakCrLf = preserveRichMarkdownSource(
  middleThematicBreakSource.replace(/\n/g, '\r\n'),
  middleThematicBreakPrevious,
  middleThematicBreakNext
)
assert.equal(
  middleThematicBreakCrLf.markdown,
  middleThematicBreakExpected.replace(/\n/g, '\r\n'),
  'RS-83 must replace only the escaped row and preserve authored CRLF'
)
const middleThematicBreakBatchedNext = middleThematicBreakNext.replace('1. following', '1. followingX')
assert.equal(
  preserveEscapedStandaloneThematicBreakInputRule({
    source: middleThematicBreakSource,
    previous: middleThematicBreakPrevious,
    next: middleThematicBreakBatchedNext,
    ...commonChange(middleThematicBreakPrevious, middleThematicBreakBatchedNext)
  }),
  null,
  'RS-83 must reject a thematic-break conversion batched with an unrelated body edit'
)
assert.equal(
  preserveEscapedStandaloneThematicBreakInputRule({
    source: `${middleThematicBreakSource}\n${middleThematicBreakSource}`,
    previous: middleThematicBreakPrevious,
    next: middleThematicBreakNext,
    ...middleThematicBreakChange
  }),
  null,
  'RS-83 must reject duplicate authored targets with the same neighbours'
)
const middleThematicPlainNext = middleThematicBreakPrevious.replace('\\-', '--x')
assert.equal(
  preserveEscapedStandaloneThematicBreakInputRule({
    source: middleThematicBreakSource,
    previous: middleThematicBreakPrevious,
    next: middleThematicPlainNext,
    ...commonChange(middleThematicBreakPrevious, middleThematicPlainNext)
  }),
  null,
  'RS-83 must not claim an ordinary escaped punctuation expansion'
)

const loneOrderedMarkerChange = preserveRichMarkdownSource(
  '前文\n\n123\n\n2. 后文\n',
  '前文\n\n123\n\n<br />\n\n2. 后文\n',
  '前文\n\n123\n\n1\\.\n\n2. 后文\n'
)
assert.equal(loneOrderedMarkerChange.preserved, true)
assert.equal(loneOrderedMarkerChange.reason, 'middle-empty-block-filled')
assert.equal(
  loneOrderedMarkerChange.markdown,
  '前文\n\n123\n\n1\\.\n\n2. 后文\n',
  'filling a middle empty block with literal `1.` must keep the serializer escape instead of creating an ordered list'
)
const leadingSpaceChange = preserveRichMarkdownSource(
  '第一段正文。\n',
  '第一段正文。\n',
  '第一段正文。\n\n&#x20;     顶格文字\n'
)
assert.equal(
  leadingSpaceChange.markdown,
  `第一段正文。\n\n${LEADING_SPACE_SENTINEL}      顶格文字\n`,
  'a canonical line-leading `&#x20;` must reach the authored source as a real space'
)
const leadingSpaceNewDocument = preserveRichMarkdownSource('', '', '# &#x20;     顶格文字\n')
assert.equal(
  leadingSpaceNewDocument.markdown,
  `# ${LEADING_SPACE_SENTINEL}      顶格文字\n`,
  'the empty-document canonical path must unescape leading-space entities too'
)

// A list item with one literal leading space is initially serialized as
// `&#x20;` and stored as U+200B + space. Once the user types another ordinary
// space after the item text, the canonical line becomes two plain spaces after
// the marker; the stale sentinel must be removed from the candidate rather
// than surviving the locally-aligned append.
const leadingSpaceListTransition = preserveRichMarkdownSource(
  '1. 第一项\n2. 第二项\n3. \u200B 色粉色分看了你快乐\n4. 第四项\n',
  '1. 第一项\n2. 第二项\n3. &#x20;色粉色分看了你快乐\n4. 第四项\n',
  '1. 第一项\n2. 第二项\n3.  色粉色分看了你快乐 \n4. 第四项\n'
)
assert.equal(leadingSpaceListTransition.preserved, true)
assert.equal(leadingSpaceListTransition.reason, 'leading-space-sentinel-reconciled')
assert.equal(
  leadingSpaceListTransition.markdown,
  '1. 第一项\n2. 第二项\n3.  色粉色分看了你快乐 \n4. 第四项\n',
  'adding a second space must remove the stale leading-space sentinel from the list item'
)
assert.doesNotMatch(
  leadingSpaceListTransition.markdown,
  /\u200B/,
  'the reconciled source must not retain U+200B after canonical spelling returns to plain spaces'
)

// A held Space key emits multiple whitespace-only canonical snapshots before
// the first visible character. None of those intermediate states may write to
// source or collapse the paragraph separator onto the previous paragraph.
const heldSpaceSource = '# test\n\nanchor\n'
const heldSpaceEmpty = '# test\n\nanchor\n\n<br />\n\n'
const heldSpaceTwo = '# test\n\nanchor\n\n<br />\n\n  \n'
const heldSpaceThree = '# test\n\nanchor\n\n<br />\n\n   \n'
const heldSpaceAfterTwo = preserveRichMarkdownSource(
  heldSpaceSource,
  heldSpaceEmpty,
  heldSpaceTwo
)
assert.equal(
  ['trailing-empty-block-whitespace', 'diverged-tail-block-append'].includes(heldSpaceAfterTwo.reason),
  true,
  `held-space intermediate must be owned by a whitespace/append mapper, got ${heldSpaceAfterTwo.reason}`
)
assert.equal(heldSpaceAfterTwo.markdown, heldSpaceSource)
const heldSpaceAfterThree = preserveRichMarkdownSource(
  heldSpaceSource,
  heldSpaceTwo,
  heldSpaceThree
)
assert.equal(heldSpaceAfterThree.reason, 'trailing-empty-block-whitespace')
assert.equal(heldSpaceAfterThree.markdown, heldSpaceSource)
const heldSpaceText = preserveRichMarkdownSource(
  heldSpaceSource,
  '# test\n\nanchor\n\n<br />\n\n       \n',
  '# test\n\nanchor\n\n<br />\n\n&#x20;       abc\n'
)
assert.equal(
  heldSpaceText.markdown,
  `# test\n\nanchor\n\n${LEADING_SPACE_SENTINEL}        abc\n`,
  'the first visible character after held spaces must append one intact paragraph using Typora-style source spelling'
)

// A typed `~` is serialized as `\~` (GFM strikethrough guard). The authored
// source must keep the literal tilde: single `~` is never a strikethrough, so
// unescaping is semantics-preserving.
assert.equal(
  generatedScratchMarkdown('# 审计 0\\~9\n'),
  '# 审计 0~9\n',
  'a generated scratch document must spell tildes literally, not as \\~ escapes'
)
assert.equal(
  generatedScratchMarkdown([
    '```text',
    '&#x20;',
    '\\~',
    '```',
    '',
    '`&#x20; \\~`',
    '',
    '<span data-x="\\~">&#x20;</span>',
    '',
    '<div>',
    '&#x20;',
    '\\~',
    '</div>',
    '',
    '# &#x20; hi 0\\~9',
    ''
  ].join('\n')),
  [
    '```text',
    '&#x20;',
    '\\~',
    '```',
    '',
    '`&#x20; \\~`',
    '',
    '<span data-x="\\~">&#x20;</span>',
    '',
    '<div>',
    '&#x20;',
    '\\~',
    '</div>',
    '',
    `# ${LEADING_SPACE_SENTINEL}  hi 0~9`,
    ''
  ].join('\n'),
  'canonical escape translation must not alter fenced or inline-code literals'
)
assert.equal(
  generatedScratchMarkdown('外部 0\\~9 <span data-x="\\~">&#x20;</span> 后续 1\\~2\n'),
  '外部 0~9 <span data-x="\\~">&#x20;</span> 后续 1~2\n',
  'inline HTML must protect only its own token range while surrounding Markdown escapes are restored'
)
assert.equal(
  generatedScratchMarkdown('``code ` &#x20; \\~ literal`` 外部 0\\~9\n'),
  '``code ` &#x20; \\~ literal`` 外部 0~9\n',
  'double-backtick code spans containing a single backtick must remain literal while outside text is restored'
)
assert.equal(
  generatedScratchMarkdown('\\`\\`\\`你好\\`\\`\\`\n'),
  '```你好```\n',
  'same-line triple-backtick text typed in a scratch document must not expose serializer escapes'
)
const literalTripleBacktickNewDocument = preserveRichMarkdownSource(
  '',
  '',
  '\\`\\`\\`你好\\`\\`\\`\n'
)
assert.equal(literalTripleBacktickNewDocument.reason, 'new-document')
assert.equal(
  literalTripleBacktickNewDocument.markdown,
  '```你好```\n',
  'an empty-file first edit must restore typed triple backticks before source mode or save'
)
const tildeNewDocument = preserveRichMarkdownSource('', '', '# 审计 0\\~9\n')
assert.equal(
  tildeNewDocument.markdown,
  '# 审计 0~9\n',
  'the empty-document canonical path must unescape \\~ too'
)
// In an existing document the whole-paragraph replacement carries the escaped
// canonical spelling; it must still land as the author's literal tilde.
const tildeWholeParagraph = preserveRichMarkdownSource(
  '审计起点：0~9。\n',
  '审计起点：0\\~9。\n',
  '审计起点：0\\~9X。\n'
)
assert.equal(
  tildeWholeParagraph.markdown,
  '审计起点：0~9X。\n',
  'an escaped canonical tilde must reach the authored source literally'
)

const exactBaselineEscapes = preserveRichMarkdownSource(
  '# 标题\n\n正文\n',
  '# 标题\n\n正文\n',
  '# 标题\n\n正文 0\\~9\n\n&#x20; 后续\n'
)
assert.equal(
  exactBaselineEscapes.markdown,
  `# 标题\n\n正文 0~9\n\n${LEADING_SPACE_SENTINEL}  后续\n`,
  'the exact-canonical baseline must use the same context-aware translation as every other canonical write'
)

// remark parses `- 1. 甲乙` as a NESTED ORDERED LIST (`1. 甲`, `2. 乙`): the
// `1. ` item text leaves the canonical visible stream while the authored
// source keeps it, so the whole document diverges and every list-internal
// text edit used to roll back to the OLD source (typed text silently lost).
// The canonical below is the real Crepe serialization captured from the app.
const nestedListSource = '- 1. 甲乙\n- 丙丁\n'
const nestedListPrevious = '* <br />\n\n  1. 甲\n  2. 乙\n\n* 丙丁\n\n'
const nestedListNext = '* <br />\n\n  1. 甲\n  2. 新乙\n\n* 丙丁\n\n'
const nestedListEnterSplit = preserveRichMarkdownSource(
  nestedListSource,
  '* <br />\n\n  1. 甲乙\n\n* 丙丁\n',
  '* <br />\n\n  1. 甲\n  2. 乙\n\n* 丙丁\n\n'
)
assert.equal(nestedListEnterSplit.preserved, true)
assert.equal(
  nestedListEnterSplit.markdown,
  '- 1. 甲\n  2. 乙\n- 丙丁\n',
  'an Enter split must keep the new ordered sibling inside the same authored outer bullet'
)
const nestedListSplit = preserveRichMarkdownSource(
  nestedListSource,
  nestedListPrevious,
  nestedListNext
)
assert.equal(
  nestedListSplit.reason,
  'diverged-nested-list-change',
  'a list-internal text edit inside a nested-number-diverged document must map through item-sequence alignment'
)
assert.equal(
  nestedListSplit.markdown,
  '- 1. 甲新乙\n- 丙丁\n',
  'the typed text must reach the authored `- 1. …` spelling instead of vanishing'
)

const nestedListPlainEdit = preserveRichMarkdownSource(
  nestedListSource,
  nestedListPrevious,
  '* <br />\n\n  1. 甲X\n  2. 乙\n\n* 丙丁\n\n'
)
assert.equal(
  nestedListPlainEdit.markdown,
  '- 1. 甲X乙\n- 丙丁\n',
  'a plain text edit on the first nested item must map back into the flat authored text'
)

const nestedBulletSource = [
  '- 你好 1. 2. 测试',
  '- - 测试 1. 你好',
  '- 测试 - 测试 1. 2. 测试',
  ''
].join('\n')
const nestedBulletPrevious = [
  '* 你好 1. 2. 测试',
  '',
  '* <br />',
  '',
  '  * 测试 1. 你好',
  '',
  '* 测试 - 测试 1. 2. 测试',
  ''
].join('\n')
const nestedBulletItemEdited = preserveRichMarkdownSource(
  nestedBulletSource,
  nestedBulletPrevious,
  nestedBulletPrevious.replace('  * 测试 1. 你好', '  * 测试 1. 你好X')
)
assert.equal(nestedBulletItemEdited.preserved, true)
assert.equal(
  nestedBulletItemEdited.markdown,
  nestedBulletSource.replace('- - 测试 1. 你好', '- - 测试 1. 你好X'),
  'editing a `- - text` nested bullet must preserve both authored markers and update only its body'
)
const nestedBulletSiblingEdited = preserveRichMarkdownSource(
  nestedBulletSource,
  nestedBulletPrevious,
  nestedBulletPrevious.replace('* 测试 - 测试 1. 2. 测试', '* 测试 - 测试 1. 2. 测试X')
)
assert.equal(nestedBulletSiblingEdited.preserved, true)
assert.equal(
  nestedBulletSiblingEdited.markdown,
  nestedBulletSource.replace('- 测试 - 测试 1. 2. 测试', '- 测试 - 测试 1. 2. 测试X'),
  'a nested-bullet divergence earlier in the list must not block editing a later sibling row'
)

const nestedListItemRemoved = preserveRichMarkdownSource(
  nestedListSource,
  nestedListPrevious,
  '* <br />\n\n  1. 甲\n\n* 丙丁\n\n'
)
assert.equal(
  nestedListItemRemoved.markdown,
  '- 1. 甲\n- 丙丁\n',
  'removing the nested `2. 乙` item must remove only 乙 from the authored row'
)

// RS-67 / 0.13.112 PID 32752 trace line 43: clearing the BODY of a
// top-level ordered item that still owns a nested ordered child is not an item
// removal. The authored parent marker must survive as an empty row so the child
// keeps the same list depth; dropping `1. ` promotes/orphans the nested child
// and trips source-list-structure-mismatch.
const nestedOrderedParentBodyEmptied = preserveRichMarkdownSource(
  '- u高科技\n- 1\\. 色粉色分\n\n1. 啊\n   1. 微风\n',
  '* u高科技\n\n* 1\\. 色粉色分\n\n1. 啊\n\n   1. 微风\n\n',
  '* u高科技\n\n* 1\\. 色粉色分\n\n1. <br />\n\n   1. 微风\n\n'
)
assert.equal(
  nestedOrderedParentBodyEmptied.markdown,
  '- u高科技\n- 1\\. 色粉色分\n\n1. \n   1. 微风\n',
  'emptying a parent ordered item body must preserve its marker and nested child structure'
)
assert.equal(
  nestedOrderedParentBodyEmptied.reason,
  'nested-list-parent-body-emptied',
  'nested parent body emptying must be proven before the broad diverged nested-list mapper'
)
const nestedOrderedParentWithoutChild = preserveRichMarkdownSource(
  '1. 啊\n',
  '1. 啊\n\n',
  '1. <br />\n\n'
)
assert.notEqual(
  nestedOrderedParentWithoutChild.reason,
  'nested-list-parent-body-emptied',
  'RS-67 proof must not claim an ordinary empty list item with no nested child'
)

// RS-68 / 0.13.113 PID 34380 trace line 99: fast Backspace cadence can
// coalesce all parent-body deletions plus the next structural Backspace before
// the deferred markdownUpdated callback publishes an intermediate RS-67
// checkpoint. The raw canonical therefore jumps directly from a non-empty
// ordered parent to an empty bullet parent, with the nested child unchanged.
// Source must change only the parent marker/body and MUST NOT retain a blank
// line between the now-empty bullet marker and its nested child.
const rapidNestedOrderedParentLift = preserveRichMarkdownSource(
  '- u高科技\n\n1. 啊额法\n   1. 微风\n',
  '* u高科技\n\n1. 啊额法\n\n   1. 微风\n\n',
  '* u高科技\n\n* <br />\n\n  1. 微风\n\n'
)
assert.equal(rapidNestedOrderedParentLift.preserved, true)
assert.equal(rapidNestedOrderedParentLift.reason, 'rapid-nested-ordered-parent-backspace-lift')
assert.equal(rapidNestedOrderedParentLift.integrityProof?.kind, 'localized-list-slots')
assert.equal(
  rapidNestedOrderedParentLift.markdown,
  '- u高科技\n\n- \n   1. 微风\n',
  'rapid ordered-parent lift must keep the child nested while deleting only the parent body and changing its marker'
)
const rapidNestedOrderedParentLiftWithChildEdit = preserveRichMarkdownSource(
  '- u高科技\n\n1. 啊额法\n   1. 微风\n',
  '* u高科技\n\n1. 啊额法\n\n   1. 微风\n\n',
  '* u高科技\n\n* <br />\n\n  1. 新微风\n\n'
)
assert.notEqual(
  rapidNestedOrderedParentLiftWithChildEdit.reason,
  'rapid-nested-ordered-parent-backspace-lift',
  'RS-68 proof must fail closed when the nested child changes in the same callback'
)
const rapidNestedOrderedParentLiftWithUnrelatedBodyEdit = preserveRichMarkdownSource(
  '- u高科技\n\n1. 啊额法\n   1. 微风\n\n- 后项\n',
  '* u高科技\n\n1. 啊额法\n\n   1. 微风\n\n* 后项\n',
  '* u高科技\n\n* <br />\n\n  1. 微风\n\n- 后项X\n'
)
assert.notEqual(
  rapidNestedOrderedParentLiftWithUnrelatedBodyEdit.reason,
  'rapid-nested-ordered-parent-backspace-lift',
  'RS-68 proof may tolerate serializer-only bullet marker drift but must reject an unrelated body edit'
)

const nestedListZeroWidthAppend = preserveRichMarkdownSource(
  nestedListSource,
  nestedListPrevious,
  '* <br />\n\n  1. 甲\n  2. 乙\n  3. 戊\n\n* 丙丁\n\n'
)
assert.equal(
  nestedListZeroWidthAppend.reason,
  'diverged-nested-list-change',
  'a zero-width nested append must use the item-sequence path, not the corrupted line mapper'
)
assert.equal(
  nestedListZeroWidthAppend.markdown,
  '- 1. 甲乙\n  3. 戊\n- 丙丁\n',
  'a nested append must stay indented inside the authored outer bullet instead of creating another bullet'
)

// Enter at the end of the flat row creates an EMPTY canonical item (`2. `),
// which the visible map would otherwise keep as literal `2. ` text and break
// the anchor. Filling that item must reach the authored row.
const nestedListEmptyItemFilled = preserveRichMarkdownSource(
  '- 1. 甲乙\n- 丙丁\n',
  '* <br />\n\n  1. 甲乙\n  2. <br />\n\n* 丙丁\n\n',
  '* <br />\n\n  1. 甲乙\n  2. 后记\n\n* 丙丁\n\n'
)
assert.equal(
  nestedListEmptyItemFilled.reason,
  'diverged-nested-list-change',
  'filling a canonical empty nested item must map through item-sequence alignment'
)
assert.equal(
  nestedListEmptyItemFilled.markdown,
  '- 1. 甲乙\n  2. 后记\n- 丙丁\n',
  'filling an Entered empty nested item must stay inside the authored outer bullet'
)

// Backspace at the start of a nested ordered item removes only that inner
// marker. Crepe keeps the outer bullet wrapper and serializes the lifted text
// as an indented continuation line. This is a marker-only change, not an empty
// item: the authored row must become `- text`, never `- 2. `.
const nestedNumberMarkerRemoved = preserveRichMarkdownSource(
  '- 1. 管理层（总经理）\n- 2. 综合行政部\n- 3. 人力资源部\n',
  '* <br />\n\n  1. 管理层（总经理）\n\n* <br />\n\n  2. 综合行政部\n\n* <br />\n\n  3. 人力资源部\n\n',
  '* <br />\n\n  1. 管理层（总经理）\n\n* <br />\n\n  综合行政部\n\n* <br />\n\n  3. 人力资源部\n\n'
)
assert.equal(nestedNumberMarkerRemoved.reason, 'diverged-nested-list-change')
assert.equal(
  nestedNumberMarkerRemoved.markdown,
  '- 1. 管理层（总经理）\n- 综合行政部\n- 3. 人力资源部\n',
  'removing a nested ordered marker must retain the item text and outer authored bullet'
)

const nestedOuterMarkerRemoved = preserveRichMarkdownSource(
  '- 1. 管理层（总经理）\n- 综合行政部\n- 3. 人力资源部\n',
  '* <br />\n\n  1. 管理层（总经理）\n\n* 综合行政部\n\n* <br />\n\n  3. 人力资源部\n\n',
  '* <br />\n\n  1. 管理层（总经理）\n\n  综合行政部\n\n* <br />\n\n  3. 人力资源部\n\n'
)
assert.equal(nestedOuterMarkerRemoved.reason, 'diverged-nested-list-change')
assert.equal(
  nestedOuterMarkerRemoved.markdown,
  '- 1. 管理层（总经理）\n  综合行政部\n- 3. 人力资源部\n',
  'lifting the outer bullet must retain its text as the preceding item continuation'
)

const nestedWrapperCollapsedWithoutSourceChange = preserveRichMarkdownSource(
  '- 1. 管理层（总经理）\n- 综合行政部\n- 3. 人力资源部\n',
  '* <br />\n\n  1. 管理层（总经理）\n\n* <br />\n\n  综合行政部\n\n* <br />\n\n  3. 人力资源部\n\n',
  '* <br />\n\n  1. 管理层（总经理）\n\n* 综合行政部\n\n* <br />\n\n  3. 人力资源部\n\n'
)
assert.equal(nestedWrapperCollapsedWithoutSourceChange.preserved, true)
assert.equal(
  nestedWrapperCollapsedWithoutSourceChange.markdown,
  '- 1. 管理层（总经理）\n- 综合行政部\n- 3. 人力资源部\n',
  'a canonical-only wrapper collapse must advance the baseline without rewriting authored source'
)

const divergedOrdinaryContinuation = preserveRichMarkdownSource(
  '- 1. 数字项\n\n- alphabeta\n',
  '* <br />\n\n  1. 数字项\n\n* alphabeta\n\n',
  '* <br />\n\n  1. 数字项\n\n* alpha\n  beta\n\n'
)
assert.equal(
  divergedOrdinaryContinuation.markdown,
  '- 1. 数字项\n\n- alpha\n  beta\n',
  'a normal multiline continuation in a diverged document must keep indentation instead of becoming a new bullet'
)

const divergedCrLfEdit = preserveRichMarkdownSource(
  '+ 1. AB\r\n+ tail\r\n',
  '* <br />\n\n  1. AB\n\n* tail\n\n',
  '* <br />\n\n  1. ABX\n\n* tail\n\n'
)
assert.equal(
  divergedCrLfEdit.markdown,
  '+ 1. ABX\r\n+ tail\r\n',
  'diverged list edits must retain CRLF and the authored bullet marker'
)

const divergedAndLaterBatch = preserveRichMarkdownSource(
  '- 1. A\n\n- normal\n',
  '* <br />\n\n  1. A\n\n* normal\n\n',
  '* <br />\n\n  1. AX\n\n* normalX\n\n'
)
assert.equal(
  divergedAndLaterBatch.markdown,
  '- 1. AX\n\n- normalX\n',
  'one deferred callback must commit both a diverged numbered-text list and a later ordinary list'
)

const divergedAndHeadingBatch = preserveRichMarkdownSource(
  '- 1. A\n\n## Heading\n',
  '* <br />\n\n  1. A\n\n## Heading\n',
  '* <br />\n\n  1. AX\n\n# Heading\n'
)
assert.equal(divergedAndHeadingBatch.preserved, false)
assert.equal(
  divergedAndHeadingBatch.markdown,
  '- 1. A\n\n## Heading\n',
  'a partially mapped callback must roll back atomically instead of reporting success while dropping heading structure'
)

const divergedListThenParagraph = preserveRichMarkdownSource(
  '- 1. A\n- B\n\n- target\n\n```\ncode\n```\n',
  '* <br />\n\n  1. A\n\n* B\n\n* target\n\n```\ncode\n```\n\n',
  '* <br />\n\n  1. A\n\n* B\n\n* target继续\n\n* next\n\nprose\n\n```\ncode\n```\n\n'
)
assert.equal(divergedListThenParagraph.preserved, true)
assert.equal(divergedListThenParagraph.reason, 'diverged-list-continuation')
assert.equal(
  divergedListThenParagraph.markdown,
  '- 1. A\n- B\n\n- target继续\n- next\n\nprose\n\n```\ncode\n```\n',
  'continuing a persisted list and immediately typing the following paragraph must commit as one bounded insertion'
)

const divergedListThenParagraphCrLf = preserveRichMarkdownSource(
  '- 1. A\r\n- B\r\n\r\n- target\r\n\r\n```\r\ncode\r\n```\r\n',
  '* <br />\n\n  1. A\n\n* B\n\n* target\n\n```\ncode\n```\n\n',
  '* <br />\n\n  1. A\n\n* B\n\n* target继续\n\n* next\n\nprose\n\n```\ncode\n```\n\n'
)
assert.equal(
  divergedListThenParagraphCrLf.markdown,
  '- 1. A\r\n- B\r\n\r\n- target继续\r\n- next\r\n\r\nprose\r\n\r\n```\r\ncode\r\n```\r\n',
  'a diverged list continuation must splice before CRLF rather than between its CR and LF bytes'
)

const divergedMiddleListSlotFill = preserveRichMarkdownSource(
  '- 1. divergence\n\n轮三正文\n\n```\ncode\n```\n',
  '* <br />\n\n  1. divergence\n\n轮三正文\n\n<br />\n\n```\ncode\n```\n\n',
  '* <br />\n\n  1. divergence\n\n轮三正文\n\n1. 轮四有序\n2. 轮四续项\n\n轮四尾文\n\n```\ncode\n```\n\n'
)
assert.equal(divergedMiddleListSlotFill.preserved, true)
assert.equal(divergedMiddleListSlotFill.reason, 'middle-block-before-authored-fence')
assert.equal(
  divergedMiddleListSlotFill.markdown,
  '- 1. divergence\n\n轮三正文\n\n1. 轮四有序\n2. 轮四续项\n\n轮四尾文\n\n```\ncode\n```\n',
  'a list and its following prose must atomically replace the proven middle empty paragraph slot'
)

const divergedMiddleListSlotFillCrLf = preserveRichMarkdownSource(
  '- 1. divergence\r\n\r\nbefore\r\n\r\n```\r\ncode\r\n```\r\n',
  '* <br />\n\n  1. divergence\n\nbefore\n\n<br />\n\n```\ncode\n```\n\n',
  '* <br />\n\n  1. divergence\n\nbefore\n\n1. item\n2. next\n\nafter\n\n```\ncode\n```\n\n'
)
assert.equal(divergedMiddleListSlotFillCrLf.preserved, true)
assert.equal(
  divergedMiddleListSlotFillCrLf.markdown,
  '- 1. divergence\r\n\r\nbefore\r\n\r\n1. item\r\n2. next\r\n\r\nafter\r\n\r\n```\r\ncode\r\n```\r\n',
  'a CRLF middle list slot must replace the complete left EOL pair without producing a lone carriage return'
)
assert.equal(
  /\r(?!\n)/.test(divergedMiddleListSlotFillCrLf.markdown),
  false,
  'a CRLF middle list slot must never emit a lone carriage return'
)

const orderedContinuationBeforeFence = preserveRichMarkdownSource(
  '1) 目标\n\n```js\ncode\n```\n',
  '1. 目标\n\n```js\ncode\n```\n\n',
  '1. 目标\n2. <br />\n\n```js\ncode\n```\n\n'
)
assert.equal(orderedContinuationBeforeFence.preserved, true)
assert.equal(orderedContinuationBeforeFence.reason, 'middle-block-before-authored-fence')
assert.equal(
  orderedContinuationBeforeFence.markdown,
  '1) 目标\n2) \n\n```js\ncode\n```\n',
  'an ordered continuation inserted before an authored fence must keep the canonical ordinal while preserving the authored delimiter style'
)

const literalOrderedMarkerBeforeFence = preserveRichMarkdownSource(
  '- u高科技\n\n```\ncode\n```\n',
  '* u高科技\n\n<br />\n\n```\ncode\n```\n\n',
  '* u高科技\n\n1\\.\n\n```\ncode\n```\n\n'
)
assert.equal(literalOrderedMarkerBeforeFence.preserved, true)
assert.equal(literalOrderedMarkerBeforeFence.reason, 'middle-block-before-authored-fence')
assert.equal(
  literalOrderedMarkerBeforeFence.markdown,
  '- u高科技\n\n1\\.\n\n```\ncode\n```\n',
  'a literal `1.` typed into a newly exited-list paragraph before an authored fence must keep its protective escape until the trailing space converts it into a real list'
)

const literalOrderedMarkerInsideEmptyBulletBeforeFence = preserveRichMarkdownSource(
  '- u高科技\n\n- \n\n```\ncode\n```\n',
  '* u高科技\n\n* <br />\n\n```\ncode\n```\n\n',
  '* u高科技\n\n* 1\\.\n\n```\ncode\n```\n\n'
)
assert.equal(literalOrderedMarkerInsideEmptyBulletBeforeFence.preserved, true)
assert.equal(
  literalOrderedMarkerInsideEmptyBulletBeforeFence.markdown,
  '- u高科技\n\n- 1\\.\n\n```\ncode\n```\n',
  'filling an authored empty bullet before a fence with literal `1.` must preserve both the authored bullet marker and the protective body escape'
)

// Enter inside an EMPTY ordered item removes that row and exits the list.
// The authored blank lines created while exiting must collapse back to the
// canonical single empty-block segment, or the list-slot fingerprint fails
// closed (0.13.68 regression: `3. ` removed but four blank rows left behind).
// Backspace on the SECOND of two empty ordered items is different from Enter
// exit: Crepe first lifts that empty item into an indented hardbreak-only
// paragraph under the preceding item. The `<br />` is not authored content;
// the persistable edit is exactly removing the empty row and renumbering the
// following items. This is the 0.13.78 real trace shape.
const emptyOrderedBackspaceLiftSource = [
  '前文', '',
  '2. ',
  '3. ',
  '4. 你离开你',
  '5. 斛律v哦', '', '',
  '- 后文', ''
].join('\n')
const emptyOrderedBackspaceLiftPrevious = [
  '前文', '',
  '2. <br />',
  '3. <br />',
  '4. 你离开你',
  '5. 斛律v哦', '',
  '* 后文', ''
].join('\n')
const emptyOrderedBackspaceLiftNext = [
  '前文', '',
  '2. <br />', '',
  '   <br />',
  '3. 你离开你',
  '4. 斛律v哦', '',
  '* 后文', ''
].join('\n')
const emptyOrderedBackspaceLift = preserveRichMarkdownSource(
  emptyOrderedBackspaceLiftSource,
  emptyOrderedBackspaceLiftPrevious,
  emptyOrderedBackspaceLiftNext
)
assert.equal(emptyOrderedBackspaceLift.preserved, true)
assert.equal(
  emptyOrderedBackspaceLift.markdown,
  [
    '前文', '',
    '2. ', '', '',
    '3. 你离开你',
    '4. 斛律v哦', '', '',
    '- 后文', ''
  ].join('\n'),
  'the first Backspace on an empty ordered item must remove its marker and renumber the suffix without leaking the transient <br />'
)

// RS-85 / 0.13.129 PID 94298 trace lines 585-592: after the body of
// the second top-level ordered item is emptied, one more Backspace merges that
// item into its previous sibling. The nested ordered child moves with it and PM
// keeps one editor-owned empty paragraph immediately BEFORE the child. Source
// must delete only the empty `2. ` row; the dedicated semantic proof owns the
// otherwise-unencodable middle paragraph.
const emptyOrderedBeforeNestedSource = [
  '# RS85', '',
  '1. 是共生共荣',
  '2. ',
  '   1. 如何电话',
  ''
].join('\n')
const emptyOrderedBeforeNestedPrevious = [
  '# RS85', '',
  '1. 是共生共荣', '',
  '2. <br />', '',
  '   1. 如何电话',
  ''
].join('\n')
const emptyOrderedBeforeNestedNext = [
  '# RS85', '',
  '1. 是共生共荣', '',
  '   <br />', '',
  '   1. 如何电话',
  ''
].join('\n')
const emptyOrderedBeforeNestedExpected = [
  '# RS85', '',
  '1. 是共生共荣',
  '   1. 如何电话',
  ''
].join('\n')
const emptyOrderedBeforeNestedDirect = preserveEmptyOrderedItemBackspaceMergeBeforeNestedList({
  source: emptyOrderedBeforeNestedSource,
  previous: emptyOrderedBeforeNestedPrevious,
  next: emptyOrderedBeforeNestedNext
})
assert.equal(
  emptyOrderedBeforeNestedDirect?.reason,
  'empty-ordered-item-merged-before-nested-list'
)
assert.equal(emptyOrderedBeforeNestedDirect?.markdown, emptyOrderedBeforeNestedExpected)
const emptyOrderedBeforeNestedPublic = preserveRichMarkdownSource(
  emptyOrderedBeforeNestedSource,
  emptyOrderedBeforeNestedPrevious,
  emptyOrderedBeforeNestedNext
)
assert.equal(emptyOrderedBeforeNestedPublic.preserved, true)
assert.equal(
  emptyOrderedBeforeNestedPublic.reason,
  'empty-ordered-item-merged-before-nested-list'
)
assert.equal(emptyOrderedBeforeNestedPublic.markdown, emptyOrderedBeforeNestedExpected)
assert.doesNotMatch(emptyOrderedBeforeNestedPublic.markdown, /<br\s*\/?\s*>/i)
const emptyOrderedBeforeNestedCompactPrevious = emptyOrderedBeforeNestedPrevious.replace(
  '1. 是共生共荣\n\n2. <br />',
  '1. 是共生共荣\n2. <br />'
)
const emptyOrderedBeforeNestedCompact = preserveRichMarkdownSource(
  emptyOrderedBeforeNestedSource,
  emptyOrderedBeforeNestedCompactPrevious,
  emptyOrderedBeforeNestedNext
)
assert.equal(emptyOrderedBeforeNestedCompact.preserved, true)
assert.equal(
  emptyOrderedBeforeNestedCompact.reason,
  'empty-ordered-item-merged-before-nested-list'
)
assert.equal(
  emptyOrderedBeforeNestedCompact.markdown,
  emptyOrderedBeforeNestedExpected,
  'RS-85 generated-scratch compact previous must use the same strict owner'
)
const emptyOrderedBeforeNestedCrLf = preserveEmptyOrderedItemBackspaceMergeBeforeNestedList({
  source: emptyOrderedBeforeNestedSource.replace(/\n/g, '\r\n'),
  previous: emptyOrderedBeforeNestedPrevious,
  next: emptyOrderedBeforeNestedNext
})
assert.equal(
  emptyOrderedBeforeNestedCrLf?.markdown,
  emptyOrderedBeforeNestedExpected.replace(/\n/g, '\r\n'),
  'RS-85 must preserve authored CRLF while deleting only the empty ordered row'
)
assert.equal(
  preserveEmptyOrderedItemBackspaceMergeBeforeNestedList({
    source: emptyOrderedBeforeNestedSource,
    previous: emptyOrderedBeforeNestedPrevious,
    next: emptyOrderedBeforeNestedNext.replace('如何电话', '如何电话X')
  }),
  null,
  'RS-85 must reject an unrelated nested-child edit in the same callback'
)
assert.equal(
  preserveEmptyOrderedItemBackspaceMergeBeforeNestedList({
    source: emptyOrderedBeforeNestedSource,
    previous: emptyOrderedBeforeNestedPrevious,
    next: emptyOrderedBeforeNestedNext.replace('   <br />', '  <br />')
  }),
  null,
  'RS-85 must reject an empty paragraph whose indent differs from the child'
)
assert.equal(
  preserveEmptyOrderedItemBackspaceMergeBeforeNestedList({
    source: emptyOrderedBeforeNestedSource,
    previous: emptyOrderedBeforeNestedPrevious.replace('2. <br />', '3. <br />'),
    next: emptyOrderedBeforeNestedNext
  }),
  null,
  'RS-85 must reject a non-consecutive empty ordered sibling'
)
assert.equal(
  preserveEmptyOrderedItemBackspaceMergeBeforeNestedList({
    source: `${emptyOrderedBeforeNestedSource}\n${emptyOrderedBeforeNestedSource}`,
    previous: emptyOrderedBeforeNestedPrevious,
    next: emptyOrderedBeforeNestedNext
  }),
  null,
  'RS-85 must reject duplicate authored parent/empty/child targets'
)

// RS-86 / 0.13.130 PID 258 trace lines 323-333: two Enters arrive
// before markdownUpdated publishes the intermediate empty bullet. The final PM
// tree has one top-level empty paragraph before the surviving sibling list. A
// long-lived list retains `-` in previous canonical, while the newly split
// sibling serializes as `*`; the old generic empty-row mapper used that marker
// residue to delete the NON-EMPTY sibling from authored source. The dedicated
// raw owner proves the marker-only sibling drift and keeps source unchanged.
const coalescedBulletExitSource = [
  '# RS86', '',
  '- authored-prefix', '',
  '- u高科技', '',
  '- 12312', '',
  '- 1\\. 色粉色分', '',
  '1. 后文', ''
].join('\n')
const coalescedBulletExitPrevious = [
  '# RS86', '',
  '* authored-prefix', '',
  '- u高科技', '',
  '- 12312', '',
  '- 1\\. 色粉色分', '',
  '1. 后文', ''
].join('\n')
const coalescedBulletExitNext = [
  '# RS86', '',
  '* authored-prefix', '',
  '- u高科技', '',
  '- 12312', '',
  '<br />', '',
  '* 1\\. 色粉色分', '',
  '1. 后文', ''
].join('\n')
const coalescedBulletExitDirect = preserveCoalescedEmptyBulletExitBeforeSibling({
  source: coalescedBulletExitSource,
  previous: coalescedBulletExitPrevious,
  next: coalescedBulletExitNext
})
assert.equal(coalescedBulletExitDirect?.preserved, true)
assert.equal(
  coalescedBulletExitDirect?.reason,
  'coalesced-empty-bullet-exit-before-sibling'
)
assert.equal(coalescedBulletExitDirect?.markdown, coalescedBulletExitSource)
const coalescedBulletExitPublic = preserveRichMarkdownSource(
  coalescedBulletExitSource,
  coalescedBulletExitPrevious,
  coalescedBulletExitNext
)
assert.equal(coalescedBulletExitPublic.preserved, true)
assert.equal(
  coalescedBulletExitPublic.reason,
  'coalesced-empty-bullet-exit-before-sibling'
)
assert.equal(coalescedBulletExitPublic.markdown, coalescedBulletExitSource)
assert.doesNotMatch(coalescedBulletExitPublic.markdown, /<br\s*\/?\s*>/i)
const coalescedBulletExitCrLf = preserveCoalescedEmptyBulletExitBeforeSibling({
  source: coalescedBulletExitSource.replace(/\n/g, '\r\n'),
  previous: coalescedBulletExitPrevious.replace(/\n/g, '\r\n'),
  next: coalescedBulletExitNext.replace(/\n/g, '\r\n')
})
assert.equal(
  coalescedBulletExitCrLf?.markdown,
  coalescedBulletExitSource.replace(/\n/g, '\r\n'),
  'RS-86 must preserve authored CRLF while keeping the source unchanged'
)
const cleanCoalescedPrevious = coalescedBulletExitPrevious
  .replace('- u高科技', '* u高科技')
  .replace('- 12312', '* 12312')
  .replace('- 1\\. 色粉色分', '* 1\\. 色粉色分')
const cleanCoalescedNext = coalescedBulletExitNext
  .replace('- u高科技', '* u高科技')
  .replace('- 12312', '* 12312')
assert.equal(
  preserveCoalescedEmptyBulletExitBeforeSibling({
    source: coalescedBulletExitSource,
    previous: cleanCoalescedPrevious,
    next: cleanCoalescedNext
  }),
  null,
  'RS-86 must not steal the ordinary all-* middle-empty-block path'
)
const cleanCoalescedPublic = preserveRichMarkdownSource(
  coalescedBulletExitSource,
  cleanCoalescedPrevious,
  cleanCoalescedNext
)
assert.equal(cleanCoalescedPublic.preserved, true)
assert.equal(cleanCoalescedPublic.reason, 'middle-empty-block-created')
assert.equal(cleanCoalescedPublic.markdown, coalescedBulletExitSource)
assert.equal(
  preserveCoalescedEmptyBulletExitBeforeSibling({
    source: coalescedBulletExitSource,
    previous: coalescedBulletExitPrevious,
    next: coalescedBulletExitNext.replace('* 1\\. 色粉色分', '* 1\\. 色粉色分X')
  }),
  null,
  'RS-86 must reject a successor body edit in the same callback'
)
assert.equal(
  preserveCoalescedEmptyBulletExitBeforeSibling({
    source: coalescedBulletExitSource,
    previous: coalescedBulletExitPrevious,
    next: coalescedBulletExitNext.replace('- 12312', '- 12312X')
  }),
  null,
  'RS-86 must reject a preceding item edit in the same callback'
)
assert.equal(
  preserveCoalescedEmptyBulletExitBeforeSibling({
    source: coalescedBulletExitSource,
    previous: coalescedBulletExitPrevious,
    next: coalescedBulletExitNext.replace('<br />', '  <br />')
  }),
  null,
  'RS-86 must reject an indented empty paragraph'
)
assert.equal(
  preserveCoalescedEmptyBulletExitBeforeSibling({
    source: `${coalescedBulletExitSource}\n${coalescedBulletExitSource}`,
    previous: coalescedBulletExitPrevious,
    next: coalescedBulletExitNext
  }),
  null,
  'RS-86 must reject duplicate authored middle/successor targets'
)
assert.equal(
  preserveCoalescedEmptyBulletExitBeforeSibling({
    source: coalescedBulletExitSource,
    previous: coalescedBulletExitPrevious,
    next: coalescedBulletExitNext.replace('* authored-prefix', '* authored-prefixX')
  }),
  null,
  'RS-86 must reject an unrelated earlier edit'
)
assert.equal(
  preserveCoalescedEmptyBulletExitBeforeSibling({
    source: '```md\n- u高科技\n\n- 12312\n\n- 1\\. 色粉色分\n```\n',
    previous: '```md\n- u高科技\n\n- 12312\n\n- 1\\. 色粉色分\n```\n',
    next: '```md\n- u高科技\n\n- 12312\n\n<br />\n\n* 1\\. 色粉色分\n```\n'
  }),
  null,
  'RS-86 must never claim marker-like rows inside a fenced code block'
)

const emptyExitSource = '# 无序列表测试\n\n色如本人本人\n\n1. 的分布东北\n2. 日本大阪\n3. \n\n\n- 看了呢分\n'
const emptyExitPrevious = '# 无序列表测试\n\n色如本人本人\n\n1. 的分布东北\n2. 日本大阪\n3. <br />\n\n* 看了呢分\n'
const emptyExitNext = '# 无序列表测试\n\n色如本人本人\n\n1. 的分布东北\n2. 日本大阪\n\n<br />\n\n* 看了呢分\n'
const emptyExit = preserveRichMarkdownSource(emptyExitSource, emptyExitPrevious, emptyExitNext)
assert.equal(emptyExit.preserved, true)
assert.equal(emptyExit.reason, 'empty-list-item-removed')
assert.equal(
  emptyExit.markdown,
  '# 无序列表测试\n\n色如本人本人\n\n1. 的分布东北\n2. 日本大阪\n\n- 看了呢分\n',
  'exiting an empty list item must drop the row and collapse surplus blank lines to one empty block'
)

for (const [authored, expectedExit, expectedSibling] of [
  ['- a\n- b', '- a\n\n', '- a\n\n* new\n'],
  ['- a\n- b\n', '- a\n\n', '- a\n\n* new\n'],
  ['- a\r\n- b\r\n', '- a\r\n\r\n', '- a\r\n\r\n* new\r\n']
]) {
  const exited = preserveRichMarkdownSource(
    authored,
    '* a\n\n* b\n\n',
    '* a\n\n<br />\n\n'
  )
  assert.equal(exited.markdown, expectedExit, 'exiting the final list item must retain a distinct block slot')
  const sibling = preserveRichMarkdownSource(
    exited.markdown,
    '* a\n\n<br />\n\n',
    '* a\n\n* new\n\n<br />\n\n'
  )
  assert.equal(sibling.markdown, expectedSibling, 'a later sibling list must not be compacted into the prior list')
}

// The ordered-list input rule fills a middle empty slot. The writer must keep
// the author-visible marker space (`1. `, not a bare `1.`) so the row stays
// visible to the list machinery; the next text fill must then put the typed
// text INSIDE that row instead of misaligning onto a nearby divergent bullet
// block (`- 1. 色粉...`), which the list-slot fingerprint correctly rejects
// (0.13.69 regression: Enter → `1. ` → IME text showed "源码与富文本不一致").
const bareMarkerSource = '啊额绿化\n\n建立；里女；\n\n1\n\n-   1. 二哥你来拿如果\n  - ​     就了解了呢\n  * 如果可能老顾客\n'
const bareMarkerPrev = '啊额绿化\n\n建立；里女；\n\n<br />\n\n1\n\n* <br />\n\n  1. 二哥你来拿如果\n\n* &#x20;    就了解了呢\n\n- 如果可能老顾客\n'
const bareMarkerNext = '啊额绿化\n\n建立；里女；\n\n1. <br />\n\n1\n\n* <br />\n\n  1. 二哥你来拿如果\n\n* &#x20;    就了解了呢\n\n- 如果可能老顾客\n'
const bareMarkerFilled = preserveRichMarkdownSource(bareMarkerSource, bareMarkerPrev, bareMarkerNext)
assert.equal(bareMarkerFilled.preserved, true)
assert.equal(bareMarkerFilled.reason, 'middle-empty-block-list-filled')
assert.equal(
  bareMarkerFilled.markdown,
  '啊额绿化\n\n建立；里女；\n\n1. \n\n1\n\n-   1. 二哥你来拿如果\n  - ​     就了解了呢\n  * 如果可能老顾客\n',
  'the input rule must write the empty ordered item with its marker space, never a bare 1.'
)
const bareMarkerTextNext = '啊额绿化\n\n建立；里女；\n\n1. 色粉嫩绿色负能量\n\n1\n\n* <br />\n\n  1. 二哥你来拿如果\n\n* &#x20;    就了解了呢\n\n- 如果可能老顾客\n'
const bareMarkerTextFilled = preserveRichMarkdownSource(
  bareMarkerFilled.markdown,
  bareMarkerNext,
  bareMarkerTextNext
)
assert.equal(bareMarkerTextFilled.preserved, true)
assert.equal(bareMarkerTextFilled.reason, 'empty-list-item-filled')
assert.equal(
  bareMarkerTextFilled.markdown,
  '啊额绿化\n\n建立；里女；\n\n1. 色粉嫩绿色负能量\n\n1\n\n-   1. 二哥你来拿如果\n  - ​     就了解了呢\n  * 如果可能老顾客\n',
  'filling the empty ordered item must put the text inside the 1. row, never as a new bullet row'
)
assert.doesNotMatch(
  bareMarkerTextFilled.markdown,
  /- 1\. 色粉嫩绿色负能量/,
  'the IME text must never be written as a separate bullet before the divergent block'
)
// A nested bullet followed by Enter is still the same list continuation. The
// canonical changed slice is trimmed before the middle-slot mapper sees it, so
// the new empty sibling can look like a bare `*`; it must inherit the authored
// indentation of the already-mapped previous nested row rather than becoming a
// new top-level bullet (real 0.13.114 trace, 2026-08-25 03:41:15.945Z).
const nestedMiddleEnterSource = [
  '# fixture',
  '',
  '- 阿瑟费说',
  '  * 1\\. 额啊飞啊发',
  '',
  '## after',
  ''
].join('\n')
const nestedMiddleEnterPrevious = [
  '# fixture',
  '',
  '* 阿瑟费说',
  '',
  '  * 1\\. 额啊飞啊发',
  '',
  '## after',
  ''
].join('\n')
const nestedMiddleEnterNext = [
  '# fixture',
  '',
  '* 阿瑟费说',
  '',
  '  * 1\\. 额啊飞啊发',
  '  * <br />',
  '',
  '## after',
  ''
].join('\n')
const nestedMiddleEnter = preserveRichMarkdownSource(
  nestedMiddleEnterSource,
  nestedMiddleEnterPrevious,
  nestedMiddleEnterNext
)
assert.equal(nestedMiddleEnter.preserved, true)
assert.equal(nestedMiddleEnter.reason, 'middle-empty-block-list-filled')
assert.equal(
  nestedMiddleEnter.markdown,
  [
    '# fixture',
    '',
    '- 阿瑟费说',
    '  * 1\\. 额啊飞啊发',
    '  * ',
    '',
    '## after',
    ''
  ].join('\n'),
  'Enter after a nested list item must append an empty sibling at the same authored indentation'
)
assert.doesNotMatch(
  nestedMiddleEnter.markdown,
  /\n\* \n/,
  'the nested empty sibling must never escape to a top-level bullet'
)

// A legacy source that already contains the bare `1.` row (written by an older
// build before the marker-space fix) must still fill in place.
const legacyBareFill = preserveRichMarkdownSource(
  '啊额绿化\n\n建立；里女；\n\n1.\n\n1\n\n-   1. 二哥你来拿如果\n',
  bareMarkerNext,
  bareMarkerTextNext
)
assert.equal(legacyBareFill.preserved, true)
assert.equal(legacyBareFill.reason, 'empty-list-item-filled')
assert.equal(
  legacyBareFill.markdown,
  '啊额绿化\n\n建立；里女；\n\n1. 色粉嫩绿色负能量\n\n1\n\n-   1. 二哥你来拿如果\n',
  'a legacy bare 1. row must also be fillable with its marker space restored'
)

// RS-72 / 0.13.116 PID 60874: Backspace on an empty ordered row is a
// structural compaction, not a text fill. PM can lift the empty paragraph and
// renumber the following row (`2. <br /> / 3. 露娜了` -> indented `<br /> /
// 2. 露娜了`). `empty-list-item-filled` must reject that transaction.
const rs72Previous = [
  '1. 吗。不开机；口红',
  '',
  '2. <br />',
  '',
  '3. 露娜了',
  '',
  '啊额绿化',
  ''
].join('\n')
const rs72Next = [
  '1. 吗。不开机；口红',
  '',
  '   <br />',
  '',
  '2. 露娜了',
  '',
  '啊额绿化',
  ''
].join('\n')
const rs72Change = commonChange(rs72Previous, rs72Next)
const rs72Source = [
  '1. 吗。不开机；口红',
  '',
  '2. ',
  '',
  '3. 露娜了',
  '',
  '啊额绿化',
  ''
].join('\n')
assert.equal(
  preserveEmptyListItemTextChange({
    source: rs72Source,
    previous: rs72Previous,
    next: rs72Next,
    ...rs72Change
  }),
  null,
  'empty-list-item-filled must reject Backspace compaction with successor renumbering'
)
const rs72Public = preserveRichMarkdownSource(rs72Source, rs72Previous, rs72Next)
assert.equal(rs72Public.preserved, true, 'RS-72 structural Backspace must remain source-mappable')
assert.notEqual(rs72Public.reason, 'empty-list-item-filled', 'RS-72 must not be owned by the text-fill mapper')
assert.match(rs72Public.markdown, /2\. 露娜了/, 'RS-72 must retain and renumber the successor row')
assert.doesNotMatch(rs72Public.markdown, /3\. 露娜了/, 'RS-72 must not leave the successor at its stale ordinal')

const duplicateListThenProse = preserveRichMarkdownSource(
  '- target\n',
  '* target\n\n',
  '* target\n\n* target\n\nprose\n'
)
assert.equal(duplicateListThenProse.preserved, true)
assert.equal(
  duplicateListThenProse.markdown,
  '- target\n\n* target\n\nprose\n',
  'a duplicate list row followed by prose must publish the complete transaction or fail closed atomically'
)

// RS-71 / 0.13.115 PID 59363: an unrelated earlier source/canonical
// divergence routes a normal nested ordered Enter through
// `diverged-nested-list-change`. The new sibling must inherit the authored
// indentation of `   1. 微风`; inheriting only its delimiter writes a top-level
// `2. ` and immediately fails strict list-structure integrity.
const divergedNestedOrderedEnterSource = [
  '# 无序列表测试',
  '',
  '- 可就是被科技部',
  '- 老板老板娘',
  '  - s 入了你看你了',
  '',
  '吗；啊嗯',
  '',
  '- 看了呢分',
  '',
  '2. 斛律v哦',
  '',
  '- u高科技',
  '- 1\\. 色粉色分',
  '',
  '1. 啊额法色饭',
  '   1. 微风',
  '',
  '```',
  '尼玛，吗了解',
  '了几百块',
  '```',
  '',
  '1',
  '',
  '-   1. 二哥你来拿如果',
  '  - \u200B     就了解了呢',
  '  * 如果可能老顾客',
  ''
].join('\n')
const divergedNestedOrderedEnterPrevious = [
  '# 无序列表测试',
  '',
  '* 可就是被科技部',
  '',
  '* 老板老板娘',
  '',
  '  * s 入了你看你了',
  '',
  '吗；啊嗯',
  '',
  '* 看了呢分',
  '',
  '2. 斛律v哦',
  '',
  '* u高科技',
  '',
  '* 1\\. 色粉色分',
  '',
  '1. 啊额法色饭',
  '',
  '   1. 微风',
  '',
  '```',
  '尼玛，吗了解',
  '了几百块',
  '```',
  '',
  '1',
  '',
  '* <br />',
  '',
  '  1. 二哥你来拿如果',
  '',
  '* &#x20;    就了解了呢',
  '',
  '- 如果可能老顾客',
  ''
].join('\n')
const divergedNestedOrderedEnterNext = [
  '# 无序列表测试',
  '',
  '* 可就是被科技部',
  '',
  '* 老板老板娘',
  '',
  '  * s 入了你看你了',
  '',
  '吗；啊嗯',
  '',
  '* 看了呢分',
  '',
  '2. 斛律v哦',
  '',
  '* u高科技',
  '',
  '* 1\\. 色粉色分',
  '',
  '1. 啊额法色饭',
  '',
  '   1. 微风、',
  '   2. <br />',
  '',
  '```',
  '尼玛，吗了解',
  '了几百块',
  '```',
  '',
  '1',
  '',
  '* <br />',
  '',
  '  1. 二哥你来拿如果',
  '',
  '* &#x20;    就了解了呢',
  '',
  '- 如果可能老顾客',
  ''
].join('\n')
const divergedNestedOrderedEnter = preserveRichMarkdownSource(
  divergedNestedOrderedEnterSource,
  divergedNestedOrderedEnterPrevious,
  divergedNestedOrderedEnterNext
)
assert.equal(divergedNestedOrderedEnter.preserved, true)
assert.equal(divergedNestedOrderedEnter.reason, 'diverged-nested-list-change')
assert.equal(
  divergedNestedOrderedEnter.markdown,
  [
    '# 无序列表测试',
    '',
    '- 可就是被科技部',
    '- 老板老板娘',
    '  - s 入了你看你了',
    '',
    '吗；啊嗯',
    '',
    '- 看了呢分',
    '',
    '2. 斛律v哦',
    '',
    '- u高科技',
    '- 1\\. 色粉色分',
    '',
    '1. 啊额法色饭',
    '   1. 微风、',
    '   2. ',
    '',
    '',
    '```',
    '尼玛，吗了解',
    '了几百块',
    '```',
    '',
    '1',
    '',
    '-   1. 二哥你来拿如果',
    '  - \u200B     就了解了呢',
    '  * 如果可能老顾客',
    ''
  ].join('\n'),
  'diverged nested ordered Enter must keep the new empty sibling at the authored nested depth'
)
assert.doesNotMatch(
  divergedNestedOrderedEnter.markdown,
  /1\. 啊额法色饭\n   1\. 微风、\n2\. /,
  'diverged nested ordered Enter must never promote the new sibling to top level'
)

// RS-82 / 0.13.127 PID 81568 trace line 13: Backspace at the start
// of the first non-empty bullet after `2. 斛律v哦` joins the complete flat
// bullet segment into the ordered list. The same callback re-spells the next
// independent ordered list from `1.` to `1)`. That delimiter is a required
// separator after the preceding block becomes ordered, so the owner must patch
// the two moved markers plus this unique following marker.
const divergedNonEmptyBulletMergeNext = divergedNestedOrderedEnterPrevious.replace(
  [
    '2. 斛律v哦',
    '',
    '* u高科技',
    '',
    '* 1\\. 色粉色分',
    '',
    '1. 啊额法色饭'
  ].join('\n'),
  [
    '2. 斛律v哦',
    '3. u高科技',
    '4. 1\\. 色粉色分',
    '',
    '1) 啊额法色饭'
  ].join('\n')
)
const divergedNonEmptyBulletMergeExpected = divergedNestedOrderedEnterSource
  .replace(
    '2. 斛律v哦\n\n- u高科技\n- 1\\. 色粉色分',
    '2. 斛律v哦\n\n3. u高科技\n4. 1\\. 色粉色分'
  )
  .replace('1. 啊额法色饭\n   1. 微风', '1) 啊额法色饭\n   1. 微风')
const divergedNonEmptyBulletMerge = preserveRichMarkdownSource(
  divergedNestedOrderedEnterSource,
  divergedNestedOrderedEnterPrevious,
  divergedNonEmptyBulletMergeNext
)
assert.equal(divergedNonEmptyBulletMerge.preserved, true)
assert.equal(
  divergedNonEmptyBulletMerge.reason,
  'diverged-nonempty-bullet-list-backspace-merge-ordered'
)
assert.equal(
  divergedNonEmptyBulletMerge.markdown,
  divergedNonEmptyBulletMergeExpected,
  'non-empty bullet Backspace merge must patch the moved markers and the parse-required following separator only'
)
assert.ok(
  divergedNonEmptyBulletMerge.markdown.includes('1) 啊额法色饭\n   1. 微风'),
  'the following parent delimiter must separate the lists while its nested child spelling stays byte-exact'
)
const divergedNonEmptyBulletMergeCrLf = preserveRichMarkdownSource(
  divergedNestedOrderedEnterSource.replace(/\n/g, '\r\n'),
  divergedNestedOrderedEnterPrevious,
  divergedNonEmptyBulletMergeNext
)
assert.equal(
  divergedNonEmptyBulletMergeCrLf.markdown,
  divergedNonEmptyBulletMergeExpected.replace(/\n/g, '\r\n'),
  'non-empty bullet Backspace merge must preserve authored CRLF outside marker tokens'
)
const divergedNonEmptyBulletMergeBadOrdinal = preserveRichMarkdownSource(
  divergedNestedOrderedEnterSource,
  divergedNestedOrderedEnterPrevious,
  divergedNonEmptyBulletMergeNext.replace('4. 1\\. 色粉色分', '5. 1\\. 色粉色分')
)
assert.equal(
  divergedNonEmptyBulletMergeBadOrdinal.preserved,
  false,
  'non-consecutive ordered output must fail closed instead of being claimed by the merge owner'
)
assert.equal(divergedNonEmptyBulletMergeBadOrdinal.markdown, divergedNestedOrderedEnterSource)
const divergedNonEmptyBulletMergeUnrelatedEdit = preserveRichMarkdownSource(
  divergedNestedOrderedEnterSource,
  divergedNestedOrderedEnterPrevious,
  divergedNonEmptyBulletMergeNext.replace('1) 啊额法色饭', '1) 啊额法色饭X')
)
assert.equal(
  divergedNonEmptyBulletMergeUnrelatedEdit.preserved,
  false,
  'an unrelated body edit in the same callback must fail closed'
)
assert.equal(divergedNonEmptyBulletMergeUnrelatedEdit.markdown, divergedNestedOrderedEnterSource)

// RS-84 / 0.13.128 PID 90936 trace lines 24-29: a selection spanning
// bullet -> ordered -> bullet is deleted in one PM replace and leaves one empty
// bullet before the untouched second bullet item. This must be one atomic raw
// source replacement; applying independent list deletions leaves stale rows and
// makes the immediately following Backspace fail list integrity.
const crossListSelectionDeletePrevious = divergedNestedOrderedEnterPrevious
const crossListSelectionDeleteNext = crossListSelectionDeletePrevious.replace(
  [
    '* 看了呢分',
    '',
    '2. 斛律v哦',
    '',
    '* u高科技',
    '',
    '* 1\\. 色粉色分'
  ].join('\n'),
  [
    '* <br />',
    '',
    '* 1\\. 色粉色分'
  ].join('\n')
)
const crossListSelectionDeleteExpected = divergedNestedOrderedEnterSource.replace(
  '- 看了呢分\n\n2. 斛律v哦\n\n- u高科技\n- 1\\. 色粉色分',
  '- \n- 1\\. 色粉色分'
)
const crossListSelectionDeleteDirect = preserveCrossListSelectionDeleteToEmptyBullet({
  source: divergedNestedOrderedEnterSource,
  previous: crossListSelectionDeletePrevious,
  next: crossListSelectionDeleteNext
})
assert.equal(
  crossListSelectionDeleteDirect?.reason,
  'diverged-cross-list-selection-delete-to-empty-bullet'
)
assert.equal(crossListSelectionDeleteDirect?.markdown, crossListSelectionDeleteExpected)
const crossListSelectionDeletePublic = preserveRichMarkdownSource(
  divergedNestedOrderedEnterSource,
  crossListSelectionDeletePrevious,
  crossListSelectionDeleteNext
)
assert.equal(crossListSelectionDeletePublic.preserved, true)
assert.equal(
  crossListSelectionDeletePublic.reason,
  'diverged-cross-list-selection-delete-to-empty-bullet'
)
assert.equal(crossListSelectionDeletePublic.markdown, crossListSelectionDeleteExpected)
assert.doesNotMatch(crossListSelectionDeletePublic.markdown, /看了呢分|斛律v哦|u高科技/)
assert.match(crossListSelectionDeletePublic.markdown, /吗；啊嗯\n\n- \n- 1\\\. 色粉色分/)
const crossListSelectionDeleteCrLf = preserveRichMarkdownSource(
  divergedNestedOrderedEnterSource.replace(/\n/g, '\r\n'),
  crossListSelectionDeletePrevious,
  crossListSelectionDeleteNext
)
assert.equal(
  crossListSelectionDeleteCrLf.markdown,
  crossListSelectionDeleteExpected.replace(/\n/g, '\r\n'),
  'cross-list selection deletion must preserve authored CRLF and compact surviving bullet spacing'
)
assert.equal(
  preserveCrossListSelectionDeleteToEmptyBullet({
    source: divergedNestedOrderedEnterSource,
    previous: crossListSelectionDeletePrevious,
    next: crossListSelectionDeleteNext.replace('1. 啊额法色饭', '1. 啊额法色饭X')
  }),
  null,
  'cross-list selection owner must reject an unrelated body edit in the same callback'
)
assert.equal(
  preserveCrossListSelectionDeleteToEmptyBullet({
    source: `${divergedNestedOrderedEnterSource}\n${divergedNestedOrderedEnterSource}`,
    previous: crossListSelectionDeletePrevious,
    next: crossListSelectionDeleteNext
  }),
  null,
  'cross-list selection owner must reject duplicate authored targets'
)
assert.equal(
  preserveCrossListSelectionDeleteToEmptyBullet({
    source: divergedNestedOrderedEnterSource,
    previous: crossListSelectionDeletePrevious,
    next: crossListSelectionDeleteNext.replace('* <br />', '* replacement')
  }),
  null,
  'cross-list selection owner must reject a non-empty replacement row'
)

// The immediately following Backspace lifts the new empty first bullet item
// into a top-level empty paragraph. `empty-list-item-removed` should delete the
// row, but the blank line before that row predates the selection and separates
// the left paragraph from the surviving bullet list. Keep that authored block
// gap instead of collapsing `正文\n\n- surviving` to `正文\n- surviving`.
const crossListSelectionSecondNext = crossListSelectionDeleteNext.replace(
  '* <br />\n\n* 1\\. 色粉色分',
  '<br />\n\n* 1\\. 色粉色分'
)
const crossListSelectionSecondExpected = crossListSelectionDeleteExpected.replace(
  '- \n- 1\\. 色粉色分',
  '- 1\\. 色粉色分'
)
const crossListSelectionSecond = preserveRichMarkdownSource(
  crossListSelectionDeleteExpected,
  crossListSelectionDeleteNext,
  crossListSelectionSecondNext
)
assert.equal(crossListSelectionSecond.preserved, true)
assert.equal(crossListSelectionSecond.reason, 'empty-list-item-removed')
assert.equal(
  crossListSelectionSecond.markdown,
  crossListSelectionSecondExpected,
  'the second Backspace must retain the authored paragraph-to-list blank line'
)
assert.match(crossListSelectionSecond.markdown, /吗；啊嗯\n\n- 1\\\. 色粉色分/)
const crossListSelectionSecondCrLf = preserveRichMarkdownSource(
  crossListSelectionDeleteExpected.replace(/\n/g, '\r\n'),
  crossListSelectionDeleteNext,
  crossListSelectionSecondNext
)
assert.equal(
  crossListSelectionSecondCrLf.markdown,
  crossListSelectionSecondExpected.replace(/\n/g, '\r\n'),
  'the second Backspace must retain the authored CRLF block gap'
)

const divergedConsecutiveInsertions = preserveRichMarkdownSource(
  '- 1. A\n- B\n',
  '* <br />\n\n  1. A\n\n* B\n\n',
  '* <br />\n\n  1. A\n  2. X\n  3. Y\n\n* B\n\n'
)
assert.equal(
  divergedConsecutiveInsertions.markdown,
  '- 1. A\n  2. X\n  3. Y\n- B\n',
  'multiple inserted nested siblings in one callback must stay inside the same authored outer bullet and retain their canonical order'
)

const divergedConsecutiveParenInsertions = preserveRichMarkdownSource(
  '-   1) A\n- B\n',
  '* <br />\n\n  1. A\n\n* B\n\n',
  '* <br />\n\n  1. A\n  2. X\n  3. Y\n\n* B\n\n'
)
assert.equal(
  divergedConsecutiveParenInsertions.markdown,
  '-   1) A\n    2) X\n    3) Y\n- B\n',
  'nested siblings must inherit the authored outer content column and ordered delimiter across a batched insertion'
)

const divergedOnlyRowLift = preserveRichMarkdownSource(
  '- 1. A\n',
  '* <br />\n\n  1. A\n\n',
  'A\n'
)
assert.equal(
  divergedOnlyRowLift.markdown,
  'A\n',
  'fully lifting the first and only diverged row must remove its authored list prefixes'
)

const divergedOnlyRowLiftBeforeParagraph = preserveRichMarkdownSource(
  '- 1. A\n\nparagraph\n',
  '* <br />\n\n  1. A\n\nparagraph\n',
  'A\n\nparagraph\n'
)
assert.equal(
  divergedOnlyRowLiftBeforeParagraph.markdown,
  'A\n\nparagraph\n',
  'lifting an only item before a paragraph must not duplicate the separator newline'
)

const divergedFirstRowLift = preserveRichMarkdownSource(
  '- 1. A\n- 2. B\n',
  '* <br />\n\n  1. A\n\n* <br />\n\n  2. B\n\n',
  'A\n\n* <br />\n\n  2. B\n\n'
)
assert.equal(
  divergedFirstRowLift.markdown,
  'A\n\n- 2. B\n',
  'fully lifting the first diverged row must keep the remaining authored list intact'
)

// Canonical block enumeration contains one outer list tree PLUS one block for
// every nested ordered row. Authored source has only the outer tree. A later,
// unrelated list must therefore be matched by top-level block ordinal; counting
// nested blocks makes this edit incorrectly target a non-existent source block.
const laterListSource = [
  '## 目录',
  '',
  '- 1. 管理层',
  '- 2. 综合行政部',
  '',
  '## 使用说明',
  '',
  '- 适用标准：**ISO 9001:2015**。',
  ''
].join('\n')
const laterListCanonical = [
  '## 目录',
  '',
  '* <br />',
  '',
  '  1. 管理层',
  '',
  '* <br />',
  '',
  '  2. 综合行政部',
  '',
  '## 使用说明',
  '',
  '* 适用标准：**ISO 9001:2015**。',
  ''
].join('\n')
const laterFormattedListEdit = preserveRichMarkdownSource(
  laterListSource,
  laterListCanonical,
  laterListCanonical.replace('适用标准：', '适用标准X：')
)
assert.equal(laterFormattedListEdit.reason, 'diverged-nested-list-change')
assert.equal(
  laterFormattedListEdit.markdown,
  laterListSource.replace('适用标准：', '适用标准X：'),
  'nested canonical blocks must not shift the authored counterpart of a later top-level list'
)

// A deletion spanning SEVERAL canonical blocks (here: the 复核。 item and the
// whole trailing `- ce` item) used to fail every localized mapper in a
// diverged document and roll back to the OLD source — the deletion vanished,
// saving resurrected the content. The canonical is the real Crepe
// serialization captured from the app for this edit.
const tailDeleteSource = [
  '- 1. 甲乙',
  '',
  '- 本表为 AI 生成草稿，正式发布前需经体系负责人 / 质量部门复核。',
  '- ce'
].join('\n') + '\n'
const tailDeletePrevious = [
  '* <br />',
  '',
  '  1. 甲',
  '  2. 乙',
  '',
  '* 本表为 AI 生成草稿，正式发布前需经体系负责人 / 质量部门复核。',
  '',
  '* ce',
  ''
].join('\n')
const tailDeleteNext = [
  '* <br />',
  '',
  '  1. 甲',
  '  2. 乙',
  '',
  '* 本表为 AI 生成草稿，正式发布前需经体系负责人 / 质量部门',
  ''
].join('\n')
const tailDeleted = preserveRichMarkdownSource(
  tailDeleteSource,
  tailDeletePrevious,
  tailDeleteNext
)
assert.equal(
  tailDeleted.reason,
  'diverged-nested-list-change',
  'a multi-block deletion in a diverged document must map through item-sequence alignment'
)
assert.equal(
  tailDeleted.markdown,
  [
    '- 1. 甲乙',
    '',
    '- 本表为 AI 生成草稿，正式发布前需经体系负责人 / 质量部门',
    ''
  ].join('\n'),
  'the deleted rows must vanish while the authored marker spelling survives'
)

// Clearing a quote's text first leaves an authored empty quote line (`>`).
// Pressing Backspace again removes the blockquote node itself. Both source and
// canonical have the same visible stream, so a visible-text mapper sees a
// zero-width change; the syntax-only `>` row still has to be removed or save
// and reopen resurrect the deleted quote.
const removedEmptyQuote = preserveRichMarkdownSource(
  'before\n\n>\n\nafter\n',
  'before\n\n> <br />\n\nafter\n',
  'before\n\nafter\n'
)
assert.equal(
  removedEmptyQuote.markdown,
  'before\n\nafter\n',
  'removing an empty blockquote must remove its syntax-only authored `>` row'
)
assert.equal(
  removedEmptyQuote.reason,
  'empty-blockquote-removed',
  'empty blockquote deletion must use the dedicated syntax-only mapping path'
)

const divergedQuoteSource = [
  '前文。* **输入设备：** 内容足够长，使分叉点远离后面的引用边界。',
  '',
  'before',
  '',
  '>',
  '',
  'after',
  ''
].join('\n')
const divergedQuotePrevious = divergedQuoteSource
  .replace('。* ', '。\\* ')
  .replace('\n>\n', '\n> <br />\n')
const divergedQuoteNext = divergedQuotePrevious.replace('\n> <br />\n\n', '\n')
const removedDivergedEmptyQuote = preserveRichMarkdownSource(
  divergedQuoteSource,
  divergedQuotePrevious,
  divergedQuoteNext
)
assert.equal(
  removedDivergedEmptyQuote.markdown,
  divergedQuoteSource.replace('\nbefore\n\n>\n\nafter\n', '\nbefore\n\nafter\n'),
  'empty quote removal must use local anchors even when source and canonical diverge elsewhere'
)

const appendedAfterDivergedQuote = preserveRichMarkdownSource(
  '- - nested\n\n> same\n>\n> same\n',
  '* <br />\n\n  * nested\n\n> same\n>\n> same\n\n',
  '* <br />\n\n  * nested\n\n> same\n>\n> same\n\ntail\n'
)
assert.equal(
  appendedAfterDivergedQuote.markdown,
  '- - nested\n\n> same\n>\n> same\n\ntail\n',
  'typing into the trailing empty paragraph after a quote must append at the document end even when earlier visible streams diverge'
)
assert.equal(
  ['appended-paragraph', 'diverged-tail-block-append'].includes(appendedAfterDivergedQuote.reason),
  true,
  `tail append after a diverged quote must be owned by an append mapper, got ${appendedAfterDivergedQuote.reason}`
)

const removedOneOfTwoEmptyQuotes = preserveRichMarkdownSource(
  '# 标题\n\n>\n\n>\n\n## 后文\n',
  '# 标题\n\n> <br />\n\n> <br />\n\n## 后文\n',
  '# 标题\n\n> <br />\n\n## 后文\n'
)
assert.equal(
  removedOneOfTwoEmptyQuotes.markdown,
  '# 标题\n\n>\n\n## 后文\n',
  'removing one of consecutive empty quotes must retain exactly one authored quote row'
)
assert.equal(
  removedOneOfTwoEmptyQuotes.reason,
  'empty-blockquote-removed',
  'consecutive empty quotes must use the same syntax-only quote mapping path'
)

// A serializer escape near the beginning can permanently shift the canonical
// visible stream. A later, uniquely anchored one-line edit must still update
// only its authored source range rather than falling back to stale bytes.
const uniqueAnchorPadding =
  '这是足够长的中间内容，用于隔离前面的可见流分叉并保持局部上下文一致。'.repeat(2)
const uniqueAnchorSource =
  `前文。* **输入设备：** ${uniqueAnchorPadding}\n\n尾部原文\n`
const uniqueAnchorPrevious =
  `前文。\\* **输入设备：** ${uniqueAnchorPadding}\n\n尾部原文\n`
const uniqueAnchorNext =
  `前文。\\* **输入设备：** ${uniqueAnchorPadding}\n\n尾部原文新增\n`
const uniqueAnchorChange = commonChange(uniqueAnchorPrevious, uniqueAnchorNext)
const uniquelyAnchoredText = preserveUniquelyAnchoredTextChange({
  source: uniqueAnchorSource,
  previous: uniqueAnchorPrevious,
  next: uniqueAnchorNext,
  ...uniqueAnchorChange
})
assert.equal(
  uniquelyAnchoredText?.markdown,
  uniqueAnchorSource.replace('尾部原文', '尾部原文新增'),
  'a unique later text edit must survive an earlier source/canonical visible-stream divergence'
)
assert.equal(
  uniquelyAnchoredText?.reason,
  'uniquely-anchored-text-change',
  'the divergent one-line edit must be proven by its unique local visible context'
)

const typedLiteralNumberInOrderedItem = preserveRichMarkdownSource(
  '1. 第一\n2. 第二\n3. \n',
  '1. 第一\n2. 第二\n3. <br />\n',
  '1. 第一\n2. 第二\n3. 2\\. 测试\n'
)
assert.equal(
  typedLiteralNumberInOrderedItem.markdown,
  '1. 第一\n2. 第二\n3. 2. 测试\n',
  'literal numbering typed inside an ordered item must not gain a serializer backslash'
)

const mixedListLiteralNumberEdit = preserveRichMarkdownSource(
  '1. 第一项\n2. 有序占位\n\n- 普通项\n- 无序占位\n',
  '1. 第一项\n2. 有序占位\n\n* 普通项\n\n* 无序占位\n',
  '1. 第一项\n2. 2\\. 测试\n\n* 普通项\n\n* 无序占位\n\n'
)
assert.equal(
  mixedListLiteralNumberEdit.markdown,
  '1. 第一项\n2. 2. 测试\n\n- 普通项\n- 无序占位\n',
  'editing one ordered row must not escape its literal number or normalize a later bullet list'
)

const typedLiteralNumberInBulletItem = preserveRichMarkdownSource(
  '- 第一\n- \n',
  '* 第一\n* <br />\n',
  '* 第一\n* 1\\. 测试\n'
)
assert.equal(
  typedLiteralNumberInBulletItem.markdown,
  '- 第一\n- 1. 测试\n',
  'literal numbering typed inside a bullet item must not gain a serializer backslash'
)

const authoredEscapedNumberStillPreserved = preserveRichMarkdownSource(
  '- 2\\. 作者原文\n',
  '* 2\\. 作者原文\n',
  '* 2\\. 作者原文新增\n'
)
assert.equal(
  authoredEscapedNumberStillPreserved.markdown,
  '- 2\\. 作者原文新增\n',
  'an existing authored number escape must remain when later text is edited'
)

const literalListMarkersInsideItems = preserveRichMarkdownSource(
  [
    '1. 有序短横占位',
    '2. 有序加号占位',
    '3. 有序星号占位',
    '4. 有序括号占位',
    '',
    '- 无序短横占位',
    '- 无序加号占位',
    '- 无序星号占位',
    '- 无序括号占位',
    ''
  ].join('\n'),
  [
    '1. 有序短横占位',
    '2. 有序加号占位',
    '3. 有序星号占位',
    '4. 有序括号占位',
    '',
    '* 无序短横占位',
    '',
    '* 无序加号占位',
    '',
    '* 无序星号占位',
    '',
    '* 无序括号占位',
    ''
  ].join('\n'),
  [
    '1. \\- 测试',
    '2. \\+ 测试',
    '3. \\* 测试',
    '4. 2\\) 测试',
    '',
    '* \\- 测试',
    '',
    '* \\+ 测试',
    '',
    '* \\* 测试',
    '',
    '* 1\\) 测试',
    ''
  ].join('\n')
)
assert.equal(
  literalListMarkersInsideItems.markdown,
  [
    '1. - 测试',
    '2. + 测试',
    '3. * 测试',
    '4. 2) 测试',
    '',
    '- - 测试',
    '- + 测试',
    '- * 测试',
    '- 1) 测试',
    ''
  ].join('\n'),
  'all list-marker-shaped item text must lose only serializer-owned backslashes'
)

const laterLiteralMarkerEdit = preserveRichMarkdownSource(
  '- - 测试\n',
  '* \\- 测试\n',
  '* \\- 测试新增\n'
)
assert.equal(
  laterLiteralMarkerEdit.markdown,
  '- - 测试新增\n',
  'a later edit must not reintroduce the canonical backslash removed on the first edit'
)

const authoredEscapedMarkerStillPreserved = preserveRichMarkdownSource(
  '- \\- 作者原文\n',
  '* \\- 作者原文\n',
  '* \\- 作者原文新增\n'
)
assert.equal(
  authoredEscapedMarkerStillPreserved.markdown,
  '- \\- 作者原文新增\n',
  'an authored list-marker escape must remain when later text is edited'
)

const filledEmptyWithRawBacktick = preserveRichMarkdownSource(
  'before\n\n\nafter\n',
  'before\n\n<br />\n\nafter\n',
  'before\n\n\\`\n\nafter\n'
)
assert.equal(
  filledEmptyWithRawBacktick.markdown,
  'before\n\n`\n\nafter\n',
  'a newly typed unmatched backtick must keep the raw character the user entered'
)

const editedAfterCanonicalEmptyRows = preserveRichMarkdownSource(
  '# heading\n\n\n\nplaceholder\n\nafter\n',
  '# heading\n\n<br />\n\nplaceholder\n\nafter\n',
  '# heading\n\n<br />\n\nchanged\n\nafter\n'
)
assert.equal(
  editedAfterCanonicalEmptyRows.markdown,
  '# heading\n\n\n\nchanged\n\nafter\n',
  'an empty rich paragraph before the edited row must not map the edit onto the heading boundary'
)

const typedRawBacktickAfterCanonicalEmptyRows = preserveRichMarkdownSource(
  '# heading\n\n\n\nplaceholder\n\nafter\n',
  '# heading\n\n<br />\n\nplaceholder\n\nafter\n',
  '# heading\n\n<br />\n\n\\`\n\nafter\n'
)
assert.equal(
  typedRawBacktickAfterCanonicalEmptyRows.markdown,
  '# heading\n\n\n\n`\n\nafter\n',
  'fresh escaped punctuation after an empty rich paragraph must map by row and keep raw source spelling'
)

const replacedTextWithRawBacktick = preserveRichMarkdownSource(
  'before\n\nplaceholder\n\nafter\n',
  'before\n\nplaceholder\n\nafter\n',
  'before\n\n\\`\n\nafter\n'
)
assert.equal(
  replacedTextWithRawBacktick.markdown,
  'before\n\n`\n\nafter\n',
  'replacing a normal line with one raw backtick must not leak serializer escaping'
)

const deletedRawBacktickLine = preserveRichMarkdownSource(
  'before\n\n`\n\nafter\n',
  'before\n\n\\`\n\nafter\n',
  'before\n\n<br />\n\nafter\n'
)
assert.equal(
  deletedRawBacktickLine.markdown,
  'before\n\n\n\nafter\n',
  'deleting an unmatched raw backtick must not fail closed or resurrect it'
)
assert.equal(deletedRawBacktickLine.reason, 'escaped-literal-line-emptied')

const partiallyDeletedRawBacktickLine = preserveRichMarkdownSource(
  'before\n\n```\n\nafter\n',
  'before\n\n\\`\\`\\`\n\nafter\n',
  'before\n\n\\`\n\nafter\n'
)
assert.equal(
  partiallyDeletedRawBacktickLine.markdown,
  'before\n\n`\n\nafter\n',
  'deleting two of three unmatched backticks must retain the remaining raw backtick'
)
assert.equal(partiallyDeletedRawBacktickLine.reason, 'escaped-literal-line-changed')

const changedSecondRepeatedRawBacktickLine = preserveRichMarkdownSource(
  'before\n\n`\n\n`\n\nafter\n',
  'before\n\n\\`\n\n\\`\n\nafter\n',
  'before\n\n\\`\n\n\\`\\`\n\nafter\n'
)
assert.equal(
  changedSecondRepeatedRawBacktickLine.markdown,
  'before\n\n`\n\n``\n\nafter\n',
  'repeated punctuation-only rows must map by row identity rather than global text uniqueness'
)

const replacedSecondRepeatedRawBacktickLine = preserveRichMarkdownSource(
  'before\n\n`\n\n`\n\nafter\n',
  'before\n\n\\`\n\n\\`\n\nafter\n',
  'before\n\n\\`\n\n删除围栏后继续写作\n\nafter\n'
)
assert.equal(
  replacedSecondRepeatedRawBacktickLine.markdown,
  'before\n\n`\n\n删除围栏后继续写作\n\nafter\n',
  'replacing the second repeated raw backtick row with normal text must not lock later source sync'
)

const filledEmptyWithRawTripleBacktick = preserveRichMarkdownSource(
  'before\n\n\nafter\n',
  'before\n\n<br />\n\nafter\n',
  'before\n\n\\`\\`\\`\n\nafter\n'
)
assert.equal(
  filledEmptyWithRawTripleBacktick.markdown,
  'before\n\n```\n\nafter\n',
  'literal triple backticks retained by the editor must remain exactly user-typed source'
)

const exactBaselineKeepsUntouchedAuthoredEscape = preserveRichMarkdownSource(
  'authored \\* stays\n\nplaceholder\n',
  'authored \\* stays\n\nplaceholder\n',
  'authored \\* stays\n\nchanged\n'
)
assert.equal(
  exactBaselineKeepsUntouchedAuthoredEscape.markdown,
  'authored \\* stays\n\nchanged\n',
  'fresh escape restoration must remain local and leave untouched authored escapes byte-exact'
)

// Deeply diverged document, final line spelled with a different backtick run
// in source than in canonical: appending text at the document end must
// continue the authored final line instead of failing closed.
const divergedTailInlineAppend = preserveRichMarkdownSource(
  '# 测试\n\n1\n```ces```\n',
  '# 测试\n\n1\n`ces`\n',
  '# 测试\n\n1\n`ces`末段新增验证\n'
)
assert.equal(
  divergedTailInlineAppend.markdown,
  '# 测试\n\n1\n```ces```末段新增验证\n',
  'tail append on a diverged inline-code row must continue the authored final line'
)
assert.equal(divergedTailInlineAppend.reason, 'diverged-tail-block-append')

// RS-61: a punctuation-only tail paragraph can lose a serializer protection
// escape without being deleted. Visible-line extraction treats `-[ ] ` as
// empty, so the diverged-tail delete mapper must inspect the raw tail before
// deciding that the previous row disappeared.
const literalBracketTailSpace = preserveRichMarkdownSource(
  '# t\n\n- earlier\n1. item\n\n-\\[ ]\n',
  '# t\n\n* earlier\n\n1. item\n\n-\\[ ]\n\n',
  '# t\n\n* earlier\n\n1. item\n\n-[ ] \n\n'
)
assert.equal(literalBracketTailSpace.preserved, true)
assert.equal(
  literalBracketTailSpace.markdown,
  '# t\n\n- earlier\n1. item\n\n-[ ] \n',
  'a raw punctuation-only tail row must survive serializer escape removal instead of being mistaken for a deleted line'
)
assert.notEqual(
  literalBracketTailSpace.reason,
  'diverged-tail-line-delete',
  'RS-61 must fall through to a line edit mapper rather than delete the tail row'
)

// RS-62: once that punctuation-only tail row exists, editing inside it is an
// in-place line change, not a fresh block append. The visible tail anchor still
// points at the preceding visible row, so raw slot identity must veto append.
const literalBracketTailInnerBackspace = preserveRichMarkdownSource(
  '# t\n\n- earlier\n\n1. item\n\n-[ ] \n',
  '# t\n\n* earlier\n\n1. item\n\n-[ ] \n',
  '# t\n\n* earlier\n\n1. item\n\n-[] \n'
)
assert.equal(literalBracketTailInnerBackspace.preserved, true)
assert.equal(
  literalBracketTailInnerBackspace.markdown,
  '# t\n\n- earlier\n\n1. item\n\n-[] \n',
  'editing inside a punctuation-only raw tail row must replace that row in place rather than append a duplicate'
)
assert.notEqual(
  literalBracketTailInnerBackspace.reason,
  'diverged-tail-block-append',
  'RS-62 must fall through to an in-place line mapper rather than append the edited raw tail row'
)

const divergedTailRejectsDifferentSourceLine = preserveRichMarkdownSource(
  'A\n\n```x```\n',
  'A\n\ny\n',
  'A\n\nyZ\n'
)
assert.equal(
  divergedTailRejectsDifferentSourceLine.preserved,
  false,
  'tail-line append must refuse when the authored final line has different inline text'
)

const {
  preserveDivergedTailBlockAppend
} = await import('../src/renderer/src/lib/markdown-preservation/regions.js')
assert.equal(
  preserveDivergedTailBlockAppend({
    source: 'A\n\n```x```\n\nB\n',
    previous: 'A\n\nx\n\nB\n',
    next: 'A\n\nxZ\n\nB\n',
    nextEnd: 'A\n\nxZ\n\nB\n'.length
  }),
  null,
  'tail-line append must refuse when the edit is not on the final line'
)

// Input-rule merge on the final authored line (`2` + typed `1. …` folds into
// `21. …`): the authored line becomes the first list row and the remaining
// canonical rows are appended verbatim.
const mergedTail = preserveDivergedTailBlockAppend({
  source: 'A\n\nB\n\n2\n',
  previous: 'A\n\nB\n\n2\n',
  next: 'A\n\nB\n\n21. 序列验证X\n22. 有序二\n',
  start: commonChange('A\n\nB\n\n2\n', 'A\n\nB\n\n21. 序列验证X\n22. 有序二\n').start,
  nextEnd: 'A\n\nB\n\n21. 序列验证X\n22. 有序二\n'.length - 1
})
assert.equal(
  mergedTail?.markdown,
  'A\n\nB\n\n21. 序列验证X\n22. 有序二\n',
  'input-rule merge on the final authored line must fold into the first list row'
)
assert.equal(mergedTail?.reason, 'diverged-tail-block-append')

// Diverged-tail append must unescape the serializer's `&#x20;` spelling for
// item-leading spaces; leaking the entity corrupts authored source.
const tailAppendUnescapesSpaceEntities = preserveRichMarkdownSource(
  'A\n\n1. 测试\n',
  'A\n\n1. 测试\n',
  'A\n\n1. 测试\n\n2. &#x20;   新内容\n'
)
assert.equal(
  tailAppendUnescapesSpaceEntities?.markdown,
  'A\n\n1. 测试\n2. \u200B    新内容\n',
  'diverged-tail append must unescape &#x20; item-leading spaces'
)

// A second edit cycle can exit an ordered list into an empty trailing
// paragraph, then create a sibling bullet list before markdownUpdated runs.
// Crepe's terminal `<br />` is not authored content and must not make the
// structural tail mapper reject the real bullet block. Rejecting it lets the
// generic visible mapper splice `* item` before the last source newline and
// corrupt the file as `3. previous* item`.
const siblingListAfterTrailingPlaceholder = preserveRichMarkdownSource(
  '1. 第一项\n2. 第二项\n3. 第三项\n',
  '1. 第一项\n2. 第二项\n3. 第三项\n\n<br />\n\n',
  '1. 第一项\n2. 第二项\n3. 第三项\n\n* 新无序项\n\n<br />\n\n'
)
assert.equal(
  siblingListAfterTrailingPlaceholder.markdown,
  '1. 第一项\n2. 第二项\n3. 第三项\n\n* 新无序项\n',
  'terminal empty-paragraph placeholder must not glue a sibling list onto the previous item'
)
assert.equal(
  siblingListAfterTrailingPlaceholder.reason,
  'diverged-tail-block-append',
  'a sibling structural block must stay on the dedicated tail mapper'
)

const multilineLocalFallback = preserveLocallyAlignedTextChange({
  source: '1. 第一项\n2. 第二项\n3. 第三项\n',
  previous: '1. 第一项\n2. 第二项\n3. 第三项\n\n<br />\n\n',
  next: '1. 第一项\n2. 第二项\n3. 第三项\n\n* 新无序项\n\n<br />\n\n',
  ...commonChange(
    '1. 第一项\n2. 第二项\n3. 第三项\n\n<br />\n\n',
    '1. 第一项\n2. 第二项\n3. 第三项\n\n* 新无序项\n\n<br />\n\n'
  )
})
assert.equal(
  multilineLocalFallback,
  null,
  'generic visible-text fallback must never own a multiline structural insertion'
)

// Pressing Enter twice under a bullet list creates an empty item (first
// Enter) and then lifts it out into a standalone paragraph (second Enter).
// Crepe serializes the lifted row as `<br />` and re-serializes the surviving
// sibling (`- 露娜了`) with its normalized `*` marker, so the change span
// leaks the sibling's canonical marker. The mapper must delete ONLY the empty
// authored row and keep the sibling row plus its blank separator byte-for-byte.
const bulletExitKeepsSibling = preserveRichMarkdownSource(
  '前文\n\n- 是v的；发布\n- \n\n- 露娜了\n\n后文\n',
  '前文\n\n* 是v的；发布\n* <br />\n\n- 露娜了\n\n后文\n',
  '前文\n\n* 是v的；发布\n\n<br />\n\n* 露娜了\n\n后文\n'
)
assert.equal(
  bulletExitKeepsSibling?.markdown,
  '前文\n\n- 是v的；发布\n\n- 露娜了\n\n后文\n',
  'exiting an empty bullet item must remove only that row and keep the following sibling list'
)
assert.equal(
  bulletExitKeepsSibling?.reason,
  'empty-list-item-removed',
  'the bullet exit transaction belongs to the empty-list-item-removed branch'
)

// Same exit, but at the list tail (no sibling after the blank line): the
// empty `- ` row is removed and the separator before the next block survives.
const bulletTailExitKeepsSeparator = preserveRichMarkdownSource(
  '前文\n\n- 内容\n- \n\n后文\n',
  '前文\n\n* 内容\n* <br />\n\n后文\n',
  '前文\n\n* 内容\n\n<br />\n\n后文\n'
)
assert.equal(
  bulletTailExitKeepsSeparator?.markdown,
  '前文\n\n- 内容\n\n后文\n',
  'exiting an empty bullet item at the list tail keeps the blank separator'
)
assert.equal(
  bulletTailExitKeepsSeparator?.reason,
  'empty-list-item-removed',
  'the tail bullet exit must not fall into paragraph-emptied'
)

// RS-56: before normalizeEmptyListItems strips indentation from the standalone
// `<br />`, the raw canonical proves that a deepest nested list row disappeared
// and its empty paragraph was lifted into the parent nested item. Preserve the
// raw row deletion with a distinct reason so generated scratch can use the
// existing narrow semantic transient without arming the top-level post-list token.
const nestedTailBackspaceRemoval = preserveRichMarkdownSource(
  '# RS56\n\n* outer\n  * inner\n    - 我\n',
  '# RS56\n\n* outer\n\n  * inner\n\n    * 我\n\n',
  '# RS56\n\n* outer\n\n  * inner\n\n    <br />\n\n'
)
assert.equal(
  nestedTailBackspaceRemoval?.markdown,
  '# RS56\n\n* outer\n  * inner\n',
  'nested tail Backspace must remove only the deepest authored list row'
)
assert.equal(
  nestedTailBackspaceRemoval?.reason,
  'nested-empty-list-item-removed',
  'nested tail Backspace must retain its dedicated transient ownership reason'
)

// Exiting an empty ORDERED item can re-serialize a FOLLOWING ordered list's
// markers with a different delimiter (`1)` -> `1.`) in the same transaction.
// That serializer-only flip must not inflate the change span: the mapper has
// to delete only the empty `2. ` row and keep the following ordered list (and
// its authored `2)` spelling) byte-for-byte. Otherwise the empty-list-fill
// mapper replaces the whole merged block and the following list disappears
// (source-list-structure-mismatch toast).
const orderedExitKeepsFollowingDelimiter = preserveRichMarkdownSource(
  [
    '前文', '',
    '1. 三个人过',
    '2. ', '',
    '', '',
    '1. 斯卡洛尼快乐',
    '2) 是干嘛的了；吗', '',
    '后文', ''
  ].join('\n'),
  [
    '前文', '',
    '1. 三个人过',
    '2. <br />', '',
    '1) 斯卡洛尼快乐',
    '2) 是干嘛的了；吗', '',
    '后文', ''
  ].join('\n'),
  [
    '前文', '',
    '1. 三个人过', '',
    '<br />', '',
    '1. 斯卡洛尼快乐',
    '2. 是干嘛的了；吗', '',
    '后文', ''
  ].join('\n')
)
assert.equal(
  orderedExitKeepsFollowingDelimiter?.reason,
  'empty-list-item-removed',
  'the ordered exit transaction must belong to the empty-list-item-removed branch'
)
assert.equal(
  orderedExitKeepsFollowingDelimiter?.markdown,
  [
    '前文', '',
    '1. 三个人过', '',
    '1. 斯卡洛尼快乐',
    '2) 是干嘛的了；吗', '',
    '后文', ''
  ].join('\n'),
  'exiting an empty ordered item must keep the following ordered list and its authored delimiter'
)

// Two Enter presses can land in one markdownUpdated callback: the first creates
// an empty nested ordered item and the second lifts it to a new outer bullet.
// This authored block is already structurally diverged (`-   1.` becomes an
// empty canonical wrapper + nested `1.`), and an unchanged following sibling
// owns a real leading space stored with the U+200B sentinel. The nested-list
// mapper must compare that sibling in source spelling so the zero-visible new
// outer item can be inserted instead of failing with visible-stream-mismatch.
const fastNestedExitSource = [
  '前文', '',
  '-   1. 二哥你来拿如果',
  '  - \u200B     就了解了呢',
  '  * 如果可能老顾客', '',
  '后文', ''
].join('\n')
const fastNestedExitPrevious = [
  '前文', '',
  '* <br />', '',
  '  1. 二哥你来拿如果', '',
  '* &#x20;    就了解了呢', '',
  '- 如果可能老顾客', '',
  '后文', ''
].join('\n')
const fastNestedExitNext = [
  '前文', '',
  '* <br />', '',
  '  1. 二哥你来拿如果', '',
  '* <br />', '',
  '* &#x20;    就了解了呢', '',
  '- 如果可能老顾客', '',
  '后文', ''
].join('\n')
const fastNestedExit = preserveRichMarkdownSource(
  fastNestedExitSource,
  fastNestedExitPrevious,
  fastNestedExitNext
)
assert.equal(fastNestedExit?.preserved, true)
assert.equal(fastNestedExit?.reason, 'diverged-nested-list-change')
assert.equal(
  fastNestedExit?.markdown,
  [
    '前文', '',
    '-   1. 二哥你来拿如果',
    '- ',
    '- \u200B     就了解了呢',
    '* 如果可能老顾客', '',
    '后文', ''
  ].join('\n'),
  'batched nested-list exit must insert the new outer empty item and promote unchanged canonical siblings without changing their marker/content bytes'
)

// A code block is a structural owner, even when an earlier list marker has
// already made the authored source spelling differ from canonical. The first
// committed characters in an empty middle fence must replace only the fence's
// content region; the generic middle-paragraph mapper must not insert them
// before the opening fence.
const middleCodeSource = [
  '# code block ownership',
  '',
  '- authored bullet',
  '',
  '1. surrounding text',
  '',
  '```',
  '',
  '```',
  '',
  '- following bullet',
  ''
].join(String.fromCharCode(10))
const middleCodePrevious = [
  '# code block ownership',
  '',
  '* authored bullet',
  '',
  '1. surrounding text',
  '',
  '```',
  '',
  '```',
  '',
  '* following bullet',
  ''
].join(String.fromCharCode(10))
const middleCodeNext = middleCodePrevious.replace(
  ['```', '', '```'].join(String.fromCharCode(10)),
  ['```', 'surge', '```'].join(String.fromCharCode(10))
)
const middleCodeResult = preserveRichMarkdownSource(
  middleCodeSource,
  middleCodePrevious,
  middleCodeNext
)
assert.equal(
  middleCodeResult?.markdown,
  middleCodeSource.replace(
    ['```', '', '```'].join(String.fromCharCode(10)),
    ['```', 'surge', '```'].join(String.fromCharCode(10))
  ),
  'first code-block content must stay between the authored fence boundaries'
)
assert.equal(
  middleCodeResult?.reason,
  'fenced-code-block-content-change',
  'code-block content must be handled by its structural owner'
)

// Display math uses paired `$$` rows rather than backtick/tilde fences, but is
// the same PM code_block family. The first character and every later edit must
// replace the exact content region without inventing a blank row before `$$`.
const middleMathSource = [
  '# math block ownership',
  '',
  '- authored bullet',
  '',
  '1. surrounding text',
  '',
  '$$',
  '$$',
  '',
  '- following bullet',
  ''
].join('\r\n')
const middleMathPrevious = [
  '# math block ownership',
  '',
  '* authored bullet',
  '',
  '1. surrounding text',
  '',
  '$$',
  '$$',
  '',
  '* following bullet',
  ''
].join('\n')
const middleMathNext = middleMathPrevious.replace(
  '$$\n$$',
  () => '$$\nfence-token\n$$'
)
const middleMathResult = preserveRichMarkdownSource(
  middleMathSource,
  middleMathPrevious,
  middleMathNext
)
assert.equal(middleMathResult?.preserved, true)
assert.equal(middleMathResult?.reason, 'display-math-block-content-change')
assert.equal(
  middleMathResult?.markdown,
  middleMathSource.replace('$$\r\n$$', () => '$$\r\nfence-token\r\n$$'),
  'first display-math content must stay between authored `$$` rows and retain CRLF'
)
assert.equal(
  /\$\$\r\nfence-token\r\n\r\n\$\$/.test(middleMathResult.markdown),
  false,
  'display-math content must not gain an extra blank row before its closing `$$`'
)
const slashEmptyMathSource = middleMathSource.replace(
  '$$\r\n$$',
  () => '$$\r\n\r\n$$'
)
const slashEmptyMathResult = preserveRichMarkdownSource(
  slashEmptyMathSource,
  middleMathPrevious,
  middleMathNext
)
assert.equal(slashEmptyMathResult?.preserved, true)
assert.equal(slashEmptyMathResult?.reason, 'display-math-block-content-change')
assert.equal(
  slashEmptyMathResult?.markdown,
  middleMathSource.replace('$$\r\n$$', () => '$$\r\nfence-token\r\n$$'),
  'first edit must replace the complete serializer-only blank content row'
)
assert.equal(
  /\$\$\r\nfence-token\r\n\r\n\$\$/.test(slashEmptyMathResult.markdown),
  false,
  'Slash empty-math spelling must not retain a trailing semantic newline'
)
const middleMathEditedCanonical = middleMathNext.replace(
  'fence-token',
  'fence-token-code-edit'
)
const middleMathEdited = preserveRichMarkdownSource(
  middleMathResult.markdown,
  middleMathNext,
  middleMathEditedCanonical
)
assert.equal(middleMathEdited?.preserved, true)
assert.equal(middleMathEdited?.reason, 'display-math-block-content-change')
assert.equal(
  middleMathEdited?.markdown,
  middleMathResult.markdown.replace('fence-token', 'fence-token-code-edit'),
  'subsequent display-math edits must reuse the same exact content owner'
)
assert.equal(
  middleMathEdited.markdown.startsWith('# math block ownership\r\n\r\n- authored bullet'),
  true,
  'display-math edits must not normalize unrelated list markers or line endings'
)

const emptyParagraphBeforeFenceSource = [
  '- u高科技',
  '- 1\\. 是v粉丝v',
  '',
  '```',
  '尼玛，吗了解',
  '了几百块',
  '```',
  ''
].join('\n')
const emptyParagraphBeforeFencePrevious = [
  '* u高科技',
  '',
  '* 1\\. 是v粉丝v',
  '',
  '  <br />',
  '',
  '```',
  '尼玛，吗了解',
  '了几百块',
  '```',
  ''
].join('\n')
const emptyParagraphBeforeFenceNext = [
  '* u高科技',
  '',
  '* 1\\. 是v粉丝v',
  '',
  '```',
  '尼玛，吗了解',
  '了几百块',
  '```',
  ''
].join('\n')
const emptyParagraphBeforeFenceRemoved = preserveRichMarkdownSource(
  emptyParagraphBeforeFenceSource,
  emptyParagraphBeforeFencePrevious,
  emptyParagraphBeforeFenceNext
)
assert.equal(
  emptyParagraphBeforeFenceRemoved?.markdown,
  emptyParagraphBeforeFenceSource,
  'removing an editor-only empty paragraph immediately before an authored fence must not duplicate or consume the fence'
)
assert.equal(
  emptyParagraphBeforeFenceRemoved?.preserved,
  true,
  'empty paragraph removal before an authored fence must remain source-equivalent'
)

console.log('PASS markdown source preservation: text and structural edits retain untouched source; table/list/code changes stay block-bounded')
