import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import {
  CODE_BLOCK_INFO_TRANSACTION_BOUNDARY,
  CODE_BLOCK_INFO_TRANSACTION_FAMILY,
  createCodeBlockInfoTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    heading: { content: 'text*', group: 'block', attrs: { level: { default: 1 } } },
    paragraph: {
      content: 'text*',
      group: 'block',
      attrs: { role: { default: '' } }
    },
    code_block: {
      content: 'text*',
      group: 'block',
      code: true,
      marks: '',
      attrs: {
        language: { default: '' },
        mode: { default: 'stable' }
      }
    },
    text: { group: 'inline' }
  }
})

const remark = unified().use(remarkParse)
const text = (value) => value ? schema.text(value) : null
const heading = (value) => schema.nodes.heading.create({ level: 1 }, text(value))
const paragraph = (value, role = '') => schema.nodes.paragraph.create({ role }, text(value))
const code = (value = '', language = '', mode = 'stable') =>
  schema.nodes.code_block.create({ language, mode }, text(value))
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const topLevelStart = (doc, targetIndex) => {
  let result = null
  doc.forEach((node, offset, index) => {
    if (index === targetIndex) result = offset
  })
  assert.notEqual(result, null)
  return result
}

const owner = createCodeBlockInfoTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ markdown, pmPos, doc }) =>
    pmPosToMarkdownOffset(markdown, pmPos, doc, remark)
})
const journalFactory = createSourceSyncTransactionJournal()

