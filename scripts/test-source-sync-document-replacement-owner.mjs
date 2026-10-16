import assert from 'node:assert/strict'
import {
  DOCUMENT_REPLACEMENT_BOUNDARIES,
  createDocumentReplacementSourceSyncOwner,
  createEditorSourceSyncBridge,
  createSourceSyncCheckpointStore
} from '../src/renderer/src/lib/source-sync/index.js'
import { formatWholeDocumentReplacementSource } from '../src/renderer/src/lib/source-transaction-sync.js'

const makeDoc = (id) => Object.freeze({
  id,
  eq(other) { return other?.id === id },
  toJSON() { return { id } }
})
const oldDoc = makeDoc('old')
const pastedDoc = makeDoc('pasted')
const replacementDoc = makeDoc('replacement')
const owner = createDocumentReplacementSourceSyncOwner({
  formatWholeDocumentSource: formatWholeDocumentReplacementSource
})

const rawCapture = owner.captureRawMarkdownPaste({
  source: 'Before\n\nDestination\n',
  canonical: 'Before\n\nDestination\n',
  oldDoc,
  markdown: 'Before\n\n# Pasted\n',
  from: 9,
  to: 20,
  replacesWholeDocument: false
})
assert.equal(rawCapture.ok, true)
assert.equal(rawCapture.token.transactionBound, false)
const rawTransaction = {
  docChanged: true,
  before: oldDoc,
  doc: pastedDoc
}
assert.equal(owner.bindRawMarkdownPasteTransaction({
  token: rawCapture.token,
  activeToken: rawCapture.token,
  transactions: [rawTransaction],
  oldDoc,
  newDoc: pastedDoc
}).ok, true)
assert.equal(rawCapture.token.transactionBound, true)
assert.equal(rawCapture.token.transactionCount, 1)
const rawPlan = owner.planRawMarkdownPaste({
  token: rawCapture.token,
  activeToken: rawCapture.token,
  currentSource: rawCapture.token.source,
  currentCanonical: rawCapture.token.canonical,
  canonical: 'Before\n\n# Pasted\n',
  expectedDoc: pastedDoc
})
assert.equal(rawPlan.ok, true)
assert.equal(rawPlan.decision, 'owned')
assert.equal(rawPlan.owner, 'source')
assert.equal(rawPlan.family, 'raw-markdown-paste')
assert.equal(rawPlan.boundary, DOCUMENT_REPLACEMENT_BOUNDARIES.RAW_MARKDOWN_PASTE)
assert.equal(rawPlan.proof.transactionCount, 1)
assert.equal(rawPlan.result.markdown, 'Before\n\n# Pasted\n')
assert.equal(owner.planRawMarkdownPaste({
  token: rawCapture.token,
  activeToken: { ...rawCapture.token },
  currentSource: rawCapture.token.source,
  currentCanonical: rawCapture.token.canonical,
  canonical: 'Before\n\n# Pasted\n',
  expectedDoc: pastedDoc
}).reason, 'raw-markdown-paste-token-stale')
assert.equal(owner.planRawMarkdownPaste({
  token: rawCapture.token,
  activeToken: rawCapture.token,
  currentSource: 'external\n',
  currentCanonical: rawCapture.token.canonical,
  canonical: 'Before\n\n# Pasted\n',
  expectedDoc: pastedDoc
}).reason, 'raw-markdown-paste-snapshot-stale')
assert.equal(owner.bindRawMarkdownPasteTransaction({
  token: rawCapture.token,
  activeToken: rawCapture.token,
  transactions: [{ docChanged: true, before: makeDoc('different'), doc: pastedDoc }],
  oldDoc,
  newDoc: pastedDoc
}).reason, 'raw-markdown-paste-transaction-chain-mismatch')

const wholeCapture = owner.captureWholeDocumentReplacement({
  source: '\uFEFF# Old\r\n\r\nBody\r\n',
  canonical: '# Old\n\nBody\n',
  originalDoc: oldDoc,
  expectedDoc: replacementDoc
})
assert.equal(wholeCapture.ok, true)
const wholePlan = owner.planWholeDocumentReplacement({
  token: wholeCapture.token,
  activeToken: wholeCapture.token,
  currentSource: wholeCapture.token.source,
  currentCanonical: wholeCapture.token.canonical,
  canonical: 'New\nNext\n',
  replacementCanonical: 'New\nNext\n',
  expectedDoc: replacementDoc
})
assert.equal(wholePlan.ok, true)
assert.equal(wholePlan.owner, 'transaction')
assert.equal(wholePlan.family, 'whole-document-replacement')
assert.equal(wholePlan.boundary, DOCUMENT_REPLACEMENT_BOUNDARIES.WHOLE_DOCUMENT)
assert.equal(wholePlan.result.markdown, '\uFEFFNew\r\nNext\r\n')
assert.equal(wholePlan.proof.wholeDocument, true)
assert.equal(owner.planWholeDocumentReplacement({
  token: wholeCapture.token,
  activeToken: wholeCapture.token,
  currentSource: wholeCapture.token.source,
  currentCanonical: wholeCapture.token.canonical,
  canonical: 'New\n',
  replacementCanonical: 'New\n',
  expectedDoc: makeDoc('different')
}).reason, 'whole-document-replacement-document-mismatch')

let source = rawCapture.token.source
let canonical = rawCapture.token.canonical
let liveDoc = pastedDoc
const changes = []
const trace = []
const checkpoints = createSourceSyncCheckpointStore({ limit: 8 })
checkpoints.trust(source, canonical)
const bridge = createEditorSourceSyncBridge({
  checkpointStore: checkpoints,
  getSource: () => source,
  getCanonical: () => canonical,
  getExpectedDoc: () => liveDoc,
  setSource: (value) => { source = value },
  setCanonical: (value) => { canonical = value },
  onChange: (value) => changes.push(value),
  validateLegacyCandidate: (markdown, expectedDoc, nextCanonical) => ({
    ok: markdown === rawPlan.result.markdown &&
      expectedDoc === pastedDoc &&
      nextCanonical === 'Before\n\n# Pasted\n'
  }),
  trace: (entry) => trace.push(entry)
})
const published = bridge.publishOwned({ ownership: rawPlan })
assert.equal(published.ok, true)
assert.equal(published.publication.owner, 'source')
assert.equal(published.publication.family, 'raw-markdown-paste')
assert.equal(source, rawPlan.result.markdown)
assert.equal(canonical, 'Before\n\n# Pasted\n')
assert.deepEqual(changes, [rawPlan.result.markdown])
assert.ok(checkpoints.has(source, canonical))
assert.ok(trace.some((entry) =>
  entry.phase === 'published' &&
  entry.boundary === 'raw-markdown-paste' &&
  entry.owner === 'source'
))

assert.throws(
  () => createDocumentReplacementSourceSyncOwner({}),
  /requires formatWholeDocumentSource/
)
console.log('PASS document replacement owner: raw paste transaction binding, whole-document proof, stale rejection, BOM/EOL formatting, and Coordinator publication')
