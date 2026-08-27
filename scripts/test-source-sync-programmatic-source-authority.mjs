import assert from 'node:assert/strict'
import {
  createEditorSourceSyncBridge,
  createSourceSyncCheckpointStore
} from '../src/renderer/src/lib/source-sync/index.js'

const oldDoc = Object.freeze({ id: 'old-doc' })
const nextDoc = Object.freeze({ id: 'next-doc' })
let source = '\uFEFFold\r\n'
let canonical = 'old\n'
let liveDoc = oldDoc
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
  validateLegacyCandidate: () => {
    assert.fail('source authority must not use the legacy validator')
  },
  trace: (entry) => trace.push(entry)
})

liveDoc = nextDoc
const prepared = bridge.prepareSourceAuthority({
  markdown: '\uFEFFnext\r\n',
  canonical: 'next\n',
  expectedDoc: nextDoc,
  sourceDocumentEquivalent: true,
  replacementKind: 'whole-document',
  boundary: 'programmatic-source-replacement'
})
assert.equal(prepared.candidate.ok, true)
assert.equal(prepared.candidate.owner, 'source')
assert.equal(prepared.candidate.family, 'programmatic-source-replacement')
assert.equal(prepared.candidate.proof.kind, 'programmatic-source-authority-proof')
assert.equal(prepared.candidate.proof.sourceDocumentEquivalent, true)
assert.equal(prepared.validation.ok, true)
assert.equal(prepared.validation.structure.wholeDocument, true)

const published = bridge.publishPrepared(prepared, {
  notifyChange: true,
  boundary: 'programmatic-source-replacement'
})
assert.equal(published.ok, true)
assert.equal(published.publication.owner, 'source')
assert.equal(source, '\uFEFFnext\r\n')
assert.equal(canonical, 'next\n')
assert.deepEqual(changes, ['\uFEFFnext\r\n'])
assert.equal(checkpoints.has('\uFEFFnext\r\n', 'next\n'), true)
assert.ok(trace.some((entry) =>
  entry.phase === 'published' &&
  entry.owner === 'source' &&
  entry.boundary === 'programmatic-source-replacement'
))

const incomplete = bridge.prepareSourceAuthority({
  markdown: 'unsafe\n',
  canonical: 'unsafe\n',
  expectedDoc: nextDoc,
  sourceDocumentEquivalent: false
})
assert.equal(incomplete.candidate.ok, true)
assert.equal(incomplete.validation.ok, false)
assert.equal(incomplete.validation.reason, 'programmatic-source-authority-proof-incomplete')

const stalePrepared = bridge.prepareSourceAuthority({
  markdown: 'later\n',
  canonical: 'later\n',
  expectedDoc: nextDoc,
  sourceDocumentEquivalent: true
})
source = 'external\n'
const stale = bridge.publishPrepared(stalePrepared)
assert.equal(stale.ok, false)
assert.equal(stale.reason, 'source-sync-live-snapshot-stale')
assert.equal(canonical, 'next\n')
assert.deepEqual(changes, ['\uFEFFnext\r\n'])

console.log(
  'PASS programmatic source authority: explicit source owner, whole-document proof, atomic publication, incomplete proof and stale snapshot fail closed'
)
