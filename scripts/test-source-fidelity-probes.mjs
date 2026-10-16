import assert from 'node:assert/strict'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'

const cases = []
const add = (name, source, previous, next, expected, note = '') => {
  cases.push({ name, source, previous, next, expected, note })
}

// 1. Escape untouched on a different edit line
add('escape-different-line',
  '# 标题\n\n这里是 0~9 和 3.5 倍。\n',
  '# 标题\n\n这里是 0\\~9 和 3.5 倍。\n',
  '# 标题\n\n这里是 0\\~9 和 3.5 倍X。\n',
  '# 标题\n\n这里是 0~9 和 3.5 倍X。\n')

// 2. Escape on the edited line (type after the tilde)
add('escape-edited-line',
  'A~B\n',
  'A\\~B\n',
  'A\\~BC\n',
  'A~BC\n')

// 3. Bullet markers stay authored when text edits
add('bullet-marker',
  '- 第一项\n- 第二项\n',
  '* 第一项\n* 第二项\n',
  '* 第一项X\n* 第二项\n',
  '- 第一项X\n- 第二项\n')

// 4. Ordered punctuation stays authored
add('ordered-punctuation',
  '1. 第一项\n2. 第二项\n',
  '1) 第一项\n2) 第二项\n',
  '1) 第一项X\n2) 第二项\n',
  '1. 第一项X\n2. 第二项\n')

// 5. Task checkbox toggle keeps dash
add('task-toggle',
  '- [ ] 任务\n',
  '* [ ] 任务\n',
  '* [x] 任务\n',
  '- [x] 任务\n')

// 6. Hard break with trailing spaces stays authored
add('hard-break-spaces',
  '第一行  \n第二行\n',
  '第一行\\\n第二行\n',
  '第一行\\\n第二行X\n',
  '第一行  \n第二行X\n')

// 7. Empty middle paragraph -> blank lines, no <br />
add('empty-middle',
  '# 测试\n\n你好\n\n再见\n',
  '# 测试\n\n你好\n\n再见\n',
  '# 测试\n\n<br />\n\n再见\n',
  '# 测试\n\n\n\n再见\n')

// 9. Paragraph split by Enter
add('split-paragraph',
  '第一段内容在这\n',
  '第一段内容在这\n',
  '第一段内容在\n\n这\n',
  '第一段内容在\n\n这\n')

// 10. Paragraph merge by deleting the break
add('merge-paragraph',
  '第一段内容在\n\n这\n',
  '第一段内容在\n\n这\n',
  '第一段内容在这\n',
  '第一段内容在这\n')

// 11. Middle paragraph inserted
add('insert-middle-paragraph',
  '# 标题\n\n前段\n\n后段\n',
  '# 标题\n\n前段\n\n后段\n',
  '# 标题\n\n前段\n\n新段\n\n后段\n',
  '# 标题\n\n前段\n\n新段\n\n后段\n')

// 12. Middle empty paragraph inserted -> source unchanged
add('insert-middle-empty',
  '# 标题\n\n前段\n\n后段\n',
  '# 标题\n\n前段\n\n后段\n',
  '# 标题\n\n前段\n\n<br />\n\n后段\n',
  '# 标题\n\n前段\n\n后段\n')

// 13. Trailing empty paragraph by Enter -> source unchanged
add('enter-trailing-empty',
  '# 测试\n\n你好\n',
  '# 测试\n\n你好\n',
  '# 测试\n\n你好\n\n<br />\n',
  '# 测试\n\n你好\n')

// 14. Setext heading stays when body text edits
add('setext-heading',
  '标题\n===\n\n正文\n',
  '# 标题\n\n正文\n',
  '# 标题\n\n正文X\n',
  '标题\n===\n\n正文X\n')

// 15. Blockquote markers stay when text edits
add('blockquote',
  '> 引用\n> 继续\n\n正文\n',
  '> 引用\n>\n> 继续\n\n正文\n',
  '> 引用X\n>\n> 继续\n\n正文\n',
  '> 引用X\n> 继续\n\n正文\n')

// 16. Fenced code fence stays when body edits
add('fenced-code',
  '```js\nconst a = 1\n```\n',
  '```js\nconst a = 1\n```\n',
  '```js\nconst a = 2\n```\n',
  '```js\nconst a = 2\n```\n')

// 18. Image alt text edit only
add('image-alt',
  '![旧图](img/a.png)\n',
  '![旧图](img/a.png)\n',
  '![新图](img/a.png)\n',
  '![新图](img/a.png)\n')

