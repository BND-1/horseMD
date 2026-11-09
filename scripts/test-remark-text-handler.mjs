// Milkdown text stringify fast path must not skip escaping (fuzz seed 36).
import assert from 'node:assert/strict'
import { toMarkdown } from 'mdast-util-to-markdown'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkCjkFriendly from 'remark-cjk-friendly'
import { emphasisStringifyHandler, safeTrailingWhitespaceTextHandler, strongStringifyHandler, taskListItemStringifyHandler } from '../src/renderer/src/lib/remark-text-handler.js'
import { gfmToMarkdown } from 'mdast-util-gfm'

const T = (value) => ({ type: 'text', value })
const C = (value) => ({ type: 'inlineCode', value })
const S = (...children) => ({ type: 'strong', children })
const stringify = (children) => toMarkdown(
  { type: 'root', children: [{ type: 'paragraph', children }] },
  { handlers: { text: safeTrailingWhitespaceTextHandler }, encode: [] }
)
const plain = (node) => node.type === 'text' || node.type === 'inlineCode'
  ? node.value
  : (node.children || []).map(plain).join('')

const cases = [
  [[T('    second '), C('c'), T(' here')], '&#x20;   second `c` here\n'],
  [[T('1. foo '), C('c')], '1\\. foo `c`\n'],
  [[T('# h '), C('c')], '\\# h `c`\n'],
  [[T('- x '), C('c')], '\\- x `c`\n'],
  [[T('> q '), C('c')], '\\> q `c`\n'],
  [[T('    '), C('c')], '&#x20;   `c`\n'],
  // The fast path's purpose is kept: whitespace before a mark stays raw.
  [[T('a '), S(T('b'))], 'a **b**\n'],
  // Blanks before the paragraph's end (or any line ending) have no Markdown.
  [[T('a  '), S(T('b')), T(' tail ')], 'a  **b** tail\n'],
  [[T('a  '), { type: 'text', value: '\n' }, T('b')], 'a\nb\n'],
  [[T('x'), C('c'), T('  '), C('d')], 'x`c`  `d`\n'],
  // Blank-only text before a line ending after other content on the line
  // (bold, an `&#10;`): no Markdown — written, it made the soft break a hard
  // one (fuzz seeds 936, 236, 3815).
  [[S(T('a')), T('  '), { type: 'text', value: '\n' }, T('b')], '**a**\nb\n'],
  [[T('a'), { type: 'text', value: '\n' }, T('    '), { type: 'text', value: '\n' }, T('b')], 'a\n&#x20;\nb\n'],
  [[T('a *  \nb')], 'a \\*\nb\n']
]
// A soft-break text node at a paragraph start is not indentation.
assert.equal(stringify([T('a'), { type: 'break' }, T('\n'), T('b')]).includes('&#xA;'), false)
assert.equal(
  toMarkdown({ type: 'root', children: [{ type: 'paragraph', children: [T('\n'), T('Second')] }] }, { handlers: { text: safeTrailingWhitespaceTextHandler }, encode: [] }).includes('&#x'),
  false
)
// Text that starts with U+200B + a space is not the leading-space sentinel
// (stripped on read): the zero-width space is written as an entity (seed 1286).
assert.equal(stringify([T('\u200B a')]), '&#x200B; a\n')
assert.equal(stringify([T('q'), { type: 'break' }, T('\u200B b')]), 'q\\\n&#x200B; b\n')
assert.equal(stringify([T('\u200Bab')]), '\u200Bab\n', 'a zero-width space before other text stays literal')
for (const [children, expected] of cases) {
  const markdown = stringify(children)
  assert.equal(markdown, expected)
  const reparsed = fromMarkdown(markdown)
  assert.equal(reparsed.children.length, 1, `one block for ${JSON.stringify(markdown)}`)
  assert.equal(reparsed.children[0].type, 'paragraph', `still a paragraph: ${JSON.stringify(markdown)}`)
  const expectedText = children.map(plain).join('').replace(/[ \t]+(?=\n|$)/g, '')
  // (A line of only blanks reads back as one encoded blank.)
  assert.equal(plain(reparsed.children[0]).replace(/[ \t]+(?=\n|$)/g, ''), expectedText, `text kept: ${JSON.stringify(markdown)}`)
}
// Strong/emphasis handlers (Milkdown's defaults skip attention encoding):
// `**foo.**abc` parses back as literal asterisks, so the letter is encoded.
{
  const H = { text: safeTrailingWhitespaceTextHandler, strong: strongStringifyHandler, emphasis: emphasisStringifyHandler }
  const out = (children) => toMarkdown({ type: 'root', children: [{ type: 'paragraph', children }] }, { handlers: H, encode: [] })
  const html = (value) => ({ type: 'html', value })
  const E = (...children) => ({ type: 'emphasis', children })
  const attention = [
    [[S(T('foo.')), T('abc')], '**foo.**&#x61;bc\n'],
    [[S(html('<font>x</font>')), T('abc')], '**<font>x</font>**&#x61;bc\n'],
    [[E(T('foo.')), T('abc')], '*foo.*&#x61;bc\n'],
    [[T('a '), S(T('b')), T(' c')], 'a **b** c\n'],
    [[T('这是'), S(T('「重点」')), T('内容')], '这是**「重点」**内容\n']
  ]
  for (const [children, expected] of attention) assert.equal(out(children), expected)
  // The authored marker is kept.
  assert.equal(out([{ ...S(T('b')), marker: '_' }, T(' c')]), '__b__ c\n')
  assert.equal(out([{ ...E(T('b')), marker: '_' }, T(' c')]), '_b_ c\n')
  // Round trip: still bold after re-parsing with the editor's parser.
  const parseLikeEditor = (markdown) => unified().use(remarkParse).use(remarkCjkFriendly).parse(markdown)
  for (const children of [[S(T('foo.')), T('abc')], [S(T('foo.')), T('😀 x')], [S(html('<b>x</b>')), T('abc')]]) {
    const back = parseLikeEditor(out(children))
    assert.equal(back.children[0].children[0].type, 'strong', `bold survives the round trip: ${out(children)}`)
  }
}
// A task item in an ordered list written with `)` (a list right after
// another ordered list) keeps its checkbox (fuzz UI seed 236).
{
  const item = (value, checked = null) => ({ type: 'listItem', spread: false, checked, children: [{ type: 'paragraph', children: [T(value)] }] })
  const list = (children) => ({ type: 'list', ordered: true, start: 1, spread: false, children })
  const tree = { type: 'root', children: [list([item('a'), item('b')]), list([item('c', true), item('d', false)])] }
  const plainGfm = toMarkdown(tree, { extensions: [gfmToMarkdown()] })
  const fixed = toMarkdown(tree, { extensions: [gfmToMarkdown()], handlers: { listItem: taskListItemStringifyHandler } })
  assert.ok(!plainGfm.includes('[x]'), `upstream still drops the checkbox (remove the workaround when it does not): ${JSON.stringify(plainGfm)}`)
  assert.ok(fixed.includes('1) [x] c') && fixed.includes('2) [ ] d'), `checkboxes after \`)\`: ${JSON.stringify(fixed)}`)
  assert.equal(toMarkdown({ type: 'root', children: [list([item('c', true)])] }, { extensions: [gfmToMarkdown()], handlers: { listItem: taskListItemStringifyHandler } }), '1. [x] c\n', 'the `.` spelling is unchanged')
}
console.log('PASS remark text handler: trailing-whitespace fast path still escapes block syntax and leading spaces; strong/emphasis keep attention encoding and the authored marker')
