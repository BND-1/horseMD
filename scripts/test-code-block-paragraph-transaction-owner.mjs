import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import {
  CODE_BLOCK_PARAGRAPH_TRANSACTION_BOUNDARY,
  CODE_BLOCK_PARAGRAPH_TRANSACTION_FAMILY,
  createCodeBlockParagraphTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    code_block: {
      attrs: { language: { default: '' } },
      content: 'text*',
      marks: '',
      group: 'block',
      code: true
    },
    text: { group: 'inline' }
  },
  marks: { strong: {} }
})
const paragraph = (value = '', marks = null) => schema.nodes.paragraph.create(
  null,
  value ? schema.text(value, marks || undefined) : null
)
const codeBlock = (value = '', language = '') => schema.nodes.code_block.create(
  { language },
  value ? schema.text(value) : null
)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const beforeAtIndex = (doc, index) => {
  let offset = 0
  for (let current = 0; current < index; current += 1) offset += doc.child(current).nodeSize
  return offset
}

const conversionTransaction = (doc, index = 1) => {
  const node = doc.child(index)
  const before = beforeAtIndex(doc, index)
  const cursor = before + 1 + node.content.size
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, cursor)
  })
  return state.tr.setNodeMarkup(before, schema.nodes.paragraph, null)
}

const insertTransaction = (doc, index, value) => {
  const node = doc.child(index)
  const position = beforeAtIndex(doc, index) + 1 + node.content.size
  return EditorState.create({ schema, doc }).tr.insertText(value, position)
}

const makeChain = ({
  oldDoc = document(paragraph('before'), codeBlock('alpha', 'js'), paragraph('after')),
  values = ['X', 'Y']
} = {}) => {
  const conversion = conversionTransaction(oldDoc)
  const transactions = [conversion]
  let current = conversion.doc
  for (const value of values) {
    const transaction = insertTransaction(current, 1, value)
    transactions.push(transaction)
    current = transaction.doc
  }
  return { oldDoc, transactions, expectedDoc: current }
}

const source = '\uFEFFbefore\r\n\r\n~~~js\r\nalpha\r\n~~~\r\n\r\nafter\r\n'
const previousCanonical = 'before\n\n~~~js\nalpha\n~~~\n\nafter\n'
const nextCanonical = 'before\n\nalphaXY\n\nafter\n'
const expectedSource = '\uFEFFbefore\r\n\r\nalphaXY\r\n\r\nafter\r\n'

const captureJournal = ({ chain, authoredSource = source, canonical = previousCanonical, revision = 1201 }) => {
  const snapshot = createSourceSyncSnapshot({
    revision,
    source: authoredSource,
    canonical,
    doc: chain.oldDoc
  })
  const factory = createSourceSyncTransactionJournal()
  let checkpoint = null
  let current = chain.oldDoc
  for (const transaction of chain.transactions) {
    const captured = factory.captureOrAdvance({
      checkpoint,
      snapshot,
      transactions: [transaction],
      oldDoc: current,
      newDoc: transaction.doc
    })
    assert.equal(captured.ok, true, `journal capture failed: ${JSON.stringify(captured)}`)
    checkpoint = captured.checkpoint
    current = transaction.doc
  }
  return { snapshot, journal: checkpoint, expectedDoc: current }
}

const planChain = ({
  chain = makeChain(),
  authoredSource = source,
  canonicalBaseline = previousCanonical,
  canonical = nextCanonical,
  revision = 1201,
  resolver = ({ markdown }) => markdown.indexOf('alpha') + 1,
  validateMarkdown = ({ markdown, expectedDoc }) =>
    markdown === expectedSource && expectedDoc.eq(chain.expectedDoc),
  callbackDocumentEquivalent = true,
  currentSource = authoredSource,
  currentCanonical = canonicalBaseline,
  activeJournal = null
} = {}) => {
  const captured = captureJournal({
    chain,
    authoredSource,
    canonical: canonicalBaseline,
    revision
  })
  const owner = createCodeBlockParagraphTransactionSourceSyncOwner({
    resolveMarkdownOffset: resolver,
    validateMarkdown
  })
  return {
    ...captured,
    owner,
    plan: owner.plan({
      journal: captured.journal,
      activeJournal: activeJournal || captured.journal,
      snapshot: captured.snapshot,
      currentSource,
      currentCanonical,
      canonical,
      expectedDoc: captured.expectedDoc,
      callbackDocumentEquivalent,
      boundary: CODE_BLOCK_PARAGRAPH_TRANSACTION_BOUNDARY
    })
  }
}