// 20. Two middle paragraphs emptied at once
add('empty-two-paragraphs',
  '# 测试\n\n甲\n\n乙\n\n再见\n',
  '# 测试\n\n甲\n\n乙\n\n再见\n',
  '# 测试\n\n<br />\n\n<br />\n\n再见\n',
  '# 测试\n\n\n\n\n\n再见\n')

// 21. First paragraph emptied (not trailing)
add('empty-first-paragraph',
  '你好\n\n再见\n',
  '你好\n\n再见\n',
  '<br />\n\n再见\n',
  '\n\n再见\n')

// 23. CRLF with emptied paragraph
add('crlf-empty-middle',
  '# 测试\r\n\r\n你好\r\n\r\n再见\r\n',
  '# 测试\n\n你好\n\n再见\n',
  '# 测试\n\n<br />\n\n再见\n',
  '# 测试\r\n\r\n\r\n\r\n再见\r\n')

// 24. BOM preserved when paragraph emptied
add('bom-empty-middle',
  '\uFEFF# 测试\n\n你好\n\n再见\n',
  '# 测试\n\n你好\n\n再见\n',
  '# 测试\n\n<br />\n\n再见\n',
  '\uFEFF# 测试\n\n\n\n再见\n')

// 27. Two authored lists stay separated
add('adjacent-lists',
  '- a\n\n- b\n',
  '* a\n\n* b\n',
  '* a\n* b\n',
  '- a\n\n- b\n')

// 30. Thematic break untouched while nearby text edits
add('thematic-break',
  '前文\n\n---\n\n后文\n',
  '前文\n\n---\n\n后文\n',
  '前文X\n\n---\n\n后文\n',
  '前文X\n\n---\n\n后文\n')

// 31. Merge two adjacent authored '-' lists (backspace at start of second)
add('merge-adjacent-bullet-lists',
  '- 甲\n\n- 乙\n',
  '* 甲\n\n* 乙\n',
  '* 甲\n* 乙X\n',
  '- 甲\n- 乙X\n')

// 32. Merge two adjacent ordered lists keeps dot punctuation
add('merge-adjacent-ordered-lists',
  '1. 甲\n\n1. 乙\n',
  '1) 甲\n\n1) 乙\n',
  '1) 甲\n1) 乙X\n',
  '1. 甲\n1. 乙X\n')

// 33. Merge nested lists keeps outer loose and inner compact
add('merge-nested-lists',
  '1. 甲\n\n   1. 子甲\n\n   1. 子乙\n',
  '1) 甲\n\n   1) 子甲\n\n   1) 子乙\n',
  '1) 甲\n\n   1) 子甲\n   1) 子乙X\n',
  '1. 甲\n\n   1. 子甲\n   1. 子乙X\n')

// 34. CRLF merge keeps CRLF
add('merge-crlf-lists',
  '- 甲\r\n\r\n- 乙\r\n',
  '* 甲\n\n* 乙\n',
  '* 甲\n* 乙X\n',
  '- 甲\r\n- 乙X\r\n')

// 35. Empty a heading
add('empty-heading',
  '# 测试\n\n正文\n',
  '# 测试\n\n正文\n',
  '# \n\n正文\n',
  '# \n\n正文\n')

// 36. Delete the first paragraph merges into heading
add('delete-first-paragraph-into-heading',
  '# 标题\n\n第一段\n\n第二段\n',
  '# 标题\n\n第一段\n\n第二段\n',
  '# 标题第一段\n\n第二段\n',
  '# 标题第一段\n\n第二段\n')

// 37. Empty paragraph inside a blockquote becomes an empty quote line
add('empty-blockquote-paragraph',
  '> 引用一\n>\n> 引用二\n',
  '> 引用一\n>\n> 引用二\n',
  '> 引用一\n>\n> <br />\n',
  '> 引用一\n>\n>\n')

// 38. Paragraph becomes thematic break via input rule
add('thematic-break-input-rule',
  '前文\n\n后文\n',
  '前文\n\n后文\n',
  '前文\n\n---\n',
  '前文\n\n---\n')

// 38b. Published escaped dash becomes a middle thematic break without gluing
add('middle-thematic-break-after-escaped-dash',
  '- authored\n\n3. 3fresh\n\n\\-\n\n1. following\n',
  '* authored\n\n3. 3fresh\n\n\\-\n\n1. following\n',
  '* authored\n\n3. 3fresh\n\n***\n\n1. following\n',
  '- authored\n\n3. 3fresh\n\n---\n\n1. following\n')

