import assert from 'node:assert/strict'

import {
  REVIEW_KINDS,
  applyReviewDecision,
  buildReviewAiPrompt,
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
  assert.equal(wrapReviewSelection('abc', 1, 1, REVIEW_KINDS.comment).text, 'a{>><<}bc')

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
    text: 'a{>><<}bc',
    selectionStart: 4,
    selectionEnd: 4
  })

  assert.deepEqual(wrapReviewSelection('a\nb', 0, 3, REVIEW_KINDS.addition), {
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
  assert.match(prompt, /--- Annotated Markdown ---/)
  assert.ok(prompt.includes(sample))
}

testScanning()
testWrapping()
testDecisions()
testPrompt()

console.log('review-markup tests passed')
