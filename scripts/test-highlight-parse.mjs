// Highlight parsing (lib/remark-highlight-parse.js, #173):
//   1. a highlight around other formatting — `==a **b** c==`,
//      `<mark class="hm-hl-blue">**b**</mark>` — is one highlight (the editor
//      writes exactly these when a highlight covers bold text; they used to
//      stay literal and every such edit failed the source check);
//   2. `==` pairs with the nearest `==` after it, across siblings too;
//   3. inside one text node, the result is the same as the old
//      findAndReplace(HIGHLIGHT_RE) on 20 000 random strings;
//   4. with the source, an escaped `\=` (or `&#61;`) never delimits, and
//      text + highlights written by the serializer (handler + `\==` escape)
//      read back as the same tree on 20 000 random paragraphs (fuzz seed
//      525: text `段落==编` before a highlight reopened as a highlight).
import assert from 'node:assert/strict'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { findAndReplace } from 'mdast-util-find-and-replace'
import { toMarkdown } from 'mdast-util-to-markdown'
import { highlightParseTransform, highlightStringifyHandler, highlightUnsafe } from '../src/renderer/src/lib/remark-highlight-parse.js'
import { safeTrailingWhitespaceTextHandler } from '../src/renderer/src/lib/remark-text-handler.js'

const HIGHLIGHT_RE = /(?<![={])(==)(?!\})([^=\s][^=]*[^=\s]|[^=\s])\1(?![=])/g

const strip = (node) => {
  if (Array.isArray(node)) return node.map(strip)
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'position' || key === 'data') continue
    out[key] = strip(value)
  }
  return out
}

// A compact spelling of a paragraph's inline tree: [h:yellow …], [strong …].
const show = (nodes) => nodes.map((n) => {
  if (n.type === 'text') return JSON.stringify(n.value)
  if (n.type === 'html') return `html(${n.value})`
  if (n.type === 'inlineCode') return `code(${n.value})`
  if (n.type === 'highlight') return `[h:${n.color} ${show(n.children)}]`
  return `[${n.type} ${show(n.children || [])}]`
}).join(' ')

const parse = (md) => {
  const tree = fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  highlightParseTransform(tree)
  return show(tree.children[0].children)
}

const cases = [
  ['==a **b** c==', '[h:yellow "a " [strong "b"] " c"]'],
  ['==**b**==', '[h:yellow [strong "b"]]'],
  ['就==是**抹除了**==**品之间**。', '"就" [h:yellow "是" [strong "抹除了"]] [strong "品之间"] "。"'],
  ['==摄**影**作品==，到了==电影==这', '[h:yellow "摄" [strong "影"] "作品"] "，到了" [h:yellow "电影"] "这"'],
  ['<mark class="hm-hl-blue">**政治**</mark>。', '[h:blue [strong "政治"]] "。"'],
  ['无<mark class="hm-hl-red">言的。**但是**</mark>**从**', '"无" [h:red "言的。" [strong "但是"]] [strong "从"]'],
  ['**<mark class="hm-hl-blue">视觉</mark>在**', '[strong [h:blue "视觉"] "在"]'],
  ['<mark class="hm-hl-blue">a</mark>', '[h:blue "a"]'],
  ['==a `x=y` b==', '[h:yellow "a " code(x=y) " b"]'],
  ['==[维基](https://w.org) x==', '[h:yellow [link "维基"] " x"]'],
  ['==*斜*==和==b==', '[h:yellow [emphasis "斜"]] "和" [h:yellow "b"]'],
  // Not highlights.
  ['a == b **c** d == e', '"a == b " [strong "c"] " d == e"'],
  ['==a **b**', '"==a " [strong "b"]'],
  ['==a= **b** c==', '"==a= " [strong "b"] " c=="'],
  ['== **b**==', '"== " [strong "b"] "=="'],
  ['==**b** ==', '"==" [strong "b"] " =="'],
  ['=== **b** ===', '"=== " [strong "b"] " ==="'],
  ['{==a **b**==}{>>c<<}', '"{==a " [strong "b"] "==}{>>c<<}"'],
  ['<mark class="hm-hl-blue">**a**', 'html(<mark class="hm-hl-blue">) [strong "a"]'],
  ['<mark class="x">**a**</mark>', 'html(<mark class="x">) [strong "a"] html(</mark>)']
]
for (const [md, expected] of cases) assert.equal(parse(md), expected, md)

