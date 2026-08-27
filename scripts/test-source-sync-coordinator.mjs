import assert from 'node:assert/strict'
import {
  createEditorSourceSyncBridge,
  createLegacySourceIntegrityValidator,
  createLegacySourceSyncCandidateFromResult,
  createLegacySourceSyncOwner,
  createSourceSyncCandidate,
  createSourceSyncCheckpointStore,
  createSourceSyncCoordinator,
  createSourceSyncSnapshot,
  createSourceSyncValidator,
  sourceSyncCandidateMatchesValidation
} from '../src/renderer/src/lib/source-sync/index.js'

const doc0 = { id: 'doc-0' }
const doc1 = { id: 'doc-1' }
const initial = createSourceSyncSnapshot({
  revision: 4,
  source: 'alpha\n',
  canonical: 'alpha\n',
  doc: doc0,
  owner: 'bootstrap',
  family: 'bootstrap',
  reason: 'fixture'
})
assert.equal(initial.revision, 4)
assert.equal(initial.parentRevision, null)
assert.ok(Object.isFrozen(initial))

const checkpoints = createSourceSyncCheckpointStore({ limit: 2 })
checkpoints.trust('a', 'A')
checkpoints.trust('b', 'B')
checkpoints.trust('c', 'C')
assert.equal(checkpoints.size(), 2)
assert.equal(checkpoints.has('a', 'A'), false)
assert.equal(checkpoints.has('c', 'C'), true)
checkpoints.trust('b', 'B')
assert.equal(checkpoints.latest().source, 'b')

const fakeDoc = (text) => ({
  toJSON: () => ({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: text ? [{ type: 'text', text }] : []
    }]
  })
})
const integrityCheckpoints = createSourceSyncCheckpointStore({ limit: 4 })
integrityCheckpoints.trust('integrity-base\n', 'integrity-base\n')
const legacyIntegrityValidator = createLegacySourceIntegrityValidator({
  getParser: () => (markdown) => fakeDoc(String(markdown || '').trim()),
  getSerializer: () => () => 'integrity-next\n',
  getExpectedDoc: () => fakeDoc('integrity-next'),
  getAuthoredSource: () => 'integrity-base\n',
  getCanonicalBaseline: () => 'integrity-base\n',
  canonicalForSource: (markdown) => markdown,
  checkpointStore: integrityCheckpoints,
  getTrace: () => null
})
const validationOnly = legacyIntegrityValidator(
  'integrity-next\n',
  fakeDoc('integrity-next'),
  'integrity-next\n',
  'integrity-base\n',
  'unit-validation-only',
  null,
  'unit-validation-only',
  { trustCheckpoint: false }
)
assert.equal(validationOnly.ok, true)
assert.equal(
  integrityCheckpoints.has('integrity-next\n', 'integrity-next\n'),
  false,
  'Coordinator validation must not trust an unpublished checkpoint'
)
const legacyDirectValidation = legacyIntegrityValidator(
  'integrity-next\n',
  fakeDoc('integrity-next'),
  'integrity-next\n',
  'integrity-base\n',
  'unit-direct-validation'
)
assert.equal(legacyDirectValidation.ok, true)
assert.equal(
  integrityCheckpoints.has('integrity-next\n', 'integrity-next\n'),
  true,
  'legacy direct validation keeps its historical trust behavior by default'
)

const preservationProof = {
  kind: 'localized-list-slots',
  beforeSource: { start: 0, end: 5 },
  afterSource: { start: 0, end: 6 }
}
const legacyCandidate = createLegacySourceSyncCandidateFromResult({
  snapshot: initial,
  result: {
    markdown: 'alphaX\n',
    preserved: true,
    reason: 'localized-change',
    integrityProof: preservationProof
  },
  canonical: 'alphaX\n',
  expectedDoc: doc1,
  validationSite: 'unit-primary'
})
assert.equal(legacyCandidate.ok, true)
assert.equal(legacyCandidate.owner, 'legacy')
assert.equal(legacyCandidate.family, 'legacy-preservation')
assert.equal(legacyCandidate.baseRevision, 4)
assert.equal(legacyCandidate.reason, 'localized-change')
assert.deepEqual(
  legacyCandidate.proof.preservationProof,
  preservationProof,
  'legacy proof must stay bound to its own candidate'
)
assert.ok(Object.isFrozen(legacyCandidate))
assert.ok(Object.isFrozen(legacyCandidate.proof))

