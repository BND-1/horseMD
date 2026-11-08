// The leading-space sentinel (U+200B before blanks) is source syntax: the
// parser removes it (markdown-leading-space.js). A paragraph of only blanks
// spelled sentinel + blanks loses the blanks at the paragraph end, so only
// the sentinel is left: that paragraph is empty, not a U+200B (fuzz seed
// 3716). A U+200B that is content keeps reading back.
import assert from 'node:assert/strict'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { remarkStripLeadingSpaceSentinel } from '../src/renderer/src/lib/markdown-leading-space.js'

const Z = '​'
const parse = (md) => {
  const tree = fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  remarkStripLeadingSpaceSentinel()(tree, { value: md })
  return tree
}
const paragraphs = (tree) => {
  const out = []
  const walk = (node) => {
    if (node.type === 'paragraph') out.push((node.children || []).map((child) => child.value ?? `<${child.type}>`).join(''))
    node.children?.forEach(walk)
  }
  walk(tree)
  return out
}

const cases = [
  ['sentinel + blanks alone: empty paragraph', `x\n\n${Z}     \n\ny\n`, ['x', '', 'y']],
  ['...with a tab', `x\n\n${Z}\t\n`, ['x', '']],
  ['...in a BOM file', `﻿${Z}   \n\ny\n`, ['', 'y']],
  ['...in a list item', `- ${Z}    \n- b\n`, ['', 'b']],
  ['...in a quote', `> ${Z}   \n`, ['']],
  ['sentinel before text: only the sentinel goes', `${Z}    A\n`, ['    A']],
  ['a lone U+200B is content', `x\n\n${Z}\n`, ['x', Z]],
  ['U+200B written as an entity is content', `&#x200B;   \n`, [Z]],
  ['U+200B + text is content', `${Z}a\n`, [`${Z}a`]],
]
for (const [name, md, expected] of cases) {
  assert.deepEqual(paragraphs(parse(md)), expected, name)
}
console.log(`PASS leading-space sentinel: ${cases.length} cases (sentinel + blanks reads back as an empty paragraph; content U+200B kept)`)
