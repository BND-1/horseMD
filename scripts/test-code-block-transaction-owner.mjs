import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import {
  CODE_BLOCK_TRANSACTION_BOUNDARY,
  CODE_BLOCK_TRANSACTION_FAMILY,
  createCodeBlockTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    heading: { content: 'text*', group: 'block', attrs: { level: { default: 1 } } },
    paragraph: { content: 'text*', group: 'block' },
    code_block: {
      content: 'text*',
      group: 'block',
      code: true,
      marks: '',
      attrs: { language: { default: null } }
    },
    text: { group: 'inline' }
  }
})

const remark = unified().use(remarkParse)
const text = (value) => value ? schema.text(value) : null
const heading = (value) => schema.nodes.heading.create({ level: 1 }, text(value))
const paragraph = (value) => schema.nodes.paragraph.create(null, text(value))
const code = (value = '', language = null) =>
  schema.nodes.code_block.create({ language }, text(value))
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const topLevelStart = (doc, targetIndex) => {
  let result = null
  doc.forEach((node, offset, index) => {
    if (index === targetIndex) result = offset
  })
  assert.notEqual(result, null)
  return result
}

const owner = createCodeBlockTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ markdown, pmPos, doc }) =>
    pmPosToMarkdownOffset(markdown, pmPos, doc, remark)
})

const source = '\uFEFF# Heading\r\n\r\n~~~js\r\nalpha\r\n~~~\r\n\r\ntail\r\n'
const canonical = '# Heading\n\n```js\nalpha\n```\n\ntail\n'
const oldDoc = document(heading('Heading'), code('alpha', 'js'), paragraph('tail'))
let state = EditorState.create({ schema, doc: oldDoc })
const codeContentStart = topLevelStart(oldDoc, 1) + 1
const first = state.tr.insertText('X', codeContentStart + 'alpha'.length)
const firstState = state.apply(first)
const second = firstState.tr.insertText('Y', codeContentStart + 'alphaX'.length)
const secondState = firstState.apply(second)
const nextCanonical = '# Heading\n\n```js\nalphaXY\n```\n\ntail\n'
const expected = source.replace('alpha\r\n~~~', 'alphaXY\r\n~~~')
const snapshot = createSourceSyncSnapshot({
  revision: 9,
  source,
  canonical,
  doc: oldDoc
})
const journal = createSourceSyncTransactionJournal()
const captured = journal.captureOrAdvance({
  snapshot,
  transactions: [first],
  oldDoc,
  newDoc: firstState.doc
})
assert.equal(captured.ok, true)
const advanced = journal.captureOrAdvance({
  checkpoint: captured.checkpoint,
  snapshot,
  transactions: [second],
  oldDoc: firstState.doc,
  newDoc: secondState.doc
})
assert.equal(advanced.ok, true)

const plan = owner.plan({
  journal: advanced.checkpoint,
  activeJournal: advanced.checkpoint,
  snapshot,
  currentSource: source,
  currentCanonical: canonical,
  canonical: nextCanonical,
  expectedDoc: secondState.doc,
  callbackDocumentEquivalent: true
})
assert.equal(plan.ok, true, `main code-block plan rejected: ${JSON.stringify(plan)}`)
assert.equal(plan.owner, 'transaction')
assert.equal(plan.family, CODE_BLOCK_TRANSACTION_FAMILY)
assert.equal(plan.boundary, CODE_BLOCK_TRANSACTION_BOUNDARY)
assert.equal(plan.result.reason, 'fenced-code-block-content-change')
assert.equal(plan.result.markdown, expected)
assert.equal(plan.proof.kind, 'transaction-code-block-content-proof')
assert.equal(plan.proof.chainLength, 2)
assert.deepEqual(plan.proof.transactionJournal.stepNames, ['ReplaceStep', 'ReplaceStep'])
assert.equal(plan.proof.topLevelIndex, 1)
assert.equal(plan.proof.sourceRange.char, '~')
assert.equal(plan.proof.previousRange.char, '`')

