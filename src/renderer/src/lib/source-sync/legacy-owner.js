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