const fallbackCandidate = createLegacySourceSyncCandidateFromResult({
  snapshot: initial,
  result: {
    markdown: 'alphaY\n',
    preserved: true,
    reason: 'fallback-change'
  },
  canonical: 'alphaY\n',
  expectedDoc: doc1,
  validationSite: 'unit-fallback'
})
assert.equal(fallbackCandidate.proof.preservationProof, null)
assert.notEqual(fallbackCandidate.candidateId, legacyCandidate.candidateId)

assert.equal(createSourceSyncCandidate({
  snapshot: initial,
  owner: 'legacy',
  family: 'legacy-preservation',
  markdown: 'missing canonical'
}).reason, 'candidate-missing-canonical')

const validator = createSourceSyncValidator({
  validate: (candidate) => candidate.markdown === candidate.canonical
    ? {
        ok: true,
        semantic: { direct: true },
        structure: { listSlots: true },
        lifecycle: { checkpointTrusted: true }
      }
    : { ok: false, reason: 'unit-semantic-mismatch' }
})
const boundValidation = validator(legacyCandidate)
assert.equal(boundValidation.ok, true)
assert.equal(sourceSyncCandidateMatchesValidation(legacyCandidate, boundValidation), true)
assert.equal(sourceSyncCandidateMatchesValidation(fallbackCandidate, boundValidation), false)

const commits = []
const trace = []
const coordinator = createSourceSyncCoordinator({
  initialSnapshot: initial,
  checkpointStore: createSourceSyncCheckpointStore({ limit: 4 }),
  validator,
  commit: (payload) => {
    commits.push(payload)
    return true
  },
  trace: (entry) => trace.push(entry)
})
const published = coordinator.evaluate(legacyCandidate)
assert.equal(published.ok, true)
assert.equal(published.snapshot.revision, 5)
assert.equal(published.snapshot.parentRevision, 4)
assert.equal(published.snapshot.source, 'alphaX\n')
assert.equal(commits.length, 1)
assert.equal(coordinator.getCheckpointStore().has('alphaX\n', 'alphaX\n'), true)
assert.equal(trace.at(-1).phase, 'published')

const duplicatePublication = coordinator.publishValidated(legacyCandidate, boundValidation)
assert.equal(duplicatePublication.ok, false)
assert.equal(duplicatePublication.reason, 'source-sync-publication-already-consumed')
assert.equal(commits.length, 1, 'one candidate must never publish twice')

const stale = coordinator.evaluate(fallbackCandidate)
assert.equal(stale.ok, false)
assert.equal(stale.reason, 'source-sync-candidate-stale')
assert.equal(coordinator.getSnapshot().revision, 5)
assert.equal(commits.length, 1)

const current = coordinator.getSnapshot()
const rejectedCandidate = createLegacySourceSyncCandidateFromResult({
  snapshot: current,
  result: {
    markdown: 'alphaZ\n',
    preserved: true,
    reason: 'unit-rejected'
  },
  canonical: 'different\n',
  expectedDoc: doc1
})
const rejected = coordinator.evaluate(rejectedCandidate)
assert.equal(rejected.ok, false)
assert.equal(rejected.reason, 'unit-semantic-mismatch')
assert.equal(coordinator.getSnapshot().revision, 5)
assert.equal(commits.length, 1)

