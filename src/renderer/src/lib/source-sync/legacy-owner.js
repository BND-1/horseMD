import {
  SOURCE_SYNC_OWNERS,
  createLegacyIntegrityProof,
  createSourceSyncCandidate
} from './proof.js'

const normalizeLegacyResult = (result, fallbackSource) => {
  if (typeof result === 'string') {
    return {
      markdown: result,
      preserved: true,
      reason: 'legacy-string',
      integrityProof: null
    }
  }
  if (result && typeof result.markdown === 'string') {
    return {
      markdown: result.markdown,
      preserved: result.preserved !== false,
      reason: result.reason || 'legacy-preservation',
      integrityProof: result.integrityProof || null
    }
  }
  return {
    markdown: String(fallbackSource || ''),
    preserved: false,
    reason: 'legacy-owner-missing-result',
    integrityProof: null
  }
}

export function createLegacySourceSyncCandidateFromResult({
  snapshot,
  result,
  canonical,
  expectedDoc = null,
  validationSite = '',
  family = 'legacy-preservation'
} = {}) {
  const normalized = normalizeLegacyResult(result, snapshot?.source)
  return createSourceSyncCandidate({
    snapshot,
    owner: SOURCE_SYNC_OWNERS.LEGACY,
    family,
    markdown: normalized.markdown,
    canonical,
    expectedDoc,
    reason: normalized.reason,
    proof: createLegacyIntegrityProof(normalized.integrityProof),
    preserved: normalized.preserved,
    validationSite
  })
}

export function blocksRetiredLegacySourceSyncFallback({
  ownerEntry,
  ownership
} = {}) {
  return Boolean(
    ownerEntry?.legacyRetired === true &&
    ownership?.ok !== true &&
    ownership?.recognized === true
  )
}

export function retiredLegacySourceSyncFailureReason(result) {
  if (result?.legacyBlocked !== true) return null
  return result.reason || 'retired-legacy-owner-rejected'
}

export function createLegacySourceSyncOwner({ preserve }) {
  if (typeof preserve !== 'function') {
    throw new TypeError('legacy source-sync owner requires a preserve function')
  }
  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.LEGACY,
    family: 'legacy-preservation',
    createCandidate({
      snapshot,
      previousCanonical = snapshot?.canonical ?? '',
      nextCanonical,
      expectedDoc = null,
      validationSite = ''
    } = {}) {
      const result = preserve(
        snapshot?.source ?? '',
        previousCanonical,
        String(nextCanonical ?? '')
      )
      return createLegacySourceSyncCandidateFromResult({
        snapshot,
        result,
        canonical: String(nextCanonical ?? ''),
        expectedDoc,
        validationSite
      })
    }
  })
}
