import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import {
  TRANSACTION_FIRST_MODES,
  buildPlainParagraphSourceRangeMap,
  runTransactionFirstSourceSync
} from '../src/renderer/src/lib/transaction-first-source-sync.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block' },
    text: { group: 'inline' }
  },
  marks: {
    em: {}
  }
})

const remark = unified().use(remarkParse)
const text = (value, marks = null) => schema.text(value, marks)
const paragraph = (value, marks = null) => schema.node('paragraph', null, value ? text(value, marks) : null)
const heading = (value) => schema.node('heading', null, text(value))
const doc = (...blocks) => schema.node('doc', null, blocks)

const contentStartOf = (pmDoc, value, occurrence = 0) => {
  let seen = 0
  let found = null
  pmDoc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph' || node.textContent !== value) return true
    if (seen++ === occurrence) found = pos + 1
    return found == null
  })
  assert.notEqual(found, null, `missing paragraph ${value} #${occurrence}`)
  return found
}

const source = 'alpha\n\nrepeat\n\nrepeat\n\nomega\n'
const oldDoc = doc(
  paragraph('alpha'),
  paragraph('repeat'),
  paragraph('repeat'),
  paragraph('omega')
)
const oldState = EditorState.create({ schema, doc: oldDoc })
const sourceMap = buildPlainParagraphSourceRangeMap({ source, doc: oldDoc, remark })
assert.equal(sourceMap.ok, true)
assert.equal(sourceMap.entries.length, 4, 'all simple top-level paragraphs should be mapped')

const secondRepeatStart = contentStartOf(oldDoc, 'repeat', 1)
assert.equal(
  sourceMap.mapPosition(sourceMap.normalizedSource, secondRepeatStart, oldDoc),
  source.lastIndexOf('repeat'),
  'duplicate paragraph text must map by the PM/source snapshot, not to the first textual occurrence'
)

const transaction = oldState.tr.insertText('X', secondRepeatStart + 3)
const newState = oldState.apply(transaction)
const expected = 'alpha\n\nrepeat\n\nrepXeat\n\nomega\n'
const validateExpected = (markdown, expectedDoc) =>
  markdown === expected && expectedDoc?.eq?.(newState.doc) === true

const shadow = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.SHADOW,
  source,
  transactions: [transaction],
  oldState,
  newState,
  sourceRangeMap: sourceMap,
  validateMarkdown: validateExpected,
  legacyResult: { markdown: expected, reason: 'legacy-fixture' }
})
assert.equal(shadow.ownership, 'owned')
assert.equal(shadow.transaction.markdown, expected)
assert.equal(shadow.comparison, 'byte-equal')
assert.equal(shadow.promotionEligible, true)
assert.equal(shadow.publication.owner, 'legacy', 'shadow mode must never publish the transaction candidate')

const observeDivergence = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.OBSERVE,
  source,
  transactions: [transaction],
  oldState,
  newState,
  sourceRangeMap: sourceMap,
  validateMarkdown: validateExpected,
  legacyResult: { markdown: expected.replace('repXeat', 'legacy-different'), reason: 'legacy-fixture' }
})
assert.equal(observeDivergence.comparison, 'byte-diverged')
assert.equal(observeDivergence.promotionEligible, false)
assert.equal(observeDivergence.publication.owner, 'legacy', 'observe mode remains behavior-neutral on divergence')

const authoritative = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.AUTHORITATIVE,
  source,
  transactions: [transaction],
  oldState,
  newState,
  sourceRangeMap: sourceMap,
  validateMarkdown: validateExpected,
  legacyResult: { markdown: expected, reason: 'legacy-fixture' }
})
assert.equal(authoritative.publication.owner, 'transaction')
assert.equal(authoritative.publication.markdown, expected)

const staleMap = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.AUTHORITATIVE,
  source: `${source}tail`,
  transactions: [transaction],
  oldState,
  newState,
  sourceRangeMap: sourceMap,
  validateMarkdown: () => true,
  legacyResult: { markdown: 'legacy-safe', reason: 'legacy-fixture' }
})
assert.equal(staleMap.ownership, 'rejected')
assert.equal(staleMap.transaction.reason, 'stale-source-range-map')
assert.equal(staleMap.publication.owner, 'legacy', 'a stale source map must fail closed to legacy')

const syntaxTransaction = oldState.tr.insertText('*', secondRepeatStart + 2)
const syntaxState = oldState.apply(syntaxTransaction)
const syntaxRejected = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.AUTHORITATIVE,
  source,
  transactions: [syntaxTransaction],
  oldState,
  newState: syntaxState,
  sourceRangeMap: sourceMap,
  validateMarkdown: () => true,
  legacyResult: { markdown: source, reason: 'legacy-fixture' }
})
assert.equal(syntaxRejected.ownership, 'rejected')
assert.equal(syntaxRejected.transaction.reason, 'syntax-sensitive-insert')
assert.equal(syntaxRejected.publication.owner, 'legacy', 'Markdown-sensitive text stays on fallback')

const marked = schema.mark('em')
const markedSource = '*styled*\n\nplain\n'
const markedDoc = doc(paragraph('styled', [marked]), paragraph('plain'))
const markedMap = buildPlainParagraphSourceRangeMap({ source: markedSource, doc: markedDoc, remark })
assert.equal(markedMap.entries.length, 1, 'marked/non-contiguous authored text must be excluded from Phase 0')
assert.equal(markedMap.entries[0].text, 'plain')

const headingSource = '# title\n\nbody\n'
const headingDoc = doc(heading('title'), paragraph('body'))
const headingMap = buildPlainParagraphSourceRangeMap({ source: headingSource, doc: headingDoc, remark })
assert.deepEqual(
  headingMap.entries.map((entry) => entry.text),
  ['body'],
  'Phase 0 source map must not silently expand ownership to headings'
)

const crlfSource = '\uFEFFalpha\r\n\r\nbeta\r\n'
const crlfDoc = doc(paragraph('alpha'), paragraph('beta'))
const crlfState = EditorState.create({ schema, doc: crlfDoc })
const crlfMap = buildPlainParagraphSourceRangeMap({ source: crlfSource, doc: crlfDoc, remark })
assert.equal(crlfMap.ok, true)
assert.equal(crlfMap.normalizedSource, 'alpha\n\nbeta\n')
const betaStart = contentStartOf(crlfDoc, 'beta')
const crlfTransaction = crlfState.tr.insertText('X', betaStart + 2)
const crlfNextState = crlfState.apply(crlfTransaction)
const crlfExpected = '\uFEFFalpha\r\n\r\nbeXta\r\n'
const crlfResult = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.AUTHORITATIVE,
  source: crlfSource,
  transactions: [crlfTransaction],
  oldState: crlfState,
  newState: crlfNextState,
  sourceRangeMap: crlfMap,
  validateMarkdown: (markdown, expectedDoc) =>
    markdown === 'alpha\n\nbeXta\n' && expectedDoc?.eq?.(crlfNextState.doc) === true,
  legacyResult: { markdown: crlfExpected, reason: 'legacy-fixture' }
})
assert.equal(crlfResult.transaction.ok, true)
assert.equal(crlfResult.transaction.markdown, crlfExpected, 'transaction patch must retain authored BOM + CRLF bytes')
assert.equal(crlfResult.publication.markdown, crlfExpected)

console.log('PASS transaction-first source sync phase 0: source-map ownership, shadow rollout, fail-closed syntax, duplicate text, and BOM/CRLF')
