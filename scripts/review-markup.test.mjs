import assert from 'node:assert/strict'

import {
  REVIEW_KINDS,
  applyReviewDecision,
  buildReviewAiPrompt,
  getReviewMarkupDisplayParts,
  normalizeReviewMarkupMarkdown,
  scanReviewMarkup,
  wrapReviewSelection
} from '../src/renderer/src/reviewMarkup.js'

const sample =
  'A {++new++} B {--old--} C {~~bad~>good~~} D {>>note<<} E {==focus==}{>>why<<}'

function testScanning() {
  const markers = scanReviewMarkup(sample)

  assert.deepEqual(
    markers.map(({ kind, raw }) => ({ kind, raw })),
    [
      { kind: REVIEW_KINDS.addition, raw: '{++new++}' },
      { kind: REVIEW_KINDS.deletion, raw: '{--old--}' },
      { kind: REVIEW_KINDS.substitution, raw: '{~~bad~>good~~}' },
      { kind: REVIEW_KINDS.comment, raw: '{>>note<<}' },
      { kind: REVIEW_KINDS.highlight, raw: '{==focus==}{>>why<<}' }
    ]
  )

  assert.deepEqual(
    markers.map(({ content }) => content),
    [
      { text: 'new' },
      { text: 'old' },
      { oldText: 'bad', newText: 'good' },
      { text: 'note' },
      { text: 'focus', comment: 'why' }
    ]
  )
}

function testWrapping() {
  assert.equal(wrapReviewSelection('abc', 1, 2, REVIEW_KINDS.addition).text, 'a{++b++}c')
  assert.equal(wrapReviewSelection('abc', 1, 2, REVIEW_KINDS.deletion).text, 'a{--b--}c')
  assert.equal(wrapReviewSelection('abc', 1, 2, REVIEW_KINDS.substitution).text, 'a{~~b~>~~}c')
  assert.equal(wrapReviewSelection('abc', 1, 2, REVIEW_KINDS.highlight).text, 'a{==b==}{>><<}c')

  assert.deepEqual(wrapReviewSelection('abc', 1, 2, REVIEW_KINDS.addition), {
    text: 'a{++b++}c',
    selectionStart: 4,
    selectionEnd: 5
  })
  assert.deepEqual(wrapReviewSelection('abc', 1, 2, REVIEW_KINDS.deletion), {
    text: 'a{--b--}c',
    selectionStart: 4,
    selectionEnd: 5
  })
  assert.deepEqual(wrapReviewSelection('abc', 1, 2, REVIEW_KINDS.substitution), {
    text: 'a{~~b~>~~}c',
    selectionStart: 7,
    selectionEnd: 7
  })
  assert.deepEqual(wrapReviewSelection('abc', 1, 2, REVIEW_KINDS.highlight), {
    text: 'a{==b==}{>><<}c',
    selectionStart: 11,
    selectionEnd: 11
  })
  assert.deepEqual(wrapReviewSelection('abc', 1, 1, REVIEW_KINDS.comment), {
    error: 'kind'
  })
  assert.deepEqual(wrapReviewSelection('abcd', 1, 3, REVIEW_KINDS.comment), {
    error: 'kind'
  })

  assert.deepEqual(wrapReviewSelection('a\nb', 0, 3, REVIEW_KINDS.addition), {
    error: 'multiline'
  })
  assert.deepEqual(wrapReviewSelection('a\nb', 0, 3, REVIEW_KINDS.substitution), {
    error: 'multiline'
  })
  assert.deepEqual(wrapReviewSelection('a\nb', 0, 3, REVIEW_KINDS.highlight), {
    error: 'multiline'
  })
}

function testDecisions() {
  assert.equal(applyReviewDecision(sample, 'accept'), 'A new B  C good D  E focus')
  assert.equal(applyReviewDecision(sample, 'reject'), 'A  B old C bad D  E focus')
}

