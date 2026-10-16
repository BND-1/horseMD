// Milkdown text stringify fast path must not skip escaping (fuzz seed 36).
import assert from 'node:assert/strict'
import { toMarkdown } from 'mdast-util-to-markdown'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { safeTrailingWhitespaceTextHandler } from '../src/renderer/src/lib/remark-text-handler.js'

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
console.log('PASS remark text handler: trailing-whitespace fast path still escapes block syntax and leading spaces')
