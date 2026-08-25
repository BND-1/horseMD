import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import {
  TRANSACTION_FIRST_MODES,
  advanceTransactionFirstSourceSync,
  buildPlainParagraphSourceRangeMap,
  reconcileTransactionFirstSourceSync
} from '../src/renderer/src/lib/transaction-first-source-sync.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' }
  }
})

const remark = unified().use(remarkParse)
const paragraph = (value) => schema.node('paragraph', null, value ? schema.text(value) : null)
const doc = (...blocks) => schema.node('doc', null, blocks)

const contentStartOf = (pmDoc, value) => {
  let found = null
  pmDoc.descendants((node, pos) => {
    if (found != null) return false
    if (node.type.name === 'paragraph' && node.textContent === value) {
      found = pos + 1
      return false
    }
    return true
  })
  assert.notEqual(found, null, `missing paragraph: ${value}`)
  return found
}

const buildRangeMap = ({ source, doc }) =>
  buildPlainParagraphSourceRangeMap({ source, doc, remark })

const source = 'alpha\n\nrepeat\n\nomega\n'
const initialDoc = doc(paragraph('alpha'), paragraph('repeat'), paragraph('omega'))
const initialState = EditorState.create({ schema, doc: initialDoc })
const repeatStart = contentStartOf(initialDoc, 'repeat')

const firstTransaction = initialState.tr.insertText('X', repeatStart + 3)
const firstState = initialState.apply(firstTransaction)
const firstExpected = 'alpha\n\nrepXeat\n\nomega\n'

const secondStart = contentStartOf(firstState.doc, 'repXeat')
const secondTransaction = firstState.tr.insertText('Y', secondStart + 4)
const secondState = firstState.apply(secondTransaction)
const secondExpected = 'alpha\n\nrepXYeat\n\nomega\n'

const validateTwoStep = (markdown, expectedDoc) => {
  if (expectedDoc?.eq?.(firstState.doc)) return markdown === firstExpected
  if (expectedDoc?.eq?.(secondState.doc)) return markdown === secondExpected
  return false
}

const firstCheckpoint = advanceTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.SHADOW,
  baselineSource: source,
  transactions: [firstTransaction],
  oldState: initialState,
  newState: firstState,
  buildSourceRangeMap: buildRangeMap,
  validateMarkdown: validateTwoStep
})

assert.equal(firstCheckpoint.ownership, 'owned')
assert.equal(firstCheckpoint.family, 'plain-paragraph-inline-replace')
assert.equal(firstCheckpoint.baselineSource, source)
assert.equal(firstCheckpoint.transaction.markdown, firstExpected)
assert.equal(firstCheckpoint.chainLength, 1)
assert.deepEqual(firstCheckpoint.chainReasons, ['plain-text-transactions'])

const secondCheckpoint = advanceTransactionFirstSourceSync({
  checkpoint: firstCheckpoint,
  mode: TRANSACTION_FIRST_MODES.SHADOW,
  baselineSource: source,
  transactions: [secondTransaction],
  oldState: firstState,
  newState: secondState,
  buildSourceRangeMap: buildRangeMap,
  validateMarkdown: validateTwoStep
})

assert.equal(secondCheckpoint.ownership, 'owned')
assert.equal(secondCheckpoint.family, 'plain-paragraph-inline-replace')
assert.equal(secondCheckpoint.baselineSource, source, 'chain must retain the initial authored baseline')
assert.equal(
  secondCheckpoint.transaction.markdown,
  secondExpected,
  'second transaction must map against the first transaction candidate'
)
assert.equal(secondCheckpoint.chainLength, 2)
assert.deepEqual(secondCheckpoint.stepNames, ['ReplaceStep', 'ReplaceStep'])
assert.deepEqual(secondCheckpoint.chainReasons, ['plain-text-transactions', 'plain-text-transactions'])

const reconciled = reconcileTransactionFirstSourceSync({
  checkpoint: secondCheckpoint,
  currentSource: source,
  currentDoc: secondState.doc,
  legacyResult: { markdown: secondExpected, reason: 'legacy-fixture' }
})
assert.equal(reconciled.comparison, 'byte-equal')
assert.equal(reconciled.promotionEligible, true)
assert.equal(reconciled.publication.owner, 'legacy', 'shadow chain must remain behavior-neutral')

// Mirror real typing over a selection: the first committed character replaces
// the selection, the second character is a separate PM transaction before the
// deferred Markdown callback.
const alphaStart = contentStartOf(initialDoc, 'alpha')
const replacementFirstTransaction = initialState.tr.insertText('Z', alphaStart + 1, alphaStart + 3)
const replacementFirstState = initialState.apply(replacementFirstTransaction)
const replacementFirstExpected = 'aZha\n\nrepeat\n\nomega\n'
const replacementSecondStart = contentStartOf(replacementFirstState.doc, 'aZha')
const replacementSecondTransaction = replacementFirstState.tr.insertText('Z', replacementSecondStart + 2)
const replacementSecondState = replacementFirstState.apply(replacementSecondTransaction)
const replacementSecondExpected = 'aZZha\n\nrepeat\n\nomega\n'

