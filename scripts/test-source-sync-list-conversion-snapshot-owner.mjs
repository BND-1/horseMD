import assert from 'node:assert/strict'
import {
  LIST_CONVERSION_SNAPSHOT_BOUNDARIES,
  createEditorSourceSyncBridge,
  createListConversionSnapshotSourceSyncOwner,
  createSourceSyncCheckpointStore
} from '../src/renderer/src/lib/source-sync/index.js'

const makeDoc = (id) => Object.freeze({
  id,
  eq(other) { return other?.id === id }
})
const beforeDoc = makeDoc('before')
const afterDoc = makeDoc('after')
const owner = createListConversionSnapshotSourceSyncOwner()

const blockPlan = owner.planBlockToList({
  source: 'Paragraph\n',
  previousCanonical: 'Paragraph\n',
  currentSource: 'Paragraph\n',
  currentCanonical: 'Paragraph\n',
  result: {
    markdown: '- Paragraph\n',
    preserved: true,
    reason: 'block-to-list-exact-line'
  },
  canonical: '* Paragraph\n',
  expectedDoc: afterDoc,
  targetType: 'bullet_list',
  sourceOffset: 3
})
assert.equal(blockPlan.ok, true)
assert.equal(blockPlan.boundary, LIST_CONVERSION_SNAPSHOT_BOUNDARIES.BLOCK_TO_LIST)
assert.equal(blockPlan.result.markdown, '- Paragraph\n')
assert.equal(blockPlan.proof.mode, 'block-to-list')
assert.equal(blockPlan.proof.targetType, 'bullet_list')
assert.equal(blockPlan.publication.expectedDoc, afterDoc)
assert.equal(blockPlan.publication.validationSite, 'block-to-list-command-snapshot')

assert.equal(owner.planBlockToList({
  ...blockPlan,
  source: 'Paragraph\n',
  previousCanonical: 'Paragraph\n',
  currentSource: 'external\n',
  currentCanonical: 'Paragraph\n',
  result: { markdown: '- Paragraph\n', preserved: true },
  canonical: '* Paragraph\n',
  expectedDoc: afterDoc,
  targetType: 'bullet_list'
}).reason, 'block-to-list-snapshot-stale')
assert.equal(owner.planBlockToList({
  source: 'Paragraph\n',
  previousCanonical: 'Paragraph\n',
  currentSource: 'Paragraph\n',
  currentCanonical: 'Paragraph\n',
  result: { markdown: 'Paragraph\n', preserved: false, reason: 'mapper-rejected' },
  canonical: '* Paragraph\n',
  expectedDoc: afterDoc,
  targetType: 'bullet_list'
}).reason, 'mapper-rejected')
assert.equal(owner.planBlockToList({
  source: 'Paragraph\n',
  previousCanonical: 'Paragraph\n',
  currentSource: 'Paragraph\n',
  currentCanonical: 'Paragraph\n',
  result: { markdown: '- Paragraph\n', preserved: true },
  canonical: '* Paragraph\n',
  expectedDoc: afterDoc,
  targetType: 'heading'
}).reason, 'block-to-list-target-invalid')

const token = {
  source: '1. Alpha\n2. Beta\n',
  previous: '1. Alpha\n2. Beta\n',
  convertedSource: '- Alpha\n- Beta\n',
  convertedCanonical: '* Alpha\n* Beta\n',
  convertedDoc: afterDoc,
  targetType: 'bullet_list',
  sourceOffset: 4,
  previousOffset: 4,
  listPos: 1,
  anchorPos: 5
}
const listPlan = owner.planListTypeConversion({
  token,
  activeToken: token,
  currentSource: token.source,
  currentCanonical: token.previous,
  expectedDoc: afterDoc
})
assert.equal(listPlan.ok, true)
assert.equal(listPlan.boundary, LIST_CONVERSION_SNAPSHOT_BOUNDARIES.LIST_TYPE)
assert.equal(listPlan.result.markdown, token.convertedSource)
assert.equal(listPlan.result.reason, 'list-conversion-command-snapshot')
assert.equal(listPlan.proof.tokenIdentityMatched, true)
assert.equal(listPlan.proof.convertedDocumentMatched, true)
assert.equal(listPlan.publication.canonical, token.convertedCanonical)

assert.equal(owner.planListTypeConversion({
  token,
  activeToken: { ...token },
  currentSource: token.source,
  currentCanonical: token.previous,
  expectedDoc: afterDoc
}).reason, 'list-conversion-command-token-stale')
assert.equal(owner.planListTypeConversion({
  token,
  activeToken: token,
  currentSource: `${token.source}external`,
  currentCanonical: token.previous,
  expectedDoc: afterDoc
}).reason, 'list-conversion-command-snapshot-stale')
assert.equal(owner.planListTypeConversion({
  token,
  activeToken: token,
  currentSource: token.source,
  currentCanonical: token.previous,
  expectedDoc: makeDoc('different')
}).reason, 'list-conversion-command-document-mismatch')
assert.equal(owner.planListTypeConversion({
  token: { ...token, targetType: 'heading' },
  activeToken: null,
  currentSource: token.source,
  currentCanonical: token.previous,
  expectedDoc: afterDoc
}).reason, 'list-conversion-command-token-stale')
const invalidTargetToken = { ...token, targetType: 'heading' }
assert.equal(owner.planListTypeConversion({
  token: invalidTargetToken,
  activeToken: invalidTargetToken,
  currentSource: token.source,
  currentCanonical: token.previous,
  expectedDoc: afterDoc
}).reason, 'list-conversion-command-target-invalid')

let sourceRef = 'Paragraph\n'
let canonicalRef = 'Paragraph\n'
let docRef = afterDoc
const changes = []
const trace = []
const checkpoints = createSourceSyncCheckpointStore({ limit: 4 })
checkpoints.trust(sourceRef, canonicalRef)
const bridge = createEditorSourceSyncBridge({
  checkpointStore: checkpoints,
  getSource: () => sourceRef,
  getCanonical: () => canonicalRef,
  getExpectedDoc: () => docRef,
  setSource: (value) => { sourceRef = value },
  setCanonical: (value) => { canonicalRef = value },
  onChange: (value) => changes.push(value),
  validateLegacyCandidate: (markdown, expectedDoc, canonical) => ({
    ok: markdown === '- Paragraph\n' &&
      expectedDoc === afterDoc &&
      canonical === '* Paragraph\n'
  }),
  trace: (entry) => trace.push(entry)
})
const publication = bridge.publish(blockPlan.publication)
assert.equal(publication.ok, true)
assert.equal(sourceRef, '- Paragraph\n')
assert.equal(canonicalRef, '* Paragraph\n')
assert.deepEqual(changes, ['- Paragraph\n'])
assert.ok(checkpoints.has('- Paragraph\n', '* Paragraph\n'))
const published = trace.find((entry) =>
  entry.phase === 'published' &&
  entry.boundary === LIST_CONVERSION_SNAPSHOT_BOUNDARIES.BLOCK_TO_LIST
)
assert.ok(published, 'block-to-list plan did not publish through Coordinator')
assert.equal(published.owner, 'legacy')
assert.equal(published.family, 'legacy-preservation')

console.log('PASS list conversion snapshot owner: baseline/token/doc ownership, stale rejection, and Coordinator publication')
