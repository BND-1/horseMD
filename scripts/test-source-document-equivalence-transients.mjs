import assert from 'node:assert/strict'
import { areSourceDocumentsEquivalent } from '../src/renderer/src/lib/source-transaction-sync.js'

const node = (json) => ({ toJSON: () => JSON.parse(JSON.stringify(json)) })
const paragraph = (text = '') => text
  ? { type: 'paragraph', content: [{ type: 'text', text }] }
  : { type: 'paragraph' }
const bulletDoc = (itemContent) => node({
  type: 'doc',
  content: [{
    type: 'bullet_list',
    content: [{ type: 'list_item', content: itemContent }]
  }]
})

const authored = bulletDoc([paragraph('啊v擦')])
const oneTransient = bulletDoc([paragraph('啊v擦'), paragraph()])
const twoTransients = bulletDoc([paragraph('啊v擦'), paragraph(), paragraph()])
const nestedThenEmpty = node({
  type: 'doc',
  content: [{
    type: 'bullet_list',
    content: [{
      type: 'list_item',
      content: [
        paragraph('啊v擦'),
        { type: 'bullet_list', content: [{ type: 'list_item', content: [paragraph('child')] }] },
        paragraph()
      ]
    }]
  }]
})
const nestedWithoutEmpty = node({
  type: 'doc',
  content: [{
    type: 'bullet_list',
    content: [{
      type: 'list_item',
      content: [
        paragraph('啊v擦'),
        { type: 'bullet_list', content: [{ type: 'list_item', content: [paragraph('child')] }] }
      ]
    }]
  }]
})

assert.equal(
  areSourceDocumentsEquivalent(authored, oneTransient),
  false,
  'default semantic comparison must keep a trailing list-item paragraph strict'
)
assert.equal(
  areSourceDocumentsEquivalent(authored, oneTransient, { ignoreTrailingEmptyListItemParagraph: true }),
  true,
  'opt-in should ignore exactly one trailing editor-owned empty paragraph after text'
)
assert.equal(
  areSourceDocumentsEquivalent(authored, twoTransients, { ignoreTrailingEmptyListItemParagraph: true }),
  false,
  'opt-in must not hide multiple trailing empty paragraphs'
)
assert.equal(
  areSourceDocumentsEquivalent(nestedWithoutEmpty, nestedThenEmpty, { ignoreTrailingEmptyListItemParagraph: true }),
  false,
  'opt-in must not hide an empty paragraph after nested list structure'
)

// --- Blockquote paragraph-emptied transient (E0 P2, 0.13.169 `> ‘` trace) ---
const quoteDoc = (children) => node({
  type: 'doc',
  content: [{ type: 'blockquote', content: children }]
})
const quoteWithTextPrevious = quoteDoc([paragraph('alpha'), paragraph()])
const quoteWithoutTransient = quoteDoc([paragraph('alpha')])
const quoteWithBreakPrevious = quoteDoc([
  paragraph('alpha'),
  { type: 'paragraph', content: [{ type: 'hardbreak' }] }
])
const quoteWithListPrevious = quoteDoc([
  { type: 'bullet_list', content: [{ type: 'list_item', content: [paragraph('item')] }] },
  paragraph()
])
const quoteWithListPreviousNoTransient = quoteDoc([
  { type: 'bullet_list', content: [{ type: 'list_item', content: [paragraph('item')] }] }
])
const quoteTwoTrailingEmpties = quoteDoc([paragraph('alpha'), paragraph(), paragraph()])
const quoteEmptyPrevious = quoteDoc([paragraph(), paragraph()])
const quoteSingleChild = quoteDoc([paragraph()])