const unpreservedCandidate = createLegacySourceSyncCandidateFromResult({
  snapshot: current,
  result: {
    markdown: current.source,
    preserved: false,
    reason: 'visible-stream-mismatch'
  },
  canonical: current.canonical,
  expectedDoc: doc1
})
const unpreserved = coordinator.evaluate(unpreservedCandidate)
assert.equal(unpreserved.ok, false)
assert.equal(unpreserved.reason, 'visible-stream-mismatch')
assert.equal(coordinator.getSnapshot().revision, 5)

const prevalidatedSnapshot = createSourceSyncSnapshot({
  revision: 20,
  source: 'pre\n',
  canonical: 'pre\n',
  doc: doc0
})
const prevalidatedCandidate = createLegacySourceSyncCandidateFromResult({
  snapshot: prevalidatedSnapshot,
  result: { markdown: 'preX\n', preserved: true, reason: 'prevalidated' },
  canonical: 'preX\n',
  expectedDoc: doc1
})
const prevalidatedValidation = validator(prevalidatedCandidate)
const prevalidatedCommits = []
const prevalidatedCoordinator = createSourceSyncCoordinator({
  initialSnapshot: prevalidatedSnapshot,
  validator,
  commit: (payload) => { prevalidatedCommits.push(payload); return true }
})
const prevalidatedPublication = prevalidatedCoordinator.publishValidated(
  prevalidatedCandidate,
  prevalidatedValidation,
  { boundary: 'forced-flush' }
)
assert.equal(prevalidatedPublication.ok, true)
assert.equal(prevalidatedPublication.snapshot.revision, 21)
assert.equal(prevalidatedCommits[0].context.boundary, 'forced-flush')

const synchronized = coordinator.synchronize({
  source: 'external\n',
  canonical: 'external\n',
  doc: doc1,
  owner: 'source',
  family: 'source-mode',
  reason: 'source-mode-commit',
  trust: true
})
assert.equal(synchronized.revision, 6)
assert.equal(coordinator.getCheckpointStore().has('external\n', 'external\n'), true)
const sameSynchronized = coordinator.synchronize({
  source: 'external\n',
  canonical: 'external\n',
  doc: doc1,
  trust: true
})
assert.equal(sameSynchronized, synchronized, 'identical checkpoint must not consume a revision')

let bridgeSource = 'bridge\n'
let bridgeCanonical = 'bridge\n'
let bridgeDoc = doc0
const bridgeChanges = []
const bridgeCheckpoints = createSourceSyncCheckpointStore({ limit: 4 })
bridgeCheckpoints.trust(bridgeSource, bridgeCanonical)
const bridge = createEditorSourceSyncBridge({
  checkpointStore: bridgeCheckpoints,
  getSource: () => bridgeSource,
  getCanonical: () => bridgeCanonical,
  getExpectedDoc: () => bridgeDoc,
  setSource: (value) => { bridgeSource = value },
  setCanonical: (value) => { bridgeCanonical = value },
  onChange: (value) => bridgeChanges.push(value),
  validateLegacyCandidate: (markdown, expectedDoc, canonical) => ({
    ok: markdown === canonical && expectedDoc === bridgeDoc,
    reason: 'bridge-validation-failed'
  })
})
const bridgePrepared = bridge.prepare({
  result: { markdown: 'bridgeX\n', preserved: true, reason: 'bridge-edit' },
  canonical: 'bridgeX\n',
  expectedDoc: bridgeDoc,
  validationSite: 'bridge-unit',
  boundary: 'markdown-updated'
})
assert.equal(bridgePrepared.validation.ok, true)
assert.equal(bridgeSource, 'bridge\n', 'prepare must not mutate live refs')
const bridgePublished = bridge.publishPrepared(bridgePrepared, { boundary: 'markdown-updated' })
assert.equal(bridgePublished.ok, true)
assert.equal(bridgeSource, 'bridgeX\n')
assert.equal(bridgeCanonical, 'bridgeX\n')
assert.deepEqual(bridgeChanges, ['bridgeX\n'])

