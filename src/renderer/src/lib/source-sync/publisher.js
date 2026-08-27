import { sourceSyncDigest } from './snapshot.js'
import { sourceSyncCandidateMatchesValidation } from './proof.js'

export function createSourceSyncPublication({ snapshot, candidate, validation } = {}) {
  const reject = (reason) => Object.freeze({ ok: false, reason })
  if (!snapshot || !Number.isInteger(snapshot.revision)) {
    return reject('publication-missing-snapshot')
  }
  if (!candidate?.ok) return reject(candidate?.reason || 'publication-invalid-candidate')
  if (candidate.baseRevision !== snapshot.revision) return reject('publication-stale-revision')
  if (candidate.baseSourceDigest !== snapshot.sourceDigest) return reject('publication-stale-source')
  if (candidate.baseCanonicalDigest !== snapshot.canonicalDigest) return reject('publication-stale-canonical')
  if (!validation?.ok) return reject(validation?.reason || 'publication-validation-failed')
  if (!sourceSyncCandidateMatchesValidation(candidate, validation)) {
    return reject('publication-validation-binding-mismatch')
  }
  const publicationId = sourceSyncDigest([
    candidate.candidateId,
    validation.validationId,
    snapshot.revision
  ].join('|'))
  return Object.freeze({
    ok: true,
    publicationId,
    owner: candidate.owner,
    family: candidate.family,
    baseRevision: candidate.baseRevision,
    markdown: candidate.markdown,
    canonical: candidate.canonical,
    expectedDoc: candidate.expectedDoc,
    reason: candidate.reason,
    proof: candidate.proof,
    candidate,
    validation
  })
}