const emptySource = 'before\n\n```\n\n```\n\nafter\n'
const emptyCanonical = emptySource
const emptyDoc = document(paragraph('before'), code(''), paragraph('after'))
const emptyState = EditorState.create({ schema, doc: emptyDoc })
const emptyStart = topLevelStart(emptyDoc, 1) + 1
const fill = emptyState.tr.insertText('first', emptyStart)
const filledState = emptyState.apply(fill)
const filledCanonical = 'before\n\n```\nfirst\n```\n\nafter\n'
const emptySnapshot = createSourceSyncSnapshot({
  revision: 10,
  source: emptySource,
  canonical: emptyCanonical,
  doc: emptyDoc
})
const emptyJournal = journal.captureOrAdvance({
  snapshot: emptySnapshot,
  transactions: [fill],
  oldDoc: emptyDoc,
  newDoc: filledState.doc
}).checkpoint
const emptyPlan = owner.plan({
  journal: emptyJournal,
  activeJournal: emptyJournal,
  snapshot: emptySnapshot,
  currentSource: emptySource,
  currentCanonical: emptyCanonical,
  canonical: filledCanonical,
  expectedDoc: filledState.doc,
  callbackDocumentEquivalent: true
})
assert.equal(emptyPlan.ok, true)
assert.equal(emptyPlan.result.markdown, filledCanonical)

const outsideState = EditorState.create({ schema, doc: oldDoc })
const tailStart = topLevelStart(oldDoc, 2) + 1
const outside = outsideState.tr.insertText('!', tailStart + 'tail'.length)
const outsideNext = outsideState.apply(outside)
const outsideJournal = journal.captureOrAdvance({
  snapshot,
  transactions: [outside],
  oldDoc,
  newDoc: outsideNext.doc
}).checkpoint
assert.equal(owner.plan({
  journal: outsideJournal,
  activeJournal: outsideJournal,
  snapshot,
  currentSource: source,
  currentCanonical: canonical,
  canonical: '# Heading\n\n```js\nalpha\n```\n\ntail!\n',
  expectedDoc: outsideNext.doc,
  callbackDocumentEquivalent: true
}).reason, 'code-block-top-level-node-type')

const attrsState = EditorState.create({ schema, doc: oldDoc })
const attrs = attrsState.tr.setNodeMarkup(topLevelStart(oldDoc, 1), null, { language: 'ts' })
const attrsNext = attrsState.apply(attrs)
const attrsJournal = journal.captureOrAdvance({
  snapshot,
  transactions: [attrs],
  oldDoc,
  newDoc: attrsNext.doc
}).checkpoint
assert.equal(owner.plan({
  journal: attrsJournal,
  activeJournal: attrsJournal,
  snapshot,
  currentSource: source,
  currentCanonical: canonical,
  canonical: '# Heading\n\n```ts\nalpha\n```\n\ntail\n',
  expectedDoc: attrsNext.doc,
  callbackDocumentEquivalent: true
}).reason, 'code-block-attrs-changed')

const collisionState = EditorState.create({ schema, doc: oldDoc })
const collision = collisionState.tr.insertText('\n~~~', codeContentStart + 'alpha'.length)
const collisionNext = collisionState.apply(collision)
const collisionJournal = journal.captureOrAdvance({
  snapshot,
  transactions: [collision],
  oldDoc,
  newDoc: collisionNext.doc
}).checkpoint
assert.equal(owner.plan({
  journal: collisionJournal,
  activeJournal: collisionJournal,
  snapshot,
  currentSource: source,
  currentCanonical: canonical,
  canonical: '# Heading\n\n```js\nalpha\n~~~\n```\n\ntail\n',
  expectedDoc: collisionNext.doc,
  callbackDocumentEquivalent: true
}).reason, 'code-block-source-fence-collision')

assert.equal(owner.plan({
  journal: advanced.checkpoint,
  activeJournal: advanced.checkpoint,
  snapshot,
  currentSource: source,
  currentCanonical: canonical,
  canonical: nextCanonical,
  expectedDoc: secondState.doc,
  callbackDocumentEquivalent: false
}).reason, 'code-block-callback-document-mismatch')

const staleSnapshot = createSourceSyncSnapshot({
  revision: 10,
  source,
  canonical,
  doc: secondState.doc
})
const stale = owner.plan({
  journal: advanced.checkpoint,
  activeJournal: advanced.checkpoint,
  snapshot: staleSnapshot,
  currentSource: source,
  currentCanonical: canonical,
  canonical: nextCanonical,
  expectedDoc: secondState.doc,
  callbackDocumentEquivalent: true
})
assert.equal(stale.reason, 'transaction-journal-revision-stale')
assert.equal(stale.reset, true)

console.log('PASS code block transaction owner: shared journal owns exact fenced content bytes, preserves source fence/EOL, handles empty fill, and rejects attrs, neighbours, collisions and stale revisions')
