import assert from 'node:assert/strict'
import {
  preserveGeneratedBulletMarkers,
  preserveRichMarkdownSource,
  replaceMarkdownFrontmatterBlock,
  replaceMarkdownListBlock,
  restoreTypedBulletMarker
} from '../src/renderer/src/markdown-source-preservation.js'
import { sourceVisibleIndex } from '../src/renderer/src/mode-visible-map.js'

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
assert.equal(listTextEdited.reason, 'localized-change')
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
assert.equal(appendedParagraphWithoutFinalNewline.reason, 'appended-paragraph')
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
assert.equal(paragraphAfterSettledNewDocumentTitle.reason, 'appended-paragraph')
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
assert.equal(trailingEmptyParagraphCreated.reason, 'trailing-empty-block-created')
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
assert.equal(trailingEmptyParagraphFilled.reason, 'trailing-empty-block-filled')
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
assert.equal(middleEmptyParagraphCreated.reason, 'middle-empty-block-created')
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

console.log('PASS markdown source preservation: text and structural edits retain untouched source; table/list changes stay block-bounded')