function testPrompt() {
  const prompt = buildReviewAiPrompt(sample)

  assert.match(prompt, /Review marker meanings:/)
  assert.match(prompt, /\{\+\+new text\+\+\}.*addition/i)
  assert.doesNotMatch(prompt, /\{>>comment<<\}: reviewer comment/i)
  assert.match(prompt, /--- Annotated Markdown ---/)
  assert.ok(prompt.includes(sample))
}

function testNormalize() {
  assert.equal(
    normalizeReviewMarkupMarkdown('A {~~bad\\~>good~~} edit'),
    'A {~~bad~>good~~} edit'
  )
  assert.equal(
    normalizeReviewMarkupMarkdown('A {~~bad~>good~~} edit'),
    'A {~~bad~>good~~} edit'
  )
}

function simplifyDisplayParts(text, options) {
  return getReviewMarkupDisplayParts(text, options).map((part) => ({
    type: part.type,
    role: part.role,
    start: part.start,
    end: part.end,
    pos: part.pos,
    label: part.label,
    title: part.title
  }))
}

function testDisplayParts() {
  assert.deepEqual(simplifyDisplayParts('{++new++}'), [
    { type: 'syntax', role: 'syntax', start: 0, end: 3, pos: undefined, label: undefined, title: undefined },
    { type: 'content', role: 'addition', start: 3, end: 6, pos: undefined, label: undefined, title: undefined },
    { type: 'syntax', role: 'syntax', start: 6, end: 9, pos: undefined, label: undefined, title: undefined }
  ])

  assert.deepEqual(simplifyDisplayParts('{--old--}'), [
    { type: 'syntax', role: 'syntax', start: 0, end: 3, pos: undefined, label: undefined, title: undefined },
    { type: 'content', role: 'deletion', start: 3, end: 6, pos: undefined, label: undefined, title: undefined },
    { type: 'syntax', role: 'syntax', start: 6, end: 9, pos: undefined, label: undefined, title: undefined }
  ])

  assert.deepEqual(simplifyDisplayParts('{~~old~>new~~}'), [
    { type: 'syntax', role: 'syntax', start: 0, end: 3, pos: undefined, label: undefined, title: undefined },
    { type: 'content', role: 'substitution-old', start: 3, end: 6, pos: undefined, label: undefined, title: undefined },
    { type: 'syntax', role: 'syntax', start: 6, end: 8, pos: undefined, label: undefined, title: undefined },
    { type: 'widget', role: 'substitution-arrow', start: undefined, end: undefined, pos: 8, label: '->', title: undefined },
    { type: 'content', role: 'substitution-new', start: 8, end: 11, pos: undefined, label: undefined, title: undefined },
    { type: 'syntax', role: 'syntax', start: 11, end: 14, pos: undefined, label: undefined, title: undefined }
  ])

  assert.deepEqual(simplifyDisplayParts('{==focus==}{>>why<<}'), [
    { type: 'syntax', role: 'syntax', start: 0, end: 3, pos: undefined, label: undefined, title: undefined },
    { type: 'content', role: 'highlight', start: 3, end: 8, pos: undefined, label: undefined, title: undefined },
    { type: 'syntax', role: 'syntax', start: 8, end: 14, pos: undefined, label: undefined, title: undefined },
    { type: 'widget', role: 'comment-margin', start: undefined, end: undefined, pos: 8, label: undefined, title: 'why' },
    { type: 'syntax', role: 'syntax', start: 14, end: 20, pos: undefined, label: undefined, title: undefined }
  ])

  assert.deepEqual(simplifyDisplayParts('{>>note<<}'), [])

  assert.deepEqual(simplifyDisplayParts('{>><<}'), [])
  assert.deepEqual(simplifyDisplayParts('{~~old~>~~}'), [])
  assert.deepEqual(simplifyDisplayParts('{==focus==}{>><<}'), [])

  assert.deepEqual(simplifyDisplayParts('{>>note<<}', { revealRange: { start: 4, end: 4 } }), [])
  assert.equal(
    simplifyDisplayParts('{>>note<<}', { revealRange: { start: 10, end: 10 } }).length,
    0
  )
}

testScanning()
testWrapping()
testDecisions()
testPrompt()
testNormalize()
testDisplayParts()

console.log('review-markup tests passed')
