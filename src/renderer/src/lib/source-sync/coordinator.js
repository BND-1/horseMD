import { createSourceSyncCheckpointStore } from './checkpoints.js'
import { createSourceSyncPublication } from './publisher.js'
import {
  advanceSourceSyncSnapshot,
  createSourceSyncSnapshot,
  sourceSyncSnapshotMatches
} from './snapshot.js'

export function createSourceSyncCoordinator({
  initialSnapshot = null,
  source = '',
  canonical = '',
  doc = null,
  validator,
  commit = () => true,
  checkpointStore = createSourceSyncCheckpointStore(),
  trace = null
} = {}) {
  if (typeof validator !== 'function') {
    throw new TypeError('source-sync coordinator requires a validator')
  }
  if (typeof commit !== 'function') {
    throw new TypeError('source-sync coordinator requires a commit function')
  }

  let snapshot = initialSnapshot || createSourceSyncSnapshot({ source, canonical, doc })
  // Only the immediately previous candidate can be replayed against the live
  // revision. Older candidates are already rejected by baseRevision, so retain
  // one id instead of growing an unbounded history for long editor sessions.
  let lastConsumedCandidateId = null
  checkpointStore.trust(snapshot.source, snapshot.canonical, {
    revision: snapshot.revision,
    owner: snapshot.owner,
    reason: snapshot.reason
  })

  const emit = (entry) => {
    if (typeof trace === 'function') trace(entry)
  }

  const synchronize = ({
    source: nextSource,
    canonical: nextCanonical,
    doc: nextDoc = snapshot.doc,
    owner = 'external-checkpoint',
    family = 'external-checkpoint',
    reason = 'source-sync-external-checkpoint',
    trust = false
  } = {}) => {
    if (sourceSyncSnapshotMatches(snapshot, {
      source: nextSource,
      canonical: nextCanonical,
      doc: nextDoc
    })) return snapshot
    snapshot = advanceSourceSyncSnapshot(snapshot, {
      source: String(nextSource ?? ''),
      canonical: String(nextCanonical ?? ''),
      doc: nextDoc,
      owner,
      family,
      reason
    })
    if (trust) {
      checkpointStore.trust(snapshot.source, snapshot.canonical, {
        revision: snapshot.revision,
        owner,
        reason
      })
    }
    emit({ phase: 'synchronize', revision: snapshot.revision, owner, family, reason })
    return snapshot
  }

  const publishValidated = (candidate, validation, context = {}) => {
    if (!candidate?.ok) {
      return {
        ok: false,
        reason: candidate?.reason || 'source-sync-candidate-invalid',
        candidate,
        validation,
        snapshot
      }
    }
    if (candidate.candidateId === lastConsumedCandidateId) {
      return {
        ok: false,
        reason: 'source-sync-publication-already-consumed',
        candidate,
        validation,
        snapshot
      }
    }
    if (candidate.baseRevision !== snapshot.revision) {
      return { ok: false, reason: 'source-sync-candidate-stale', candidate, validation, snapshot }
    }
    if (!validation?.ok) {
      const reason = validation?.reason || 'source-sync-validation-failed'
      emit({
        phase: 'rejected',
        revision: snapshot.revision,
        owner: candidate.owner,
        family: candidate.family,
        reason
      })
      return { ok: false, reason, candidate, validation, snapshot }
    }

    const publication = createSourceSyncPublication({ snapshot, candidate, validation })
    if (!publication.ok) {
      return {
        ok: false,
        reason: publication.reason,
        candidate,
        validation,
        publication,
        snapshot
      }
    }

    const nextSnapshot = advanceSourceSyncSnapshot(snapshot, {
      source: publication.markdown,
      canonical: publication.canonical,
      doc: publication.expectedDoc,
      owner: publication.owner,
      family: publication.family,
      reason: publication.reason
    })
    let committed
    try {
      committed = commit({
        publication,
        previousSnapshot: snapshot,
        nextSnapshot,
        context
      })
    } catch (error) {
      return {
        ok: false,
        reason: `source-sync-commit-threw:${error?.name || 'Error'}`,
        candidate,
        validation,
        publication,
        snapshot
      }
    }
    if (committed === false) {
      return {
        ok: false,
        reason: 'source-sync-commit-rejected',
        candidate,
        validation,
        publication,
        snapshot
      }
    }

    lastConsumedCandidateId = candidate.candidateId
    snapshot = nextSnapshot
    checkpointStore.trust(snapshot.source, snapshot.canonical, {
      revision: snapshot.revision,
      owner: snapshot.owner,
      reason: snapshot.reason
    })
    emit({
      phase: 'published',
      revision: snapshot.revision,
      owner: publication.owner,
      family: publication.family,
      reason: publication.reason,
      boundary: context?.boundary || null
    })
    return {
      ok: true,
      candidate,
      validation,
      publication,
      snapshot
    }
  }

  const evaluate = (candidate, context = {}) => {
    if (!candidate?.ok) {
      return {
        ok: false,
        reason: candidate?.reason || 'source-sync-candidate-invalid',
        candidate,
        snapshot
      }
    }
    if (candidate.baseRevision !== snapshot.revision) {
      return { ok: false, reason: 'source-sync-candidate-stale', candidate, snapshot }
    }
    const validation = validator(candidate, {
      ...context,
      snapshot,
      checkpointStore
    })
    return publishValidated(candidate, validation, context)
  }

  return Object.freeze({
    getSnapshot: () => snapshot,
    getCheckpointStore: () => checkpointStore,
    synchronize,
    evaluate,
    publishValidated
  })
}
