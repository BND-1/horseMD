import { sourceSyncDigest } from './snapshot.js'

const stableValue = (value, seen = new WeakSet()) => {
  if (value == null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen))
  const result = {}
  for (const key of Object.keys(value).sort()) {
    const item = value[key]
    if (typeof item === 'function' || typeof item === 'undefined') continue
    result[key] = stableValue(item, seen)
  }
  return result
}

const stableStringify = (value) => {
  try {
    return JSON.stringify(stableValue(value))
  } catch {
    return String(value ?? '')
  }
}

const freezePlain = (value) => {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    value.forEach(freezePlain)
    return Object.freeze(value)
  }
  Object.values(value).forEach(freezePlain)
  return Object.freeze(value)
}

export const SOURCE_SYNC_OWNERS = Object.freeze({
  LEGACY: 'legacy',
  TRANSACTION: 'transaction',
  SOURCE: 'source',
  GENERATED: 'generated'
})

export function createLegacyIntegrityProof(preservationProof = null) {
  return freezePlain({
    kind: 'legacy-integrity-proof',
    preservationProof: preservationProof == null
      ? null
      : stableValue(preservationProof)
  })
}

export function createSourceSyncCandidate({
  snapshot,
  owner,
  family,
  markdown,
  canonical,
  expectedDoc = null,
  reason = 'source-sync-candidate',
  proof = null,
  preserved = true,
  validationSite = ''
} = {}) {
  const reject = (candidateReason) => Object.freeze({
    ok: false,
    reason: candidateReason,
    owner: owner || null,
    family: family || null
  })
  if (!snapshot || !Number.isInteger(snapshot.revision)) {
    return reject('candidate-missing-snapshot')
  }
  if (typeof markdown !== 'string') return reject('candidate-missing-markdown')
  if (typeof canonical !== 'string') return reject('candidate-missing-canonical')
  if (!owner) return reject('candidate-missing-owner')
  if (!family) return reject('candidate-missing-family')

  const normalizedProof = proof == null ? null : freezePlain(stableValue(proof))
  const markdownDigest = sourceSyncDigest(markdown)
  const canonicalDigest = sourceSyncDigest(canonical)
  const proofDigest = sourceSyncDigest(stableStringify(normalizedProof))
  const candidateId = sourceSyncDigest([
    snapshot.revision,
    owner,
    family,
    markdownDigest,
    canonicalDigest,
    String(reason || ''),
    proofDigest
  ].join('|'))

  return Object.freeze({
    ok: true,
    candidateId,
    owner: String(owner),
    family: String(family),
    baseRevision: snapshot.revision,
    baseSourceDigest: snapshot.sourceDigest,
    baseCanonicalDigest: snapshot.canonicalDigest,
    markdown,
    canonical,
    markdownDigest,
    canonicalDigest,
    expectedDoc,
    reason: String(reason || 'source-sync-candidate'),
    proof: normalizedProof,
    proofDigest,
    preserved: preserved !== false,
    validationSite: String(validationSite || '')
  })
}

export function bindSourceSyncValidation(candidate, validation = {}) {
  if (!candidate?.ok) {
    return Object.freeze({
      ok: false,
      reason: candidate?.reason || 'validation-missing-candidate',
      candidateId: candidate?.candidateId || null
    })
  }
  const result = validation && typeof validation === 'object'
    ? validation
    : { ok: validation === true }
  const ok = result.ok === true
  const reason = ok ? null : String(result.reason || 'source-sync-validation-failed')
  const validationId = sourceSyncDigest([
    candidate.candidateId,
    ok ? '1' : '0',
    reason || '',
    stableStringify(result)
  ].join('|'))
  return Object.freeze({
    ...result,
    ok,
    reason,
    validationId,
    candidateId: candidate.candidateId,
    baseRevision: candidate.baseRevision,
    markdownDigest: candidate.markdownDigest,
    canonicalDigest: candidate.canonicalDigest,
    expectedDoc: candidate.expectedDoc
  })
}

export const sourceSyncCandidateMatchesValidation = (candidate, validation) => Boolean(
  candidate?.ok &&
  validation &&
  validation.candidateId === candidate.candidateId &&
  validation.baseRevision === candidate.baseRevision &&
  validation.markdownDigest === candidate.markdownDigest &&
  validation.canonicalDigest === candidate.canonicalDigest &&
  validation.expectedDoc === candidate.expectedDoc
)