const source = '\uFEFF# Heading\r\n\r\n~~~   js  \r\nalpha\r\n~~~\r\n\r\ntail\r\n'
const canonical = '# Heading\n\n```js\nalpha\n```\n\ntail\n'
const oldDoc = document(heading('Heading'), code('alpha', 'js'), paragraph('tail'))
const codePos = topLevelStart(oldDoc, 1)
let state = EditorState.create({ schema, doc: oldDoc })
const first = state.tr.setNodeAttribute(codePos, 'language', 'Python')
const firstState = state.apply(first)
const second = firstState.tr.setNodeAttribute(codePos, 'language', 'TypeScript')
const secondState = firstState.apply(second)
const nextCanonical = '# Heading\n\n```TypeScript\nalpha\n```\n\ntail\n'
const expected = source.replace('~~~   js  ', '~~~   TypeScript  ')
const snapshot = createSourceSyncSnapshot({
  revision: 11,
  source,
  canonical,
  doc: oldDoc
})
const captured = journalFactory.captureOrAdvance({
  snapshot,
  transactions: [first],
  oldDoc,
  newDoc: firstState.doc
})
assert.equal(captured.ok, true)
const advanced = journalFactory.captureOrAdvance({
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
assert.equal(plan.ok, true, `info plan rejected: ${JSON.stringify(plan)}`)
assert.equal(plan.owner, 'transaction')
assert.equal(plan.family, CODE_BLOCK_INFO_TRANSACTION_FAMILY)
assert.equal(plan.boundary, CODE_BLOCK_INFO_TRANSACTION_BOUNDARY)
assert.equal(plan.result.reason, 'fenced-code-block-info-string-change')
assert.equal(plan.result.markdown, expected)
assert.equal(plan.proof.kind, 'transaction-code-block-info-proof')
assert.equal(plan.proof.chainLength, 2)
assert.deepEqual(plan.proof.transactionJournal.stepNames, ['AttrStep', 'AttrStep'])
assert.equal(plan.proof.previousLanguage, 'js')
assert.equal(plan.proof.nextLanguage, 'TypeScript')
assert.equal(plan.proof.sourceInfo.leading, '   ')
assert.equal(plan.proof.sourceInfo.trailing, '  ')
assert.equal(plan.proof.sourceRange.char, '~')
assert.equal(plan.proof.previousRange.char, '`')

const makePlan = ({
  baseSource = source,
  baseCanonical = canonical,
  baseDoc = oldDoc,
  transaction,
  newState,
  next = nextCanonical,
  callbackDocumentEquivalent = true,
  revision = 12
}) => {
  const localSnapshot = createSourceSyncSnapshot({
    revision,
    source: baseSource,
    canonical: baseCanonical,
    doc: baseDoc
  })
  const journal = journalFactory.captureOrAdvance({
    snapshot: localSnapshot,
    transactions: [transaction],
    oldDoc: baseDoc,
    newDoc: newState.doc
  }).checkpoint
  return owner.plan({
    journal,
    activeJournal: journal,
    snapshot: localSnapshot,
    currentSource: baseSource,
    currentCanonical: baseCanonical,
    canonical: next,
    expectedDoc: newState.doc,
    callbackDocumentEquivalent
  })
}

{
  const emptySource = 'before\n\n~~~\nbody\n~~~\n\nafter\n'
  const emptyCanonical = 'before\n\n```\nbody\n```\n\nafter\n'
  const emptyDoc = document(paragraph('before'), code('body', ''), paragraph('after'))
  const emptyState = EditorState.create({ schema, doc: emptyDoc })
  const pos = topLevelStart(emptyDoc, 1)
  const tr = emptyState.tr.setNodeAttribute(pos, 'language', 'Python')
  const nextState = emptyState.apply(tr)
  const result = makePlan({
    baseSource: emptySource,
    baseCanonical: emptyCanonical,
    baseDoc: emptyDoc,
    transaction: tr,
    newState: nextState,
    next: 'before\n\n```Python\nbody\n```\n\nafter\n',
    revision: 13
  })
  assert.equal(result.ok, true)
  assert.equal(result.result.markdown, 'before\n\n~~~Python\nbody\n~~~\n\nafter\n')
}

{
  const clearState = EditorState.create({ schema, doc: oldDoc })
  const tr = clearState.tr.setNodeAttribute(codePos, 'language', '')
  const nextState = clearState.apply(tr)
  const result = makePlan({
    transaction: tr,
    newState: nextState,
    next: '# Heading\n\n```\nalpha\n```\n\ntail\n',
    revision: 14
  })
  assert.equal(result.ok, true)
  assert.equal(result.result.markdown, source.replace('~~~   js  ', '~~~     '))
}

{
  const stateWithContent = EditorState.create({ schema, doc: oldDoc })
  const tr = stateWithContent.tr
    .setNodeAttribute(codePos, 'language', 'Python')
    .insertText('X', codePos + 1 + 'alpha'.length)
  const nextState = stateWithContent.apply(tr)
  const result = makePlan({
    transaction: tr,
    newState: nextState,
    next: '# Heading\n\n```Python\nalphaX\n```\n\ntail\n',
    revision: 15
  })
  assert.equal(result.reason, 'code-block-info-content-changed')
  assert.notEqual(result.recognized, true)
}

{
  const wrongAttrState = EditorState.create({ schema, doc: oldDoc })
  const tr = wrongAttrState.tr.setNodeAttribute(codePos, 'mode', 'changed')
  const nextState = wrongAttrState.apply(tr)
  assert.equal(makePlan({
    transaction: tr,
    newState: nextState,
    next: canonical,
    revision: 16
  }).reason, 'code-block-info-non-language-attrs-changed')
}

for (const value of ['Type Script', 'bad`lang', 'line\nbreak']) {
  const invalidState = EditorState.create({ schema, doc: oldDoc })
  const tr = invalidState.tr.setNodeAttribute(codePos, 'language', value)
  const nextState = invalidState.apply(tr)
  assert.equal(makePlan({
    transaction: tr,
    newState: nextState,
    next: nextCanonical,
    revision: 17 + value.length
  }).reason, 'code-block-info-language-invalid')
}

{
  const metadataSource = source.replace('~~~   js  ', '~~~js title=demo')
  const metadataState = EditorState.create({ schema, doc: oldDoc })
  const tr = metadataState.tr.setNodeAttribute(codePos, 'language', 'Python')
  const nextState = metadataState.apply(tr)
  const result = makePlan({
    baseSource: metadataSource,
    transaction: tr,
    newState: nextState,
    next: '# Heading\n\n```Python\nalpha\n```\n\ntail\n',
    revision: 30
  })
  assert.equal(result.reason, 'code-block-info-source-not-language-only')
  assert.equal(result.recognized, true)
}

{
  const mismatchSource = source.replace('~~~   js  ', '~~~   ts  ')
  const mismatchState = EditorState.create({ schema, doc: oldDoc })
  const tr = mismatchState.tr.setNodeAttribute(codePos, 'language', 'Python')
  const nextState = mismatchState.apply(tr)
  assert.equal(makePlan({
    baseSource: mismatchSource,
    transaction: tr,
    newState: nextState,
    next: '# Heading\n\n```Python\nalpha\n```\n\ntail\n',
    revision: 31
  }).reason, 'code-block-info-language-source-mismatch')
}

{
  const neighbourState = EditorState.create({ schema, doc: oldDoc })
  const tailPos = topLevelStart(oldDoc, 2) + 1
  const tr = neighbourState.tr
    .setNodeAttribute(codePos, 'language', 'Python')
    .insertText('!', tailPos + 'tail'.length)
  const nextState = neighbourState.apply(tr)
  assert.equal(makePlan({
    transaction: tr,
    newState: nextState,
    next: '# Heading\n\n```Python\nalpha\n```\n\ntail!\n',
    revision: 32
  }).reason, 'code-block-info-top-level-change-count')
}

const callbackMismatch = owner.plan({
  journal: advanced.checkpoint,
  activeJournal: advanced.checkpoint,
  snapshot,
  currentSource: source,
  currentCanonical: canonical,
  canonical: nextCanonical,
  expectedDoc: secondState.doc,
  callbackDocumentEquivalent: false
})
assert.equal(callbackMismatch.reason, 'code-block-info-callback-document-mismatch')
assert.notEqual(callbackMismatch.recognized, true)

const staleSnapshot = createSourceSyncSnapshot({
  revision: 99,
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

console.log('PASS code block info transaction owner: AttrStep journal preserves authored fence/padding/BOM/CRLF, supports add/change/clear and rejects content, metadata, invalid language, neighbours and stale snapshots')
