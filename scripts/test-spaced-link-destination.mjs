// Typora parity: an image/link destination with a bare space
// (`![](images/英国生活 篇-1.jpg)`) is an image/link in Typora but literal
// text in CommonMark. remarkSpacedLinkDestinations converts it after parse,
// with exact source positions.
import assert from 'node:assert/strict'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { remarkSpacedLinkDestinations } from '../src/renderer/src/lib/remark-spaced-link-destination.js'

const parse = (source) => {
  const tree = fromMarkdown(source.replace(/^\uFEFF/, ''), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  remarkSpacedLinkDestinations()(tree, { value: source })
  return tree
}
const inline = (source) => parse(source).children[0].children
const slice = (source, node) => source.replace(/^\uFEFF/, '').slice(node.position.start.offset, node.position.end.offset)
const brief = (nodes) => nodes.map((n) => n.type === 'text' ? `text:${n.value}` : `${n.type}:${n.url}|${n.alt ?? n.children?.map((c) => c.value).join('')}|${n.title ?? ''}`)

{
  const src = '![](images/【每日meme】英国生活 篇-1.jpg)![](images/【每日meme】英国生活 篇-2.jpg)'
  const nodes = inline(src)
  assert.deepEqual(brief(nodes), ['image:images/【每日meme】英国生活 篇-1.jpg||', 'image:images/【每日meme】英国生活 篇-2.jpg||'])
  assert.equal(slice(src, nodes[1]), '![](images/【每日meme】英国生活 篇-2.jpg)')
  assert.equal(nodes[1].position.start.column, nodes[0].position.end.column)
}
{
  const src = 'see [my notes](docs/my notes.md "Notes") and ![a b](x y.png \'T\') end'
  const nodes = inline(src)
  assert.deepEqual(brief(nodes), ['text:see ', 'link:docs/my notes.md|my notes|Notes', 'text: and ', 'image:x y.png|a b|T', 'text: end'])
  for (const node of nodes) assert.equal(slice(src, node), node.type === 'text' ? node.value : slice(src, node))
  assert.equal(slice(src, nodes[1]), '[my notes](docs/my notes.md "Notes")')
  assert.equal(slice(src, nodes[1].children[0]), 'my notes')
}
// Parentheses one level deep, like Typora.
assert.deepEqual(brief(inline('![](a (1) b.png)')), ['image:a (1) b.png||'])
// Standard destinations are left to micromark.
assert.deepEqual(brief(inline('![](a.png) [x](<a b.md>)')), ['image:a.png||', 'text: ', 'link:a b.md|x|'])
// Escaped brackets, code spans and fenced code stay literal.
assert.deepEqual(brief(inline('\\![](a b.png)')), ['text:![](a b.png)'])
assert.deepEqual(brief(inline('`![](a b.png)`')).length, 1)
assert.equal(inline('`![](a b.png)`')[0].type, 'inlineCode')
assert.equal(parse('```\n![](a b.png)\n```').children[0].type, 'code')
// Multi-line quote paragraph: positions skip the `> ` prefix.
{
  const src = '> intro\n> ![](a b.png) tail'
  const para = parse(src).children[0].children[0]
  const image = para.children.find((n) => n.type === 'image')
  assert.equal(slice(src, image), '![](a b.png)')
  assert.equal(image.position.start.line, 2)
}
// BOM: offsets exclude it.
{
  const src = '\uFEFFx ![](a b.png)'
  const image = inline(src)[1]
  assert.equal(slice(src, image), '![](a b.png)')
}
// Lone image paragraph stays a paragraph with one image (image-block later).
assert.deepEqual(parse('![](a b.png)').children[0].children.map((n) => n.type), ['image'])
console.log('PASS spaced link destinations: Typora-style bare spaces in image/link paths parse with exact positions; escapes/code untouched')
