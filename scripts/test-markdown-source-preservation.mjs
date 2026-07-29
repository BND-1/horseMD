import assert from 'node:assert/strict'
import {
  preserveRichMarkdownSource,
  replaceMarkdownFrontmatterBlock
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
