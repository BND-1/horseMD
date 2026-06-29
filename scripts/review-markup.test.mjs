import assert from 'node:assert/strict'

import {
  REVIEW_KINDS,
  applyReviewDecision,
  buildReviewAiPrompt,
  buildReviewAiPromptForSnippet,
  getReviewMarkupDisplayParts,
  makeHighlightCommentMarkup,
  normalizeReviewMarkupMarkdown,
  removeReviewMarker,
  replaceReviewMarker,
  scanReviewMarkup,
  wrapReviewSelection
} from '../src/renderer/src/reviewMarkup.js'
import {
  cycleReviewGroupActiveIndex,
  getReviewGroupRemovalMeta,
  groupReviewAnnotationParts,
  mapReviewTextblockGroupState,
  parseParsedHighlightCommentClose,
  resolveReviewGroupActiveIndex
} from '../src/renderer/src/components/editor-review.js'
import { HIGHLIGHT_RE } from '../src/renderer/src/components/editor-highlight.js'

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
  assert.equal(
    wrapReviewSelection('a focus b', 1, 8, REVIEW_KINDS.highlight).text,
    'a {==focus==}{>><<} b'
  )

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
  assert.deepEqual(wrapReviewSelection('a focus b', 1, 8, REVIEW_KINDS.highlight), {
    text: 'a {==focus==}{>><<} b',
    selectionStart: 16,
    selectionEnd: 16
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

function testMakeHighlightCommentMarkup() {
  assert.equal(
    makeHighlightCommentMarkup('important text', 'explain why'),
    '{==important text==}{>>explain why<<}'
  )
  assert.equal(
    makeHighlightCommentMarkup(' important text ', 'explain why'),
    ' {==important text==}{>>explain why<<} '
  )

  assert.throws(
    () => makeHighlightCommentMarkup('important text', 'unsafe <<} comment'),
    /Unsafe highlight-comment field/
  )
  assert.throws(
    () => makeHighlightCommentMarkup('unsafe ==}{>> text', 'explain why'),
    /Unsafe highlight-comment field/
  )
  assert.throws(
    () => makeHighlightCommentMarkup('first line\nsecond line', 'explain why'),
    /Unsafe highlight-comment field/
  )
  assert.throws(
    () => makeHighlightCommentMarkup('important text', 'first line\nsecond line'),
    /Unsafe highlight-comment field/
  )
}

function testReplaceReviewMarker() {
  const markdown = 'A {++new++} B {==focus==}{>>why<<} C'
  const markers = scanReviewMarkup(markdown)
  const addition = markers.find((marker) => marker.kind === REVIEW_KINDS.addition)
  const highlight = markers.find((marker) => marker.kind === REVIEW_KINDS.highlight)

  assert.equal(
    replaceReviewMarker(markdown, highlight, { text: 'scope', comment: 'because' }),
    'A {++new++} B {==scope==}{>>because<<} C'
  )
  assert.equal(replaceReviewMarker(markdown, addition, { text: 'ignored' }), markdown)

  assert.equal(
    replaceReviewMarker(`prefix ${markdown}`, highlight, { text: 'scope', comment: 'because' }),
    `prefix ${markdown}`
  )
}

function testRemoveReviewMarker() {
  const markdown = 'A {++new++} B {--old--} C {~~bad~>good~~} D {>>note<<} E {==focus==}{>>why<<} F'
  const markers = scanReviewMarkup(markdown)

  assert.equal(
    removeReviewMarker(
      markdown,
      markers.find((marker) => marker.kind === REVIEW_KINDS.highlight)
    ),
    'A {++new++} B {--old--} C {~~bad~>good~~} D {>>note<<} E focus F'
  )
  assert.equal(
    removeReviewMarker(
      markdown,
      markers.find((marker) => marker.kind === REVIEW_KINDS.addition)
    ),
    'A new B {--old--} C {~~bad~>good~~} D {>>note<<} E {==focus==}{>>why<<} F'
  )
  assert.equal(
    removeReviewMarker(
      markdown,
      markers.find((marker) => marker.kind === REVIEW_KINDS.deletion)
    ),
    'A {++new++} B  C {~~bad~>good~~} D {>>note<<} E {==focus==}{>>why<<} F'
  )
  assert.equal(
    removeReviewMarker(
      markdown,
      markers.find((marker) => marker.kind === REVIEW_KINDS.substitution)
    ),
    'A {++new++} B {--old--} C good D {>>note<<} E {==focus==}{>>why<<} F'
  )
  assert.equal(
    removeReviewMarker(
      markdown,
      markers.find((marker) => marker.kind === REVIEW_KINDS.comment)
    ),
    'A {++new++} B {--old--} C {~~bad~>good~~} D  E {==focus==}{>>why<<} F'
  )

  assert.equal(
    removeReviewMarker(
      `prefix ${markdown}`,
      markers.find((marker) => marker.kind === REVIEW_KINDS.highlight)
    ),
    `prefix ${markdown}`
  )
}

function testSnippetPrompt() {
  const snippet = 'E {==focus==}{>>why<<}'
  const prompt = buildReviewAiPromptForSnippet(snippet, 'paragraph')

  assert.match(prompt, /Review marker meanings:/)
  assert.match(prompt, /\{\+\+new text\+\+\}.*addition/i)
  assert.doesNotMatch(prompt, /\{>>comment<<\}: reviewer comment/i)
  assert.match(prompt, /--- Scoped Snippet \(paragraph\) ---/)
  assert.ok(prompt.includes(snippet))
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
  assert.equal(
    normalizeReviewMarkupMarkdown('A {== focus ==}{>>why<<} B'),
    'A  {==focus==}{>>why<<}  B'
  )
  assert.equal(
    normalizeReviewMarkupMarkdown('A {==focus ==}{>>why<<} B {== next==}{>>ok<<}'),
    'A {==focus==}{>>why<<}  B  {==next==}{>>ok<<}'
  )
}

function testNativeHighlightDoesNotConsumeReviewMarkup() {
  const matches = [...'Normal ==highlight== text'.matchAll(HIGHLIGHT_RE)]
  assert.deepEqual(
    matches.map((match) => ({ raw: match[0], content: match[2] })),
    [{ raw: '==highlight==', content: 'highlight' }]
  )

  const reviewParagraph =
    "Here's {==a taste of what==}{>>111<<} renders live. Another {==marked phrase==}{>>222<<} appears."
  assert.deepEqual([...reviewParagraph.matchAll(HIGHLIGHT_RE)], [])
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

function testReviewAnnotationGrouping() {
  const grouped = groupReviewAnnotationParts([
    {
      pos: 12,
      part: {
        type: 'widget',
        role: 'comment-margin',
        groupKey: 'paragraph:1',
        title: 'second',
        annotation: { key: 'b', from: 12, to: 20, text: 'two', comment: 'second' }
      }
    },
    {
      pos: 8,
      part: {
        type: 'widget',
        role: 'comment-margin',
        groupKey: 'paragraph:1',
        title: 'first',
        annotation: { key: 'a', from: 8, to: 11, text: 'one', comment: 'first' }
      }
    },
    {
      pos: 30,
      part: {
        type: 'widget',
        role: 'substitution-replacement',
        oldText: 'old',
        newText: 'new'
      }
    },
    {
      pos: 42,
      part: {
        type: 'widget',
        role: 'comment-margin',
        groupKey: 'paragraph:40',
        title: 'third',
        annotation: { key: 'c', from: 42, to: 50, text: 'three', comment: 'third' }
      }
    }
  ])

  const reviewGroups = grouped.filter(({ part }) => part.role === 'comment-margin')
  assert.equal(reviewGroups.length, 2)
  assert.equal(reviewGroups[0].pos, 8)
  assert.equal(reviewGroups[0].part.groupKey, 'paragraph:1')
  assert.equal(reviewGroups[0].part.label, '2')
  assert.deepEqual(reviewGroups[0].part.annotations.map((annotation) => annotation.key), ['a', 'b'])
  assert.equal(reviewGroups[1].part.label, '1')
  assert.deepEqual(reviewGroups[1].part.annotations.map((annotation) => annotation.key), ['c'])

  assert.equal(grouped.some(({ part }) => part.role === 'substitution-replacement'), true)
}

function testReviewGroupActiveIndex() {
  const annotations = [{ key: 'a' }, { key: 'b' }, { key: 'c' }]

  assert.equal(resolveReviewGroupActiveIndex(annotations, 'b', 0), 1)
  assert.equal(resolveReviewGroupActiveIndex(annotations, 'missing', 2), 2)
  assert.equal(resolveReviewGroupActiveIndex(annotations, 'missing', 9), 2)
  assert.equal(resolveReviewGroupActiveIndex(annotations, 'missing', -4), 0)
  assert.equal(resolveReviewGroupActiveIndex([], 'missing', 1), -1)

  assert.equal(cycleReviewGroupActiveIndex(0, annotations.length, 1), 1)
  assert.equal(cycleReviewGroupActiveIndex(2, annotations.length, 1), 0)
  assert.equal(cycleReviewGroupActiveIndex(0, annotations.length, -1), 2)
  assert.equal(cycleReviewGroupActiveIndex(2, annotations.length, -1), 1)
  assert.equal(cycleReviewGroupActiveIndex(5, annotations.length, 1), 0)
  assert.equal(cycleReviewGroupActiveIndex(0, 0, 1), -1)
}

function testReviewGroupStateMapping() {
  const state = { openGroupKey: 'textblock:10', activeKey: 'old-position-key', activeIndex: 2 }
  const mapping = {
    mapResult(pos, assoc) {
      assert.equal(pos, 10)
      assert.equal(assoc, -1)
      return { pos: 14, deleted: false }
    }
  }

  assert.deepEqual(mapReviewTextblockGroupState(state, mapping, 50), {
    openGroupKey: 'textblock:14',
    activeKey: 'old-position-key',
    activeIndex: 2
  })

  assert.deepEqual(
    mapReviewTextblockGroupState(state, { mapResult: () => ({ pos: 14, deleted: true }) }, 50),
    { openGroupKey: null, activeKey: null, activeIndex: 0 }
  )
  assert.deepEqual(
    mapReviewTextblockGroupState(state, { mapResult: () => ({ pos: 99, deleted: false }) }, 50),
    { openGroupKey: null, activeKey: null, activeIndex: 0 }
  )
  assert.deepEqual(
    mapReviewTextblockGroupState({ openGroupKey: null, activeKey: 'x', activeIndex: 1 }, mapping, 50),
    { openGroupKey: null, activeKey: null, activeIndex: 0 }
  )
}

function testReviewGroupRemovalMeta() {
  assert.deepEqual(
    getReviewGroupRemovalMeta({
      groupKey: 'textblock:10',
      activeIndex: 2,
      annotations: [{ key: 'a' }, { key: 'b' }, { key: 'c' }]
    }),
    {
      type: 'activate',
      groupKey: 'textblock:10',
      activeKey: null,
      activeIndex: 1
    }
  )
  assert.deepEqual(
    getReviewGroupRemovalMeta({
      groupKey: 'textblock:10',
      activeIndex: 0,
      annotations: [{ key: 'a' }, { key: 'b' }, { key: 'c' }]
    }),
    {
      type: 'activate',
      groupKey: 'textblock:10',
      activeKey: null,
      activeIndex: 0
    }
  )
  assert.deepEqual(
    getReviewGroupRemovalMeta({
      groupKey: 'textblock:10',
      activeIndex: 0,
      annotations: [{ key: 'a' }]
    }),
    { type: 'close' }
  )
}

function testParsedHighlightCommentClose() {
  assert.deepEqual(parseParsedHighlightCommentClose('}{>>why<<} after'), {
    leadingText: '',
    comment: 'why',
    length: 10,
    syntaxStart: 0
  })
  assert.deepEqual(parseParsedHighlightCommentClose(' }{>>why<<} after'), {
    leadingText: ' ',
    comment: 'why',
    length: 11,
    syntaxStart: 1
  })
  assert.equal(parseParsedHighlightCommentClose(' not a close'), null)
}

testScanning()
testWrapping()
testDecisions()
testPrompt()
testMakeHighlightCommentMarkup()
testReplaceReviewMarker()
testRemoveReviewMarker()
testSnippetPrompt()
testNormalize()
testNativeHighlightDoesNotConsumeReviewMarkup()
testDisplayParts()
testReviewAnnotationGrouping()
testReviewGroupActiveIndex()
testReviewGroupStateMapping()
testReviewGroupRemovalMeta()
testParsedHighlightCommentClose()

console.log('review-markup tests passed')
