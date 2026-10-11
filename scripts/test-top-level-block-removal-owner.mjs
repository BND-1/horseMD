// Whole top-level block removal owner (fuzz seed 36, 0.13.237).
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { fromMarkdown } from 'mdast-util-from-markdown'
import {
  alignTopLevelSourceBlocks,
  classifyTopLevelBlockRemoval,
  removeTopLevelSourceBlocks
} from '../src/renderer/src/lib/source-sync/top-level-block-removal-transaction-owner.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    heading: { content: 'text*', group: 'block' },
    hr: { group: 'block' },
    text: {}
  }
})
const p = (text = '') => schema.nodes.paragraph.create(null, text ? schema.text(text) : null)
const h = (text) => schema.nodes.heading.create(null, schema.text(text))
const hr = () => schema.nodes.hr.create()
const doc = (...blocks) => schema.nodes.doc.create(null, blocks)

// Pure removal of a selected rule.
assert.deepEqual(
  classifyTopLevelBlockRemoval(doc(h('T'), hr(), p('final')), doc(h('T'), p('final'))),
  { removedFrom: 1, removedTo: 2, edited: null }
)
// Typing over a selected rule: rule removed, text joins the next paragraph.
assert.deepEqual(
  classifyTopLevelBlockRemoval(doc(h('T'), hr(), p('final')), doc(h('T'), p('betafinal'))),
  { removedFrom: 1, removedTo: 2, edited: { index: 2 } }
)
// A paragraph join is NOT this family (text-bearing block removed).
assert.equal(classifyTopLevelBlockRemoval(doc(p('a'), p('b')), doc(p('ab'))), null)
// Same block count or growth is not a removal.
assert.equal(classifyTopLevelBlockRemoval(doc(p('a')), doc(p('b'))), null)

// Source alignment uses remark positions; trailing empty PM paragraph allowed.
const source = '# T\n\n---\n\nfinal\n'
const ranges = alignTopLevelSourceBlocks({ source, doc: doc(h('T'), hr(), p('final'), p()), parseMarkdownTree: fromMarkdown })
assert.deepEqual(ranges.map((range) => range.type), ['heading', 'thematicBreak', 'paragraph'])
assert.equal(removeTopLevelSourceBlocks(source, ranges, 1, 2), '# T\n\nfinal\n')
assert.equal(removeTopLevelSourceBlocks(source, ranges, 2, 3), '# T\n\n---\n', 'last block takes its preceding separator')
// BOM offsets are shifted back onto the BOM-carrying source.
const bomSource = '﻿# T\n\n***\n\nfinal\n'
const bomRanges = alignTopLevelSourceBlocks({ source: bomSource, doc: doc(h('T'), hr(), p('final')), parseMarkdownTree: fromMarkdown })
assert.equal(removeTopLevelSourceBlocks(bomSource, bomRanges, 1, 2), '﻿# T\n\nfinal\n')
// Type or count disagreement refuses to guess.
assert.equal(alignTopLevelSourceBlocks({ source, doc: doc(h('T'), p('x'), p('final')), parseMarkdownTree: fromMarkdown }), null)
assert.equal(alignTopLevelSourceBlocks({ source, doc: doc(h('T'), p('final')), parseMarkdownTree: fromMarkdown }), null)

console.log('PASS top-level block removal owner: removal/overtype classification, joins excluded, remark-aligned source ranges (BOM, trailing paragraph), exact splice')