const stalePrepared = bridge.prepare({
  result: { markdown: 'bridgeY\n', preserved: true, reason: 'bridge-stale' },
  canonical: 'bridgeY\n',
  expectedDoc: bridgeDoc
})
bridgeSource = 'external-source\n'
const staleLive = bridge.publishPrepared(stalePrepared)
assert.equal(staleLive.ok, false)
assert.equal(staleLive.reason, 'source-sync-live-snapshot-stale')
bridgeSource = bridgeCanonical

const staleDocPrepared = bridge.prepare({
  result: { markdown: 'bridgeZ\n', preserved: true, reason: 'bridge-stale-doc' },
  canonical: 'bridgeZ\n',
  expectedDoc: bridgeDoc
})
bridgeDoc = doc1
const staleDoc = bridge.publishPrepared(staleDocPrepared)
assert.equal(staleDoc.ok, false)
assert.equal(staleDoc.reason, 'source-sync-live-document-stale')
bridgeDoc = doc0

let atomicSource = 'atomic\n'
let atomicCanonical = 'atomic\n'
let atomicValidationOptions = null
const atomicCheckpoints = createSourceSyncCheckpointStore({ limit: 2 })
const atomicBridge = createEditorSourceSyncBridge({
  checkpointStore: atomicCheckpoints,
  getSource: () => atomicSource,
  getCanonical: () => atomicCanonical,
  getExpectedDoc: () => doc0,
  setSource: (value) => { atomicSource = value },
  setCanonical: (value) => { atomicCanonical = value },
  onChange: () => { throw new Error('atomic-on-change') },
  validateLegacyCandidate: (
    markdown,
    expectedDoc,
    canonical,
    _authoredSource,
    _reason,
    _proof,
    _site,
    validationOptions
  ) => {
    atomicValidationOptions = validationOptions
    if (validationOptions?.trustCheckpoint !== false) {
      atomicCheckpoints.trust(markdown, canonical)
    }
    return { ok: markdown === canonical && expectedDoc === doc0 }
  }
})
const atomicPrepared = atomicBridge.prepare({
  result: { markdown: 'atomic-next\n', preserved: true, reason: 'atomic-edit' },
  canonical: 'atomic-next\n',
  expectedDoc: doc0
})
assert.equal(atomicValidationOptions?.trustCheckpoint, false)
assert.equal(
  atomicCheckpoints.has('atomic-next\n', 'atomic-next\n'),
  false,
  'bridge prepare must keep validation checkpoint-pure'
)
const atomicFailed = atomicBridge.publishPrepared(atomicPrepared)
assert.equal(atomicFailed.ok, false)
assert.equal(atomicFailed.reason, 'source-sync-commit-threw:Error')
assert.equal(atomicSource, 'atomic\n', 'failed host commit must roll source ref back')
assert.equal(atomicCanonical, 'atomic\n', 'failed host commit must roll canonical ref back')
assert.equal(atomicBridge.getCoordinator().getSnapshot().source, 'atomic\n')
assert.equal(
  atomicCheckpoints.has('atomic-next\n', 'atomic-next\n'),
  false,
  'failed host commit must not leave the unpublished pair trusted'
)

