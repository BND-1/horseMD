import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import { mapPlainTextTransactionsToSource } from '../src/renderer/src/lib/source-transaction-sync.js'
import {
  LIST_ITEM_PARAGRAPH_TRANSACTION_BOUNDARY,
  LIST_ITEM_PARAGRAPH_TRANSACTION_FAMILY,
  createListItemParagraphTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal,
  transactionsFromSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 } } },
    list_item: { content: 'paragraph block*', attrs: { checked: { default: null } } },
    text: { group: 'inline' }
  },
  marks: { strong: {} }
})
const remark = unified().use(remarkParse)
const text = (value, marks = null) => value ? schema.text(value, marks || undefined) : null
const paragraph = (value = '', marks = null) => schema.nodes.paragraph.create(null, text(value, marks))
const item = (value, { checked = null, children = null } = {}) => schema.nodes.list_item.create(
  { checked }, children || [paragraph(value)]
)
const bullet = (...items) => schema.nodes.bullet_list.create(null, items)
const ordered = (order, ...items) => schema.nodes.ordered_list.create({ order }, items)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const beforeAtPath = (doc, path) => {
  let parent = doc
  let before = 0
  for (let depth = 0; depth < path.length; depth += 1) {
    let offset = 0
    for (let index = 0; index < path[depth]; index += 1) offset += parent.child(index).nodeSize
    before = depth === 0 ? offset : before + 1 + offset
    parent = parent.child(path[depth])
  }
  return before
}
const textStart = (doc, itemPath, paragraphIndex = 0) =>
  beforeAtPath(doc, [...itemPath, paragraphIndex]) + 1
const journalFactory = createSourceSyncTransactionJournal()
const createOwner = (validateMarkdown = () => true) =>
  createListItemParagraphTransactionSourceSyncOwner({
    resolveMarkdownOffset: ({ markdown, pmPos, doc }) =>
      pmPosToMarkdownOffset(markdown, pmPos, doc, remark),
    validateMarkdown
  })
const capture = ({ source, canonical, oldDoc, transactions, revision = 900 }) => {
  const snapshot = createSourceSyncSnapshot({ revision, source, canonical, doc: oldDoc })
  let checkpoint = null
  let currentDoc = oldDoc
  for (const transaction of transactions) {
    const captured = journalFactory.captureOrAdvance({
      checkpoint,
      snapshot,
      transactions: [transaction],
      oldDoc: currentDoc,
      newDoc: transaction.doc
    })
    assert.equal(captured.ok, true, `journal capture failed: ${JSON.stringify(captured)}`)
    checkpoint = captured.checkpoint
    currentDoc = transaction.doc
  }
  return { snapshot, journal: checkpoint, expectedDoc: currentDoc }
}
const planFor = ({
  source, canonical, oldDoc, transactions, nextCanonical,
  revision = 900, validateMarkdown = () => true,
  callbackDocumentEquivalent = true,
  currentSource = source, currentCanonical = canonical,
  activeJournal = undefined
}) => {
  const captured = capture({ source, canonical, oldDoc, transactions, revision })
  return {
    ...captured,
    plan: createOwner(validateMarkdown).plan({
      journal: captured.journal,
      activeJournal: activeJournal === undefined ? captured.journal : activeJournal,
      snapshot: captured.snapshot,
      currentSource,
      currentCanonical,
      canonical: nextCanonical,
      expectedDoc: captured.expectedDoc,
      callbackDocumentEquivalent,
      boundary: LIST_ITEM_PARAGRAPH_TRANSACTION_BOUNDARY
    })
  }
}

