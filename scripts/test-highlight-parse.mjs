// Highlight parsing (lib/remark-highlight-parse.js, #173):
//   1. a highlight around other formatting — `==a **b** c==`,
//      `<mark class="hm-hl-blue">**b**</mark>` — is one highlight (the editor
//      writes exactly these when a highlight covers bold text; they used to
//      stay literal and every such edit failed the source check);
//   2. `==` pairs with the nearest `==` after it, across siblings too;
//   3. inside one text node, the result is the same as the old
//      findAndReplace(HIGHLIGHT_RE) on 20 000 random strings.
import assert from 'node:assert/strict'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { findAndReplace } from 'mdast-util-find-and-replace'
import { highlightParseTransform } from '../src/renderer/src/lib/remark-highlight-parse.js'

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

console.log(`PASS highlight parse: ${cases.length} cases (highlight around bold / italic / code / links, nearest pairing, not-highlights); one text node = old regex on 20 000 random strings`)