{
  const chain = makeChain()
  const conversion = chain.transactions[0]
  assert.equal(conversion.steps.length, 1)
  assert.equal(conversion.steps[0].constructor.name, 'ReplaceAroundStep')
  assert.equal(conversion.steps[0].structure, true)

  const { plan } = planChain({ chain })
  assert.equal(plan.ok, true, `code block paragraph plan rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, CODE_BLOCK_PARAGRAPH_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, CODE_BLOCK_PARAGRAPH_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, 'code-block-converted-to-paragraph')
  assert.equal(plan.result.markdown, expectedSource)
  assert.equal(plan.canonical, nextCanonical)
  assert.equal(plan.proof.kind, 'transaction-code-block-paragraph-proof')
  assert.equal(plan.proof.topLevelIndex, 1)
  assert.deepEqual(plan.proof.nodePath, [1])
  assert.equal(plan.proof.previousLanguage, 'js')
  assert.equal(plan.proof.previousText, 'alpha')
  assert.equal(plan.proof.finalText, 'alphaXY')
  assert.equal(plan.proof.conversionStep.name, 'ReplaceAroundStep')
  assert.equal(plan.proof.conversionStep.structure, true)
  assert.equal(plan.proof.textSteps.length, 2)
  assert.equal(plan.proof.stepCount, 3)
  assert.equal(plan.proof.sourceRange.marker, '~')
  assert.equal(plan.proof.sourceRange.info, 'js')
  assert.equal(plan.proof.sourceRange.eol, '\r\n')
  assert.equal(plan.proof.transactionJournal.stepCount, 3)
}

{
  const chain = makeChain({ values: [] })
  const expectedCanonical = 'before\n\nalpha\n\nafter\n'
  const expectedRaw = '\uFEFFbefore\r\n\r\nalpha\r\n\r\nafter\r\n'
  const { plan } = planChain({
    chain,
    canonical: expectedCanonical,
    revision: 1202,
    validateMarkdown: ({ markdown }) => markdown === expectedRaw
  })
  assert.equal(plan.ok, true, `conversion-only plan rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.proof.textSteps.length, 0)
  assert.equal(plan.proof.stepCount, 1)
}

