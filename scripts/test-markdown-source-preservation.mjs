import assert from 'node:assert/strict'
import {
  generatedScratchMarkdown,
  preserveGeneratedBulletMarkers,
  preserveRichMarkdownSource,
  replaceMarkdownFrontmatterBlock,
  replaceMarkdownListBlock,
  restoreTypedBulletMarker
} from '../src/renderer/src/markdown-source-preservation.js'
import { sourceVisibleIndex } from '../src/renderer/src/mode-visible-map.js'
import { commonChange } from '../src/renderer/src/lib/markdown-preservation/core.js'
import { preserveUniquelyAnchoredTextChange } from '../src/renderer/src/lib/markdown-preservation/regions.js'

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

assert.equal(
  sourceVisibleIndex('硬换行  \n下一行').text,
  sourceVisibleIndex('硬换行\\\n下一行').text,
  'equivalent Markdown hard-break spellings must share one visible stream'
)

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
assert.equal(paragraphInsertedAfterHardBreak.reason, 'middle-block-inserted')
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
  '- 1. 甲\n- 2. 乙\n- 丙丁\n',
  'an Enter split plus canonical-only terminal newline drift must commit atomically'
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
  '- 1. 甲乙\n- 3. 戊\n- 丙丁\n',
  'a nested append must become its own authored top-level row'
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
  '- 1. 甲乙\n- 2. 后记\n- 丙丁\n',
  'filling an Entered empty item must become its own authored top-level row'
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

const divergedConsecutiveInsertions = preserveRichMarkdownSource(
  '- 1. A\n- B\n',
  '* <br />\n\n  1. A\n\n* B\n\n',
  '* <br />\n\n  1. A\n  2. X\n  3. Y\n\n* B\n\n'
)
assert.equal(
  divergedConsecutiveInsertions.markdown,
  '- 1. A\n- 2. X\n- 3. Y\n- B\n',
  'multiple inserted nested siblings in one callback must retain their canonical order'
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

console.log('PASS markdown source preservation: text and structural edits retain untouched source; table/list changes stay block-bounded')
