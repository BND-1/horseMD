import { createLegacySourceSyncCandidateFromResult } from './legacy-owner.js'
import { createSourceSyncCoordinator } from './coordinator.js'
import { createSourceSyncCandidate } from './proof.js'
import {
  createSourceSyncValidator,
  sourceSyncSemanticOptionsFromContext
} from './validator.js'

const sameDocument = (left, right) => {
  if (left === right) return true
  if (!left || !right) return false
  return typeof left.eq === 'function' ? left.eq(right) : false
}

/**
 * Phase-A adapter between Editor's live refs and the pure SourceSyncCoordinator.
 * It keeps candidate creation, validation and publication on one snapshot
 * revision without teaching the coordinator about React or Crepe.
 */
export function createEditorSourceSyncBridge({
  checkpointStore,
  getSource,
  getCanonical,
  getExpectedDoc = () => null,
  setSource,
  setCanonical,
  onChange = null,
  validateLegacyCandidate,
  trace = null
} = {}) {
  if (!checkpointStore?.has || !checkpointStore?.trust) {
    throw new TypeError('editor source-sync bridge requires checkpointStore')
  }
  for (const [name, value] of Object.entries({
    getSource,
    getCanonical,
    setSource,
    setCanonical,
    validateLegacyCandidate
  })) {
    if (typeof value !== 'function') {
      throw new TypeError(`editor source-sync bridge requires ${name}`)
    }
  }

  const candidateValidator = createSourceSyncValidator({
    validate: (candidate, { snapshot }) => validateLegacyCandidate(
      candidate.markdown,
      candidate.expectedDoc,
      candidate.canonical,
      snapshot.source,
      candidate.reason,
      candidate.proof?.preservationProof || null,
      candidate.validationSite,
      {
        trustCheckpoint: false,
        inheritedSemanticContext: snapshot.semanticContext
      }
    )
  })

  const commitPublication = ({ publication, context }) => {
    const previousSource = getSource()
    const previousCanonical = getCanonical()
    try {
      setSource(publication.markdown)
      setCanonical(publication.canonical)
      if (context?.notifyChange !== false && typeof onChange === 'function') {
        onChange(publication.markdown)
      }
      return true
    } catch (error) {
      // Coordinator advances its revision only after commit succeeds. Restore
      // the two live refs as one best-effort host transaction before rethrowing
      // so a failed App callback cannot leave Editor on a half-applied snapshot.
      try { setCanonical(previousCanonical) } catch { /* best-effort rollback */ }
      try { setSource(previousSource) } catch { /* best-effort rollback */ }
      throw error
    }
  }

  let coordinator = null
  const getCoordinator = () => {
    if (coordinator) return coordinator
    coordinator = createSourceSyncCoordinator({
      source: getSource(),
      canonical: getCanonical(),
      validator: candidateValidator,
      checkpointStore,
      commit: commitPublication,
      trace
    })
    return coordinator
  }

  const synchronizeCurrent = (boundary = 'editor') => {
    const currentSource = String(getSource() ?? '')
    const currentCanonical = String(getCanonical() ?? '')
    return getCoordinator().synchronize({
      source: currentSource,
      canonical: currentCanonical,
      owner: 'legacy-compatibility',
      family: 'legacy-compatibility',
      reason: `synchronize-before-${boundary}`,
      trust: checkpointStore.has(currentSource, currentCanonical)
    })
  }

  const preparedResult = ({
    activeCoordinator,
    snapshot,
    candidate,
    validation,
    boundary
  }) => Object.freeze({
    coordinator: activeCoordinator,
    snapshot,
    candidate,
    validation,
    boundary
  })

  const prepare = ({
    result,
    canonical,
    expectedDoc = getExpectedDoc(),
    validationSite = '',
    boundary = 'editor'
  } = {}) => {
    const activeCoordinator = getCoordinator()
    const snapshot = synchronizeCurrent(boundary)
    const candidate = createLegacySourceSyncCandidateFromResult({
      snapshot,
      result,
      canonical: String(canonical ?? ''),
      expectedDoc,
      validationSite
    })
    const validation = candidateValidator(candidate, {
      snapshot,
      checkpointStore
    })
    return preparedResult({
      activeCoordinator,
      snapshot,
      candidate,
      validation,
      boundary
    })
  }

  const ownedSnapshotMismatchReason = (ownership, snapshot) => {
    if (
      Number.isInteger(ownership?.baseRevision) &&
      ownership.baseRevision !== snapshot.revision
    ) return 'source-sync-owned-revision-stale'
    if (
      typeof ownership?.baseSourceDigest === 'string' &&
      ownership.baseSourceDigest !== snapshot.sourceDigest
    ) return 'source-sync-owned-source-stale'
    if (
      typeof ownership?.baseCanonicalDigest === 'string' &&
      ownership.baseCanonicalDigest !== snapshot.canonicalDigest
    ) return 'source-sync-owned-canonical-stale'
    return null
  }

  const prepareOwnedResult = ({
    ownership,
    canonical = ownership?.canonical,
    expectedDoc = ownership?.expectedDoc || getExpectedDoc(),
    validationSite = ownership?.boundary || '',
    boundary = ownership?.boundary || 'editor'
  } = {}) => {
    const activeCoordinator = getCoordinator()
    const snapshot = synchronizeCurrent(boundary)
    if (
      !ownership?.ok ||
      ownership.decision !== 'owned' ||
      !ownership.owner ||
      !ownership.family ||
      typeof ownership.result?.markdown !== 'string'
    ) {
      const reason = ownership?.reason || 'source-sync-owned-result-invalid'
      const candidate = Object.freeze({
        ok: false,
        reason,
        owner: ownership?.owner || null,
        family: ownership?.family || null
      })
      return preparedResult({
        activeCoordinator,
        snapshot,
        candidate,
        validation: Object.freeze({ ok: false, reason }),
        boundary
      })
    }

    const snapshotReason = ownedSnapshotMismatchReason(ownership, snapshot)
    if (snapshotReason) {
      const candidate = Object.freeze({
        ok: false,
        reason: snapshotReason,
        owner: ownership.owner,
        family: ownership.family
      })
      return preparedResult({
        activeCoordinator,
        snapshot,
        candidate,
        validation: Object.freeze({ ok: false, reason: snapshotReason }),
        boundary
      })
    }

    const result = ownership.result
    const candidate = createSourceSyncCandidate({
      snapshot,
      owner: ownership.owner,
      family: ownership.family,
      markdown: result.markdown,
      canonical: String(canonical ?? ''),
      expectedDoc,
      reason: result.reason || ownership.reason || 'source-sync-owned-result',
      proof: {
        kind: 'owned-source-sync-proof',
        ownershipProof: ownership.proof || null,
        preservationProof: result.integrityProof || null
      },
      preserved: result.preserved !== false,
      validationSite
    })
    const validation = candidateValidator(candidate, {
      snapshot,
      checkpointStore
    })
    return preparedResult({
      activeCoordinator,
      snapshot,
      candidate,
      validation,
      boundary
    })
  }

  const publishPrepared = (prepared, {
    notifyChange = true,
    boundary = prepared?.boundary || 'editor'
  } = {}) => {
    if (!prepared?.candidate?.ok) {
      return {
        ok: false,
        reason: prepared?.candidate?.reason || 'source-sync-prepared-candidate-invalid'
      }
    }
    if (
      String(getSource() ?? '') !== prepared.snapshot.source ||
      String(getCanonical() ?? '') !== prepared.snapshot.canonical
    ) {
      return {
        ok: false,
        reason: 'source-sync-live-snapshot-stale',
        candidate: prepared.candidate,
        validation: prepared.validation
      }
    }
    if (!sameDocument(getExpectedDoc(), prepared.candidate.expectedDoc)) {
      return {
        ok: false,
        reason: 'source-sync-live-document-stale',
        candidate: prepared.candidate,
        validation: prepared.validation
      }
    }
    return prepared.coordinator.publishValidated(
      prepared.candidate,
      prepared.validation,
      { notifyChange, boundary }
    )
  }

  const publish = ({
    notifyChange = true,
    boundary = 'editor',
    ...candidateInput
  } = {}) => publishPrepared(
    prepare({ ...candidateInput, boundary }),
    { notifyChange, boundary }
  )

  const publishOwned = ({
    ownership,
    notifyChange = true,
    boundary = ownership?.boundary || 'editor',
    ...candidateInput
  } = {}) => publishPrepared(
    prepareOwnedResult({
      ownership,
      boundary,
      ...candidateInput
    }),
    { notifyChange, boundary }
  )

  return Object.freeze({
    getCoordinator,
    getSnapshot: () => getCoordinator().getSnapshot(),
    getSemanticOptions: (expectedDoc = getExpectedDoc()) =>
      sourceSyncSemanticOptionsFromContext(
        getCoordinator().getSnapshot().semanticContext,
        expectedDoc
      ),
    synchronizeCurrent,
    prepare,
    prepareOwnedResult,
    publishPrepared,
    publishOwned,
    publish
  })
}