let revisionSource = 'revision-base\n'
let revisionCanonical = 'revision-base\n'
const revisionCheckpoints = createSourceSyncCheckpointStore({ limit: 4 })
revisionCheckpoints.trust(revisionSource, revisionCanonical)
const revisionBridge = createEditorSourceSyncBridge({
  checkpointStore: revisionCheckpoints,
  getSource: () => revisionSource,
  getCanonical: () => revisionCanonical,
  getExpectedDoc: () => doc0,
  setSource: (value) => { revisionSource = value },
  setCanonical: (value) => { revisionCanonical = value },
  validateLegacyCandidate: (markdown, expectedDoc, canonical) => ({
    ok: markdown === canonical && expectedDoc === doc0,
    reason: 'revision-owned-validation-failed'
  })
})
const revisionSnapshot = revisionBridge.getSnapshot()
assert.equal(revisionSnapshot.source, revisionSource)
assert.equal(revisionSnapshot.canonical, revisionCanonical)
const revisionOwnership = {
  ok: true,
  decision: 'owned',
  owner: 'transaction',
  family: 'journal-owned',
  boundary: 'journal-owned-unit',
  baseRevision: revisionSnapshot.revision,
  baseSourceDigest: revisionSnapshot.sourceDigest,
  baseCanonicalDigest: revisionSnapshot.canonicalDigest,
  result: {
    markdown: 'revision-next\n',
    preserved: true,
    reason: 'journal-owned-unit',
    integrityProof: { kind: 'journal-proof' }
  },
  canonical: 'revision-next\n',
  expectedDoc: doc0,
  proof: { kind: 'journal-ownership-proof' }
}
const revisionPrepared = revisionBridge.prepareOwnedResult({ ownership: revisionOwnership })
assert.equal(revisionPrepared.candidate.ok, true)
assert.equal(revisionPrepared.validation.ok, true)
const revisionPublished = revisionBridge.publishPrepared(revisionPrepared)
assert.equal(revisionPublished.ok, true)
assert.equal(revisionSource, 'revision-next\n')
assert.equal(revisionCanonical, 'revision-next\n')

const currentRevisionSnapshot = revisionBridge.getSnapshot()
const staleRevisionPrepared = revisionBridge.prepareOwnedResult({
  ownership: {
    ...revisionOwnership,
    baseRevision: revisionSnapshot.revision,
    baseSourceDigest: currentRevisionSnapshot.sourceDigest,
    baseCanonicalDigest: currentRevisionSnapshot.canonicalDigest
  }
})
assert.equal(staleRevisionPrepared.candidate.ok, false)
assert.equal(staleRevisionPrepared.candidate.reason, 'source-sync-owned-revision-stale')

const staleSourcePrepared = revisionBridge.prepareOwnedResult({
  ownership: {
    ...revisionOwnership,
    baseRevision: currentRevisionSnapshot.revision,
    baseSourceDigest: 'stale-source-digest',
    baseCanonicalDigest: currentRevisionSnapshot.canonicalDigest
  }
})
assert.equal(staleSourcePrepared.candidate.reason, 'source-sync-owned-source-stale')
const staleCanonicalPrepared = revisionBridge.prepareOwnedResult({
  ownership: {
    ...revisionOwnership,
    baseRevision: currentRevisionSnapshot.revision,
    baseSourceDigest: currentRevisionSnapshot.sourceDigest,
    baseCanonicalDigest: 'stale-canonical-digest'
  }
})
assert.equal(staleCanonicalPrepared.candidate.reason, 'source-sync-owned-canonical-stale')
assert.equal(revisionSource, 'revision-next\n', 'rejected owned revisions must not mutate source')
assert.equal(revisionCanonical, 'revision-next\n', 'rejected owned revisions must not mutate canonical')

const owner = createLegacySourceSyncOwner({
  preserve: (source, previous, next) => ({
    markdown: `${source.slice(0, -1)}!\n`,
    preserved: true,
    reason: `${previous}->${next}`,
    integrityProof: { kind: 'owner-proof' }
  })
})
const ownerCandidate = owner.createCandidate({
  snapshot: synchronized,
  previousCanonical: synchronized.canonical,
  nextCanonical: 'external!\n',
  expectedDoc: doc1,
  validationSite: 'owner-unit'
})
assert.equal(ownerCandidate.ok, true)
assert.equal(ownerCandidate.reason, 'external\n->external!\n')
assert.equal(ownerCandidate.proof.preservationProof.kind, 'owner-proof')

console.log('PASS source sync coordinator: revision, candidate/proof binding, stale rejection, validation, publication, checkpoints, and legacy owner')
