const sameDocument = (left, right) => {
  if (left === right) return true
  if (!left || !right) return false
  return typeof left.eq === 'function' ? left.eq(right) : false
}

export const sourceSyncDigest = (value) => {
  const text = String(value ?? '')
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${text.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function createSourceSyncSnapshot({
  revision = 0,
  source = '',
  canonical = '',
  doc = null,
  parentRevision = null,
  owner = 'bootstrap',
  family = 'bootstrap',
  reason = 'initial-source-sync-snapshot'
} = {}) {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new TypeError('source-sync snapshot revision must be a non-negative integer')
  }
  const authoredSource = String(source ?? '')
  const canonicalMarkdown = String(canonical ?? '')
  return Object.freeze({
    revision,
    source: authoredSource,
    canonical: canonicalMarkdown,
    doc,
    sourceDigest: sourceSyncDigest(authoredSource),
    canonicalDigest: sourceSyncDigest(canonicalMarkdown),
    parentRevision: Number.isInteger(parentRevision) ? parentRevision : null,
    owner: String(owner || 'unknown'),
    family: String(family || 'unknown'),
    reason: String(reason || 'unknown')
  })
}

export function advanceSourceSyncSnapshot(snapshot, {
  source = snapshot?.source ?? '',
  canonical = snapshot?.canonical ?? '',
  doc = snapshot?.doc ?? null,
  owner = 'unknown',
  family = 'unknown',
  reason = 'source-sync-publication'
} = {}) {
  if (!snapshot || !Number.isInteger(snapshot.revision)) {
    throw new TypeError('source-sync snapshot is required')
  }
  return createSourceSyncSnapshot({
    revision: snapshot.revision + 1,
    source,
    canonical,
    doc,
    parentRevision: snapshot.revision,
    owner,
    family,
    reason
  })
}

export const sourceSyncSnapshotMatches = (snapshot, {
  source,
  canonical,
  doc = snapshot?.doc ?? null
} = {}) => Boolean(
  snapshot &&
  snapshot.source === String(source ?? '') &&
  snapshot.canonical === String(canonical ?? '') &&
  sameDocument(snapshot.doc, doc)
)
