// Milkdown text stringify fast path must not skip escaping (fuzz seed 36).
import assert from 'node:assert/strict'
import { toMarkdown } from 'mdast-util-to-markdown'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkCjkFriendly from 'remark-cjk-friendly'
import { emphasisStringifyHandler, safeTrailingWhitespaceTextHandler, strongStringifyHandler } from '../src/renderer/src/lib/remark-text-handler.js'

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
  [[T('a  '), S(T('b')), T(' tail ')], 'a  **b** tail \n'],
  [[T('x'), C('c'), T('  '), C('d')], 'x`c`  `d`\n']
]
// A soft-break text node at a paragraph start is not indentation.
assert.equal(stringify([T('a'), { type: 'break' }, T('\n'), T('b')]).includes('&#xA;'), false)
assert.equal(
  toMarkdown({ type: 'root', children: [{ type: 'paragraph', children: [T('\n'), T('Second')] }] }, { handlers: { text: safeTrailingWhitespaceTextHandler }, encode: [] }).includes('&#x'),
  false
)
for (const [children, expected] of cases) {
  const markdown = stringify(children)
  assert.equal(markdown, expected)
  const reparsed = fromMarkdown(markdown)
  assert.equal(reparsed.children.length, 1, `one block for ${JSON.stringify(markdown)}`)
  assert.equal(reparsed.children[0].type, 'paragraph', `still a paragraph: ${JSON.stringify(markdown)}`)
  const expectedText = children.map(plain).join('').replace(/[ \t]+$/, '')
  assert.equal(plain(reparsed.children[0]).replace(/[ \t]+$/, ''), expectedText, `text kept: ${JSON.stringify(markdown)}`)
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
console.log('PASS remark text handler: trailing-whitespace fast path still escapes block syntax and leading spaces; strong/emphasis keep attention encoding and the authored marker')
