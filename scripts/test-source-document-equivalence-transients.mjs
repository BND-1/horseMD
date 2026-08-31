import assert from 'node:assert/strict'
import { areSourceDocumentsEquivalent } from '../src/renderer/src/lib/source-transaction-sync.js'
import { sourceSyncSemanticOptionsFromContext } from '../src/renderer/src/lib/source-sync/validator.js'

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
assert.equal(
  areSourceDocumentsEquivalent(
    quoteDoc([paragraph()]),
    quoteEmptyPrevious,
    { ignoreTrailingEmptyBlockquoteParagraphPaths: [[0]] }
  ),
  false,
  'owned quote path must not activate after an empty previous sibling'
)

// The validator derives active transient paths from the inherited semantic
// context. Activation must mirror the semantic rule: a trailing empty RUN
// (≥1 paragraphs) after a nonempty text paragraph OR a list — and nothing
// wider.
const activePaths = (doc, paths) =>
  sourceSyncSemanticOptionsFromContext({ trailingEmptyBlockquoteParagraphPaths: paths }, doc)
    .ignoreTrailingEmptyBlockquoteParagraphPaths
assert.deepEqual(
  activePaths(quoteWithTextPrevious, [[0]]),
  [[0]],
  'text-previous emptied quote paragraph must stay an active transient path'
)
assert.deepEqual(
  activePaths(quoteWithListPrevious, [[0]]),
  [[0]],
  'list-previous quote paragraph keeps the list-exit transient path active'
)
assert.deepEqual(
  activePaths(quoteTwoTrailingEmpties, [[0]]),
  [[0]],
  'a consecutive empty RUN (E0 P3d) stays an active transient path'
)
assert.deepEqual(
  activePaths(quoteSingleChild, [[0]]),
  [],
  'a single-child quote has no provable transient topology'
)
assert.deepEqual(
  activePaths(quoteEmptyPrevious, [[0]]),
  [],
  'an empty previous sibling must deactivate the transient path'
)
assert.deepEqual(
  activePaths(quoteWithTextPrevious, [['x']]),
  [],
  'non-integer paths stay rejected'
)

// E0 P3d: the proof-owned path collapses the WHOLE consecutive trailing
// empty run; the legacy boolean stays exactly-one.
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
assert.equal(
  areSourceDocumentsEquivalent(
    quoteOnlyText,
    quoteTwoTrailingEmpties,
    { ignoreTrailingEmptyBlockquoteParagraph: true }
  ),
  false,
  'legacy boolean must keep collapsing exactly one trailing empty'
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
assert.deepEqual(
  activePaths(quoteSingleChild, [[0]]),
  [],
  'a single-child quote has no provable transient topology'
)
assert.deepEqual(
  activePaths(quoteEmptyPrevious, [[0]]),
  [],
  'an empty previous sibling must deactivate the transient path'
)
assert.deepEqual(
  activePaths(quoteWithTextPrevious, [['x']]),
  [],
  'non-integer paths stay rejected'
)

console.log('PASS source document equivalence transient option stays narrow')