const source = '\uFEFF- 管理层\r\n- 综合行政部\r\n- 4. 技术部\r\n'
const canonical = '* 管理层\n\n* 综合行政部\n\n* 4. 技术部\n'
const oldDoc = document(bullet(item('管理层'), item('综合行政部'), item('4. 技术部')))
const itemPath = [0, 1]
let state = EditorState.create({ schema, doc: oldDoc })
const deletes = []
for (const _character of [...'综合行政部']) {
  const start = textStart(state.doc, itemPath)
  const length = state.doc.child(0).child(1).child(0).textContent.length
  const transaction = state.tr.delete(start + length - 1, start + length)
  deletes.push(transaction)
  state = state.apply(transaction)
}
const emptyCanonical = '* 管理层\n\n* <br />\n\n* 4. 技术部\n'
const expected = '\uFEFF- 管理层\r\n- \r\n- 4. 技术部\r\n'

{
  const captured = capture({ source, canonical, oldDoc, transactions: deletes, revision: 899 })
  assert.equal(captured.snapshot.source, source)
  assert.equal(captured.journal.source, source)
  assert.equal(captured.journal.source.charCodeAt(0), 0xFEFF)
  assert.equal(captured.journal.source.includes('\r\n'), true)
  const mapped = mapPlainTextTransactionsToSource({
    source: captured.journal.source,
    transactions: transactionsFromSourceSyncTransactionJournal(captured.journal),
    oldState: { doc: captured.journal.oldDoc },
    newState: { doc: captured.expectedDoc },
    allowEmptyTextblock: true,
    blockHints: [],
    mapPosition: (markdown, pmPos, doc) =>
      pmPosToMarkdownOffset(markdown, pmPos, doc, remark),
    validateMarkdown: () => true
  })
  assert.equal(mapped.ok, true)
  assert.equal(mapped.markdown, expected,
    `shared mapper lost authored bytes: ${JSON.stringify({
      inputStart: [...source.slice(0, 3)].map((character) => character.charCodeAt(0)),
      outputStart: [...mapped.markdown.slice(0, 3)].map((character) => character.charCodeAt(0)),
      inputHasCrLf: source.includes('\r\n'),
      outputHasCrLf: mapped.markdown.includes('\r\n')
    })}`)

  let validationInput = null
  const { plan } = planFor({
    source, canonical, oldDoc, transactions: deletes,
    nextCanonical: emptyCanonical,
    validateMarkdown: (input) => { validationInput = input; return true }
  })
  assert.equal(plan.ok, true, `empty item plan rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, LIST_ITEM_PARAGRAPH_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, LIST_ITEM_PARAGRAPH_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, 'list-item-paragraph-text-change')
  assert.equal(plan.result.markdown, expected)
  assert.equal(plan.proof.kind, 'transaction-list-item-paragraph-proof')
  assert.deepEqual(plan.proof.nodePath, itemPath)
  assert.deepEqual(plan.proof.listPath, [0])
  assert.equal(plan.proof.previousText, '综合行政部')
  assert.equal(plan.proof.nextText, '')
  assert.equal(plan.proof.emptied, true)
  assert.equal(plan.proof.chainLength, 5)
  assert.deepEqual(plan.proof.transactionJournal.stepNames, Array(5).fill('ReplaceStep'))
  assert.equal(
    validationInput.markdown,
    expected.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'),
    'semantic validator receives the normalized proof view; publication retains raw bytes'
  )
  assert.equal(validationInput.expectedDoc, state.doc)
}

{
  const orderedSource = '2) alpha\r\n3) beta\r\n'
  const orderedCanonical = '2. alpha\n\n3. beta\n'
  const doc = document(ordered(2, item('alpha'), item('beta')))
  const start = textStart(doc, [0, 1])
  const transaction = EditorState.create({ schema, doc }).tr.insertText('X', start + 4)
  const { plan } = planFor({
    source: orderedSource, canonical: orderedCanonical, oldDoc: doc,
    transactions: [transaction], nextCanonical: '2. alpha\n\n3. betaX\n', revision: 901
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.result.markdown, '2) alpha\r\n3) betaX\r\n')
  assert.equal(plan.proof.emptied, false)
  assert.equal(plan.proof.listType, 'ordered_list')
}

{
  const taskDoc = document(bullet(item('task', { checked: false })))
  const start = textStart(taskDoc, [0, 0])
  const transaction = EditorState.create({ schema, doc: taskDoc }).tr.insertText('X', start + 4)
  const { plan } = planFor({
    source: '- [ ] task\n', canonical: '* [ ] task\n', oldDoc: taskDoc,
    transactions: [transaction], nextCanonical: '* [ ] taskX\n', revision: 902
  })
  assert.equal(plan.reason, 'list-item-paragraph-list-or-item-contract')
}

{
  const nestedDoc = document(bullet(item('parent', {
    children: [paragraph('parent'), bullet(item('child'))]
  })))
  const start = textStart(nestedDoc, [0, 0, 1, 0])
  const transaction = EditorState.create({ schema, doc: nestedDoc }).tr.insertText('X', start + 5)
  const { plan } = planFor({
    source: '- parent\n  - child\n', canonical: '* parent\n\n  * child\n', oldDoc: nestedDoc,
    transactions: [transaction], nextCanonical: '* parent\n\n  * childX\n', revision: 903
  })
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /^list-item-paragraph-/)
}

{
  const strong = schema.marks.strong.create()
  const markedDoc = document(bullet(item('marked', { children: [paragraph('marked', [strong])] })))
  const start = textStart(markedDoc, [0, 0])
  const transaction = EditorState.create({ schema, doc: markedDoc }).tr.insertText('X', start + 6)
  const { plan } = planFor({
    source: '- **marked**\n', canonical: '* **marked**\n', oldDoc: markedDoc,
    transactions: [transaction], nextCanonical: '* **markedX**\n', revision: 904
  })
  assert.equal(plan.reason, 'list-item-paragraph-not-simple')
}

{
  const first = textStart(oldDoc, [0, 0])
  const second = textStart(oldDoc, [0, 1])
  const transaction = EditorState.create({ schema, doc: oldDoc }).tr
    .insertText('X', first + 3)
    .insertText('Y', second + 6)
  const { plan } = planFor({
    source, canonical, oldDoc, transactions: [transaction], nextCanonical: canonical, revision: 905
  })
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /^list-item-paragraph-/)
}

{
  const start = textStart(oldDoc, itemPath)
  const split = EditorState.create({ schema, doc: oldDoc }).tr.split(start + 2)
  const { plan } = planFor({
    source, canonical, oldDoc, transactions: [split], nextCanonical: canonical, revision: 906
  })
  assert.equal(plan.reason, 'list-item-paragraph-child-count-changed')
}

{
  const start = textStart(oldDoc, itemPath)
  const sensitive = EditorState.create({ schema, doc: oldDoc }).tr.insertText('*', start + 5)
  const { plan } = planFor({
    source, canonical, oldDoc, transactions: [sensitive], nextCanonical: canonical, revision: 907
  })
  assert.equal(plan.reason, 'syntax-sensitive-insert')
}

assert.equal(planFor({
  source, canonical, oldDoc, transactions: deletes, nextCanonical: emptyCanonical,
  revision: 908, validateMarkdown: () => false
}).plan.reason, 'semantic-document-mismatch')
assert.equal(planFor({
  source, canonical, oldDoc, transactions: deletes, nextCanonical: emptyCanonical,
  revision: 909, callbackDocumentEquivalent: false
}).plan.reason, 'list-item-paragraph-callback-document-mismatch')
assert.equal(planFor({
  source, canonical, oldDoc, transactions: deletes, nextCanonical: emptyCanonical,
  revision: 910, activeJournal: null
}).plan.reason, 'list-item-paragraph-journal-stale')

assert.throws(() => createListItemParagraphTransactionSourceSyncOwner({}),
  /requires resolveMarkdownOffset/)
assert.throws(() => createListItemParagraphTransactionSourceSyncOwner({
  resolveMarkdownOffset: () => 0
}), /requires validateMarkdown/)

console.log('PASS list item paragraph transaction owner: top-level non-task list paragraph ReplaceStep journals preserve authored bullet/ordered markers through text replace and full emptying, while nested/task/marks/structure/multi-item/syntax/semantic/stale cases fail closed')