const validateReplacement = (markdown, expectedDoc) => {
  if (expectedDoc?.eq?.(replacementFirstState.doc)) return markdown === replacementFirstExpected
  if (expectedDoc?.eq?.(replacementSecondState.doc)) return markdown === replacementSecondExpected
  return false
}

const replacementFirstCheckpoint = advanceTransactionFirstSourceSync({
  baselineSource: source,
  transactions: [replacementFirstTransaction],
  oldState: initialState,
  newState: replacementFirstState,
  buildSourceRangeMap: buildRangeMap,
  validateMarkdown: validateReplacement
})
const replacementSecondCheckpoint = advanceTransactionFirstSourceSync({
  checkpoint: replacementFirstCheckpoint,
  baselineSource: source,
  transactions: [replacementSecondTransaction],
  oldState: replacementFirstState,
  newState: replacementSecondState,
  buildSourceRangeMap: buildRangeMap,
  validateMarkdown: validateReplacement
})

assert.equal(replacementSecondCheckpoint.ownership, 'owned')
assert.equal(replacementSecondCheckpoint.chainLength, 2)
assert.equal(replacementSecondCheckpoint.transaction.markdown, replacementSecondExpected)
assert.equal(replacementSecondCheckpoint.baselineSource, source)

// An unsupported member makes the complete pending chain non-promotable.
const syntaxTransaction = firstState.tr.insertText('*', secondStart + 2)
const syntaxState = firstState.apply(syntaxTransaction)
const rejectedMember = advanceTransactionFirstSourceSync({
  checkpoint: firstCheckpoint,
  baselineSource: source,
  transactions: [syntaxTransaction],
  oldState: firstState,
  newState: syntaxState,
  buildSourceRangeMap: buildRangeMap,
  validateMarkdown: () => true
})
assert.equal(rejectedMember.ownership, 'rejected')
assert.equal(rejectedMember.transaction.reason, 'syntax-sensitive-insert')
assert.equal(rejectedMember.family, null)
assert.equal(rejectedMember.chainLength, 2)

const afterRejectedTransaction = syntaxState.tr.insertText('Q', contentStartOf(syntaxState.doc, 're* pXeat'.replace(' ', '')) + 1)
const afterRejectedState = syntaxState.apply(afterRejectedTransaction)
const priorRejected = advanceTransactionFirstSourceSync({
  checkpoint: rejectedMember,
  baselineSource: source,
  transactions: [afterRejectedTransaction],
  oldState: syntaxState,
  newState: afterRejectedState,
  buildSourceRangeMap: buildRangeMap,
  validateMarkdown: () => true
})
assert.equal(priorRejected.ownership, 'rejected')
assert.equal(priorRejected.transaction.reason, 'shadow-chain-prior-rejected')
assert.equal(priorRejected.chainLength, 3)

const documentGap = advanceTransactionFirstSourceSync({
  checkpoint: firstCheckpoint,
  baselineSource: source,
  transactions: [firstTransaction],
  oldState: initialState,
  newState: firstState,
  buildSourceRangeMap: buildRangeMap,
  validateMarkdown: () => true
})
assert.equal(documentGap.ownership, 'rejected')
assert.equal(documentGap.transaction.reason, 'shadow-chain-document-gap')

const baselineChanged = advanceTransactionFirstSourceSync({
  checkpoint: firstCheckpoint,
  baselineSource: `${source}external`,
  transactions: [secondTransaction],
  oldState: firstState,
  newState: secondState,
  buildSourceRangeMap: buildRangeMap,
  validateMarkdown: () => true
})
assert.equal(baselineChanged.ownership, 'rejected')
assert.equal(baselineChanged.transaction.reason, 'shadow-chain-baseline-changed')

const mapFailed = advanceTransactionFirstSourceSync({
  checkpoint: firstCheckpoint,
  baselineSource: source,
  transactions: [secondTransaction],
  oldState: firstState,
  newState: secondState,
  buildSourceRangeMap: () => ({ ok: false, reason: 'fixture-map-failed' }),
  validateMarkdown: () => true
})
assert.equal(mapFailed.ownership, 'rejected')
assert.equal(mapFailed.transaction.reason, 'shadow-chain-source-map-failed')

globalThis.__hmTransactionFirstTrace = []
reconcileTransactionFirstSourceSync({
  checkpoint: secondCheckpoint,
  currentSource: source,
  currentDoc: secondState.doc,
  legacyResult: { markdown: secondExpected, reason: 'legacy-fixture' }
})
const trace = globalThis.__hmTransactionFirstTrace.at(-1)
assert.equal(trace.chainLength, 2)
assert.deepEqual(trace.chainReasons, ['plain-text-transactions', 'plain-text-transactions'])
assert.equal(trace.transactionFamily, 'plain-paragraph-inline-replace')
assert.equal(trace.publicationOwner, 'legacy')
assert.equal('markdown' in trace, false, 'chain telemetry must not include full Markdown bytes')
delete globalThis.__hmTransactionFirstTrace

console.log('PASS transaction-first shadow chain: rapid owned edits accumulate; rejected/gapped chains fail closed')