{
  const authored = 'before\n\n```ts\nalpha\n```\n\nafter\n'
  const expectedRaw = 'before\n\nalphaXY\n\nafter\n'
  const chain = makeChain({
    oldDoc: document(paragraph('before'), codeBlock('alpha', 'ts'), paragraph('after'))
  })
  const { plan } = planChain({
    chain,
    authoredSource: authored,
    canonicalBaseline: authored,
    canonical: expectedRaw,
    revision: 1203,
    resolver: ({ markdown }) => markdown.indexOf('alpha') + 1,
    validateMarkdown: ({ markdown }) => markdown === expectedRaw
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.proof.sourceRange.marker, '`')
  assert.equal(plan.proof.sourceRange.info, 'ts')
  assert.equal(plan.result.markdown, expectedRaw)
}

{
  const chain = makeChain({
    oldDoc: document(paragraph('before'), codeBlock('', 'js'), paragraph('after')),
    values: []
  })
  const { plan } = planChain({
    chain,
    authoredSource: '\uFEFFbefore\r\n\r\n~~~js\r\n~~~\r\n\r\nafter\r\n',
    canonicalBaseline: 'before\n\n~~~js\n~~~\n\nafter\n',
    canonical: 'before\n\n\nafter\n',
    revision: 1204,
    resolver: ({ markdown }) => markdown.indexOf('~~~js') + 1,
    validateMarkdown: () => true
  })
  assert.equal(plan.reason, 'code-block-paragraph-source-node')
  assert.equal(plan.recognized, true)
}

{
  const chain = makeChain({
    oldDoc: document(paragraph('before'), codeBlock('alpha\nbeta', 'js'), paragraph('after')),
    values: []
  })
  const { plan } = planChain({
    chain,
    authoredSource: 'before\n\n~~~js\nalpha\nbeta\n~~~\n\nafter\n',
    canonicalBaseline: 'before\n\n~~~js\nalpha\nbeta\n~~~\n\nafter\n',
    canonical: 'before\n\nalpha\nbeta\n\nafter\n',
    revision: 1205,
    resolver: ({ markdown }) => markdown.indexOf('alpha') + 1,
    validateMarkdown: () => true
  })
  assert.equal(plan.reason, 'code-block-paragraph-source-node')
  assert.equal(plan.recognized, true)
}

{
  const value = '# heading'
  const authored = `before\n\n~~~\n${value}\n~~~\n\nafter\n`
  const chain = makeChain({
    oldDoc: document(paragraph('before'), codeBlock(value), paragraph('after')),
    values: []
  })
  const { plan } = planChain({
    chain,
    authoredSource: authored,
    canonicalBaseline: authored,
    canonical: `before\n\n${value}\n\nafter\n`,
    revision: 1206,
    resolver: ({ markdown }) => markdown.indexOf(value) + 1,
    validateMarkdown: () => false
  })
  assert.equal(plan.reason, 'code-block-paragraph-semantic-document-mismatch')
  assert.equal(plan.recognized, true)
}

{
  const chain = makeChain({ values: ['X'] })
  const neighbourPos = beforeAtIndex(chain.expectedDoc, 2) + 1 + 'after'.length
  const mixed = EditorState.create({ schema, doc: chain.expectedDoc }).tr.insertText('!', neighbourPos)
  const mixedChain = {
    ...chain,
    transactions: [...chain.transactions, mixed],
    expectedDoc: mixed.doc
  }
  const { plan } = planChain({ chain: mixedChain, revision: 1207, validateMarkdown: () => true })
  assert.equal(plan.reason, 'code-block-paragraph-followup-step')
  assert.equal(plan.recognized, true)
}

{
  const authored = 'before\n\n  ~~~js\n  alpha\n  ~~~\n\nafter\n'
  const { plan } = planChain({
    authoredSource: authored,
    canonicalBaseline: previousCanonical,
    canonical: nextCanonical,
    revision: 1208,
    resolver: ({ markdown }) => markdown.indexOf('alpha') + 1,
    validateMarkdown: () => true
  })
  assert.equal(plan.reason, 'code-block-paragraph-indented-fence')
  assert.equal(plan.recognized, true)
}

{
  const { plan } = planChain({ revision: 1209, resolver: () => -1, validateMarkdown: () => true })
  assert.equal(plan.reason, 'code-block-paragraph-fenced-range')
  assert.equal(plan.recognized, true)
}

{
  const wrongContent = '\uFEFFbefore\r\n\r\n~~~js\r\nbeta\r\n~~~\r\n\r\nafter\r\n'
  const { plan } = planChain({
    authoredSource: wrongContent,
    revision: 1210,
    resolver: ({ markdown }) => markdown.indexOf(
      markdown.includes('beta') ? 'beta' : 'alpha'
    ) + 1,
    validateMarkdown: () => true
  })
  assert.equal(plan.reason, 'code-block-paragraph-content-mismatch')
  assert.equal(plan.recognized, true)
}

{
  const { plan } = planChain({ revision: 1211, callbackDocumentEquivalent: false, validateMarkdown: () => true })
  assert.equal(plan.reason, 'code-block-paragraph-callback-document-mismatch')
  assert.equal(plan.recognized, false)
  assert.equal(plan.deferred, true)
}

{
  const captured = planChain({ revision: 1212 })
  const stale = captured.owner.plan({
    journal: captured.journal,
    activeJournal: { ...captured.journal },
    snapshot: captured.snapshot,
    currentSource: source,
    currentCanonical: previousCanonical,
    canonical: nextCanonical,
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(stale.reason, 'code-block-paragraph-journal-stale')
  assert.equal(stale.recognized, false)
  assert.equal(stale.reset, true)
}

{
  const oldDoc = document(paragraph('before'), paragraph('alpha'), paragraph('after'))
  const transaction = insertTransaction(oldDoc, 1, 'X')
  const chain = { oldDoc, transactions: [transaction], expectedDoc: transaction.doc }
  const { plan } = planChain({
    chain,
    authoredSource: 'before\n\nalpha\n\nafter\n',
    canonicalBaseline: 'before\n\nalpha\n\nafter\n',
    canonical: 'before\n\nalphaX\n\nafter\n',
    revision: 1213,
    resolver: ({ markdown }) => markdown.indexOf('alpha') + 1,
    validateMarkdown: () => true
  })
  assert.equal(plan.reason, 'code-block-paragraph-conversion-step')
  assert.equal(plan.recognized, false)
}

assert.throws(
  () => createCodeBlockParagraphTransactionSourceSyncOwner({ validateMarkdown: () => true }),
  /requires resolveMarkdownOffset/
)
assert.throws(
  () => createCodeBlockParagraphTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)

console.log('PASS code-block-to-paragraph transaction owner: the exact product setNodeMarkup ReplaceAroundStep plus coalesced paragraph text journal atomically removes the full authored fence with BOM/CRLF; unrelated transactions stay unrecognized while empty, multiline, Markdown-sensitive, mixed, indented, range, content and semantic failures are recognized and fail closed')