// 3. One text node: same as the old regex.
let seed = 173
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
const alphabet = ['=', '=', '=', 'a', '中', ' ', '{', '}', '\n']
for (let k = 0; k < 20000; k += 1) {
  let value = ''
  const length = 1 + rnd(14)
  for (let i = 0; i < length; i += 1) value += alphabet[rnd(alphabet.length)]
  const oldTree = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value }] }] }
  findAndReplace(oldTree, [[HIGHLIGHT_RE, (_w, _e, content) => ({ type: 'highlight', color: 'yellow', children: [{ type: 'text', value: content }] })]])
  const newTree = highlightParseTransform({ type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value }] }] })
  assert.deepEqual(strip(newTree), strip(oldTree), JSON.stringify(value))
}

// 4. Escapes, with the source.
const parseWithSource = (md) => {
  const tree = fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  highlightParseTransform(tree, { value: md })
  return show(tree.children[0].children)
}
const escapeCases = [
  ['段落\\==编辑==步骤三== x', '"段落==编辑" [h:yellow "步骤三"] " x"'],
  ['\\==a==', '"==a=="'],
  ['&#61;=a==', '"==a=="'],
  ['==a\\==b==', '"==a==b=="'],
  ['- x \\==y ==z==', null]
]
for (const [md, expected] of escapeCases) {
  if (expected) assert.equal(parseWithSource(md), expected, md)
}
assert.equal(parseWithSource('==a== b'), '[h:yellow "a"] " b"')

// Milkdown's remarkLineBreak runs first and splits text at soft breaks into
// pieces without positions; the escapes are still found (seed 525 was in a
// list item with a lazy continuation line).
const splitSoftBreaks = (node) => {
  if (!Array.isArray(node.children)) return
  node.children.forEach(splitSoftBreaks)
  node.children = node.children.flatMap((kid) => {
    if (kid.type !== 'text' || !/\n/.test(kid.value)) return [kid]
    const out = []
    const parts = kid.value.split(/[\t ]*(?:\r?\n|\r)/)
    parts.forEach((part, k) => {
      if (k) out.push({ type: 'break', data: { isInline: true } })
      if (part) out.push({ type: 'text', value: part })
    })
    return out
  })
}
const find = (node, type) => node.type === type ? node : (node.children || []).map((c) => find(c, type)).find(Boolean)
const parseSplit = (md) => {
  const tree = fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  splitSoftBreaks(tree)
  highlightParseTransform(tree, { value: md })
  return show(find(tree, 'paragraph').children)
}
assert.equal(parseSplit('3. a\n   b \\==c==d== x\n'), '"a" [break ] "b ==c" [h:yellow "d"] " x"')
assert.equal(parseSplit('3. 段落\\==编辑==步骤三== x\n src39\n- [ ] t\n'), '"段落==编辑" [h:yellow "步骤三"] " x" [break ] "src39"')
assert.equal(parseSplit('> a\n> b\\==c==d==\n'), '"a" [break ] "b==c" [h:yellow "d"]')
assert.equal(parseSplit('> a\nb\\==c==d==\n'), '"a" [break ] "b==c" [h:yellow "d"]')
assert.equal(parseSplit('**x**\n\\==c==d==\n'), '[strong "x"] [break ] "==c" [h:yellow "d"]')
assert.equal(parseSplit('a\n==c==\n'), '"a" [break ] [h:yellow "c"]')
// An empty line written `&#10;` is split off as a break too (fuzz seed 2829:
// a code block turned into a heading + paragraph reopened `\==g==` as a
// highlight).
assert.equal(parseSplit('a\n&#10;\\==g==\n'), '"a" [break ] [break ] "==g=="')
assert.equal(parseSplit('a\n&#xA;x \\*\\*\\==g\\==a\\*\\*\n'), '"a" [break ] [break ] "x **==g==a**"')
assert.equal(parseSplit('a\n&#10;==g==\n'), '"a" [break ] [break ] [h:yellow "g"]')
assert.equal(parseSplit('a&#10;\\==g==\n'), '"a" [break ] "==g=="')
// The leading-space sentinel `\u200B ` is stripped before this transform
// with the position unchanged (markdown-leading-space.js).
const stripSentinel = (node) => {
  if (node.type === 'text' && node.value.startsWith('\u200B ')) node.value = node.value.slice(1)
  ;(node.children || []).forEach(stripSentinel)
}
const parseStripped = (md) => {
  const tree = fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  stripSentinel(tree)
  splitSoftBreaks(tree)
  highlightParseTransform(tree, { value: md })
  return show(find(tree, 'paragraph').children)
}
assert.equal(parseStripped('\u200B a \\==g==\n'), '" a ==g=="')
assert.equal(parseStripped('- \u200B  \\*a\n  &#10;\\==g==\n'), '"  *a" [break ] [break ] "==g=="')
assert.equal(parseStripped('\u200B a ==g==\n'), '" a " [h:yellow "g"]')

