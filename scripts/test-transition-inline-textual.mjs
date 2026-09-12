// Node contracts for the transition channel's inline-textual normalization
// (P7b, trace-62663 third family). On documents whose authored bytes and
// serialized bytes already parse differently at inline spots (autolink
// brackets like huangz(<https://…>) vs plain text, serializer mark splits),
// areSourceDocumentTransitionsEquivalent must answer "did both sides make
// the same structural edit with the same visible text" — inline MARK FORM
// must not decide it. Both sides are normalized symmetrically, so genuine
// text/structure changes on one side still fail closed.
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import {
  areSourceDocumentTransitionsEquivalent,
  areSourceDocumentsEquivalent
} from '../src/renderer/src/lib/source-transaction-sync.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 2 } } },
    text: { group: 'inline' }
  },
  marks: {
    strong: {},
    emphasis: {},
    link: { attrs: { href: { default: '' } } }
  }
})
const paragraph = (content) => schema.nodes.paragraph.create(null, content)
const heading = (content) => schema.nodes.heading.create({ level: 2 }, content)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)
const text = (value, marks = []) => schema.text(value, marks)
const strong = () => schema.marks.strong.create()
const link = (href) => schema.marks.link.create({ href })

// ---------------------------------------------------------------------------
// 1. The incident shape (trace-62663): a later append whose window sits next
//    to the chronic autolink asymmetry — author bytes plain, canonical parse
//    carrying the link — must pass the transition proof.
// ---------------------------------------------------------------------------
const linkSrcBefore = document(
  paragraph([text('前文 huangz(https://x.dev) 后文')])
)
const linkCanBefore = document(
  paragraph([text('前文 huangz('), text('https://x.dev', [link('https://x.dev')]), text(') 后文')])
)
const linkSrcAfter = document(
  paragraph([text('前文 huangz(https://x.dev) 后文')]),
  paragraph(text('新增一行'))
)
const linkCanAfter = document(
  paragraph([text('前文 huangz('), text('https://x.dev', [link('https://x.dev')]), text(') 后文')]),
  paragraph(text('新增一行'))
)
assert.equal(
  areSourceDocumentTransitionsEquivalent(linkSrcBefore, linkSrcAfter, linkCanBefore, linkCanAfter),
  true,
  'an append across the chronic autolink asymmetry must pass the transition proof'
)

// 2. Same shape but the canonical side appended DIFFERENT text — fail closed.
assert.equal(
  areSourceDocumentTransitionsEquivalent(
    linkSrcBefore,
    linkSrcAfter,
    linkCanBefore,
    document(linkCanBefore.firstChild, paragraph(text('错误一行')))
  ),
  false,
  'a different append on one side must still fail closed'
)

// 3. Strong-split asymmetry (serializer splits one styled run into several):
//    a structural edit next to it must pass.
const splitSrcBefore = document(paragraph([text('第一段')]))
const splitCanBefore = document(paragraph([text('第'), text('一', [strong()]), text('段')]))
const splitSrcAfter = document(paragraph([text('第一段')]), heading(text('标题二')))
const splitCanAfter = document(
  paragraph([text('第'), text('一', [strong()]), text('段')]),
  heading(text('标题二'))
)
assert.equal(
  areSourceDocumentTransitionsEquivalent(splitSrcBefore, splitSrcAfter, splitCanBefore, splitCanAfter),
  true,
  'a block insert across a strong-split asymmetry must pass the transition proof'
)

// 4. Block-structure divergence inside the window still fails: the canonical
//    side changed the paragraph to a heading while the source kept a paragraph.
assert.equal(
  areSourceDocumentTransitionsEquivalent(
    splitSrcBefore,
    document(paragraph([text('第一段')]), paragraph(text('标题二'))),
    splitCanBefore,
    splitCanAfter
  ),
  false,
  'a block-type change on one side only must still fail closed'
)

// 5. Mark-form differences ALONE between the two sides are now equivalent in
//    the transition channel — the intended semantics on chronically diverged
//    documents (the strict full-document channel and the list-slot gate keep
//    their exact behavior; see 6/7).
assert.equal(
  areSourceDocumentTransitionsEquivalent(
    document(paragraph([text('甲乙', [strong()])])),
    document(paragraph([text('甲乙', [strong()])]), paragraph(text('尾部'))),
    document(paragraph([text('甲'), text('乙')])),
    document(paragraph([text('甲'), text('乙')]), paragraph(text('尾部')))
  ),
  true,
  'inline form divergence alone must not decide the transition proof'
)

// 6. The strict full-document channel is untouched: marks still compare there.
assert.equal(
  areSourceDocumentsEquivalent(
    document(paragraph([text('甲乙', [strong()])])),
    document(paragraph([text('甲乙')]))
  ),
  false,
  'full-document equivalence must keep comparing marks'
)

// 7. Adjacent-run merging in the strict channel is unchanged (0.13.179).
assert.equal(
  areSourceDocumentsEquivalent(
    document(paragraph([text('甲', [strong()]), text('乙', [strong()])])),
    document(paragraph([text('甲乙', [strong()])]))
  ),
  true,
  'adjacent same-mark text runs still merge in the strict channel'
)

console.log('test-transition-inline-textual: all contracts passed')