assert.equal(
  areSourceDocumentsEquivalent(quoteWithoutTransient, quoteWithTextPrevious),
  false,
  'default comparison must keep a trailing empty quote paragraph strict'
)
assert.equal(
  areSourceDocumentsEquivalent(
    quoteWithoutTransient,
    quoteWithTextPrevious,
    { ignoreTrailingEmptyBlockquoteParagraphPaths: [[0]] }
  ),
  true,
  'owned quote path should ignore exactly one trailing empty paragraph after a text paragraph'
)
assert.equal(
  areSourceDocumentsEquivalent(
    quoteWithoutTransient,
    quoteWithBreakPrevious,
    { ignoreTrailingEmptyBlockquoteParagraphPaths: [[0]] }
  ),
  true,
  'serializer `<br />` placeholder normalizes to the same transient empty paragraph'
)
assert.equal(
  areSourceDocumentsEquivalent(quoteWithoutTransient, quoteWithListPrevious),
  false,
  'default comparison must keep a trailing empty quote paragraph after a list strict'
)
assert.equal(
  areSourceDocumentsEquivalent(
    quoteWithListPreviousNoTransient,
    quoteWithListPrevious,
    { ignoreTrailingEmptyBlockquoteParagraphPaths: [[0]] }
  ),
  true,
  'owned quote path should ignore one trailing empty paragraph after a list (list-exit transient)'
)
assert.equal(
  areSourceDocumentsEquivalent(
    quoteWithoutTransient,
    quoteTwoTrailingEmpties,
    { ignoreTrailingEmptyBlockquoteParagraphPaths: [[0]] }
  ),
  true,
  // E0 P3d (0.13.171 user trace): repeated Enter over an already-published
  // trailing transient leaves a RUN of editor-owned empty paragraphs; the
  // proof-owned path collapses the whole run (previously exactly-one).
  'owned quote path must collapse a run of trailing empty paragraphs'
)
// A quote cannot encode how many empty paragraphs it holds (`>` is one):
// consecutive empties collapse to one with or without an owned path (fuzz
// seed 1142). So an empty previous sibling no longer keeps the run strict.
assert.equal(
  areSourceDocumentsEquivalent(quoteSingleChild, quoteEmptyPrevious),
  true,
  'consecutive empty quote paragraphs collapse to one by default'
)

// E0 P3d: the proof-owned path collapses the WHOLE consecutive trailing
// empty run.
const quoteOnlyText = quoteDoc([paragraph('alpha')])
assert.equal(
  areSourceDocumentsEquivalent(
    quoteOnlyText,
    quoteTwoTrailingEmpties,
    { ignoreTrailingEmptyBlockquoteParagraphPaths: [[0]] }
  ),
  true,
  'owned path should collapse a run of trailing empty paragraphs'
)
assert.equal(
  areSourceDocumentsEquivalent(quoteOnlyText, quoteTwoTrailingEmpties, {}),
  false,
  'default comparison must keep a multi-empty trailing run strict'
)
// The legacy boolean drops one trailing empty after a TEXT paragraph only.
// (A run of empties is already one by the collapse above, so "exactly one"
// can no longer be observed through consecutive empties.)
assert.equal(
  areSourceDocumentsEquivalent(
    quoteOnlyText,
    quoteWithTextPrevious,
    { ignoreTrailingEmptyBlockquoteParagraph: true }
  ),
  true,
  'legacy boolean collapses one trailing empty after text'
)
assert.equal(
  areSourceDocumentsEquivalent(
    quoteWithListPreviousNoTransient,
    quoteWithListPrevious,
    { ignoreTrailingEmptyBlockquoteParagraph: true }
  ),
  false,
  'legacy boolean must stay strict after a list (only the owned path covers the list-exit transient)'
)
assert.equal(
  areSourceDocumentsEquivalent(
    quoteOnlyText,
    quoteWithTextPrevious,
    { ignoreTrailingEmptyBlockquoteParagraphPaths: [[0]] }
  ),
  true,
  'owned path keeps collapsing a single trailing empty'
)
console.log('PASS source document equivalence: transient options stay narrow; consecutive empty quote paragraphs collapse to one')