const merge = (nodes) => {
  const out = []
  for (const n of nodes) {
    const node = n.type === 'highlight' ? { type: 'highlight', color: n.color, children: merge(n.children) } : { type: n.type, value: n.value }
    const last = out[out.length - 1]
    if (node.type === 'text' && last?.type === 'text') last.value += node.value
    else if (node.type !== 'text' || node.value) out.push(node)
  }
  return out
}
// The editor's own text handler: mdast skipped the `\==` escape right
// after another escaped character (`2\*\*==第一`, fuzz seed 6142), which
// `restoreHighlightEscapes` puts back; `*` `_` `[` in the pieces reach it.
const write = (children) => toMarkdown({ type: 'root', children: [{ type: 'paragraph', children }] }, {
  handlers: { highlight: highlightStringifyHandler, text: safeTrailingWhitespaceTextHandler },
  unsafe: [highlightUnsafe]
})
{
  const children = [{ type: 'text', value: '2**==第一' }, { type: 'highlight', color: 'yellow', children: [{ type: 'text', value: 'b' }] }, { type: 'text', value: 'c' }]
  const md = write(children)
  assert.equal(md, '2\\*\\*\\==第一==b==c\n', 'a literal `==` after an escaped `*` is escaped too (seed 6142)')
  const tree = fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  highlightParseTransform(tree, { value: md })
  assert.deepEqual(merge(tree.children[0].children), strip(children), 'it reads back as text + the highlight')
}
const pieces = ['=', '=', '==', 'a', '中', ' ', '{', '}', 'b', '编', '*', '_', '[']
let roundTrips = 0
for (let i = 0; i < 20000; i += 1) {
  const children = []
  const count = 1 + rnd(5)
  for (let k = 0; k < count; k += 1) {
    if (rnd(3) === 0) {
      // Highlight content: no blank at either edge (the serializer moves
      // edge blanks out of every mark run).
      let inner = ''
      for (let n = 1 + rnd(4); n > 0; n -= 1) inner += pieces[rnd(pieces.length)]
      inner = inner.trim()
      if (inner) children.push({ type: 'highlight', color: 'yellow', children: [{ type: 'text', value: inner }] })
    } else {
      let value = ''
      for (let n = 1 + rnd(6); n > 0; n -= 1) value += pieces[rnd(pieces.length)]
      children.push({ type: 'text', value })
    }
  }
  const expected = merge(children)
  // Paragraph edges are trimmed by Markdown; the editor writes those blanks
  // as entities (not this test's concern).
  const first = expected[0]
  const last = expected[expected.length - 1]
  if (!expected.length || (first.type === 'text' && /^\s/.test(first.value)) || (last.type === 'text' && /\s$/.test(last.value))) continue
  // Two highlights side by side are one mark run in the editor.
  if (expected.some((n, k) => n.type === 'highlight' && expected[k + 1]?.type === 'highlight')) continue
  // Written as the editor hands them over: ProseMirror merges adjacent text
  // of the same marks, so two text nodes never touch.
  const md = write(expected)
  const tree = fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  highlightParseTransform(tree, { value: md })
  const back = merge(tree.children[0]?.children || [])
  assert.deepEqual(back, expected, JSON.stringify({ md, children }))
  roundTrips += 1
}

console.log(`PASS highlight parse: ${cases.length} cases (highlight around bold / italic / code / links, nearest pairing, not-highlights); one text node = old regex on 20 000 random strings; an escaped \\= never delimits, serializer output reads back the same on ${roundTrips} random paragraphs`)