// 38c. Cross-list selection deletion leaves one empty bullet atomically
add('cross-list-selection-delete-to-empty-bullet',
  '左段\n\n- first\n\n2. middle\n\n- last\n- survivor\n',
  '左段\n\n* first\n\n2. middle\n\n* last\n\n* survivor\n',
  '左段\n\n* <br />\n\n* survivor\n',
  '左段\n\n- \n- survivor\n')

// 38d. Empty ordered parent with a nested child merges into its left sibling
add('empty-ordered-parent-before-nested-list',
  '# sdvs\n\n- srgsrgs \n- srgsrgsg \n  * srgtrhyj \n\n当然会当然好\n\n1. 是共生共荣\n2. \n   1. 如何电话\n',
  '# sdvs\n\n* srgsrgs \n* srgsrgsg \n\n  * srgtrhyj \n\n当然会当然好\n\n1. 是共生共荣\n2. <br />\n\n   1. 如何电话\n\n',
  '# sdvs\n\n* srgsrgs \n* srgsrgsg \n\n  * srgtrhyj \n\n当然会当然好\n\n1. 是共生共荣\n\n   <br />\n\n   1. 如何电话\n\n',
  '# sdvs\n\n- srgsrgs \n- srgsrgsg \n  * srgtrhyj \n\n当然会当然好\n\n1. 是共生共荣\n   1. 如何电话\n')

// 38e. Rapid double Enter inserts an editor-only empty paragraph while the
// surviving sibling list changes only its canonical bullet token.
add('coalesced-empty-bullet-exit-before-sibling',
  '# RS86\n\n- prefix\n\n- u高科技\n\n- 12312\n\n- 1\\. 色粉色分\n\n1. 后文\n',
  '# RS86\n\n* prefix\n\n- u高科技\n\n- 12312\n\n- 1\\. 色粉色分\n\n1. 后文\n',
  '# RS86\n\n* prefix\n\n- u高科技\n\n- 12312\n\n<br />\n\n* 1\\. 色粉色分\n\n1. 后文\n',
  '# RS86\n\n- prefix\n\n- u高科技\n\n- 12312\n\n- 1\\. 色粉色分\n\n1. 后文\n')

// 39. Image with title text edit
add('image-title',
  '![图](img/a.png "旧标题")\n',
  '![图](img/a.png "旧标题")\n',
  '![图](img/a.png "新标题")\n',
  '![图](img/a.png "新标题")\n')

// 40. Strikethrough marker stays when text edits
add('strikethrough',
  '这是 ~~删除~~ 内容\n',
  '这是 ~~删除~~ 内容\n',
  '这是 ~~删除~~ 内容X\n',
  '这是 ~~删除~~ 内容X\n')

// 41. Link with title edits
add('link-title',
  '[文字](https://x.example "标题")\n',
  '[文字](https://x.example "标题")\n',
  '[文字X](https://x.example "标题")\n',
  '[文字X](https://x.example "标题")\n')

// 42. Heading markdown change (# -> ##) keeps list/marker bytes
add('heading-level-near-list',
  '# 一级\n\n- 列表项\n',
  '# 一级\n\n* 列表项\n',
  '## 一级\n\n* 列表项\n',
  '## 一级\n\n- 列表项\n')

// 43. Escape at the very end of the edited line
add('escape-at-line-end',
  '末尾波浪号 ~\n',
  '末尾波浪号 \\~\n',
  '末尾波浪号 \\~X\n',
  '末尾波浪号 ~X\n')

let failures = 0
for (const testCase of cases) {
  const result = preserveRichMarkdownSource(testCase.source, testCase.previous, testCase.next)
  let ok
  try {
    assert.equal(result.markdown, testCase.expected)
    ok = true
  } catch {
    ok = false
  }
  if (!ok) {
    failures += 1
    console.log(`FAIL ${testCase.name} (${result.reason})`)
    console.log(`  source:   ${JSON.stringify(testCase.source)}`)
    console.log(`  got:      ${JSON.stringify(result.markdown)}`)
    console.log(`  expected: ${JSON.stringify(testCase.expected)}`)
  } else {
    console.log(`PASS ${testCase.name} (${result.reason})`)
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed`)
process.exit(failures ? 1 : 0)
