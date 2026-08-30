const sameDocument = (left, right) => {
  if (left === right) return true
  if (!left || !right) return false
  return typeof left.eq === 'function' ? left.eq(right) : false
}

const normalizePathList = (value) => Object.freeze(
  (Array.isArray(value) ? value : [])
    .filter((path) =>
      Array.isArray(path) &&
      path.length >= 1 &&
      path.every((index) => Number.isInteger(index) && index >= 0)
    )
    .map((path) => Object.freeze([...path]))
)

const normalizeSemanticContext = (value) => Object.freeze({
  trailingEmptyBlockquoteParagraphPaths: normalizePathList(
    value?.trailingEmptyBlockquoteParagraphPaths
  )
})

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
  reason = 'initial-source-sync-snapshot',
  semanticContext = null
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
    reason: String(reason || 'unknown'),
    semanticContext: normalizeSemanticContext(semanticContext)
  })
}

export function advanceSourceSyncSnapshot(snapshot, {
  source = snapshot?.source ?? '',
  canonical = snapshot?.canonical ?? '',
  doc = snapshot?.doc ?? null,
  owner = 'unknown',
  family = 'unknown',
  reason = 'source-sync-publication',
  semanticContext = snapshot?.semanticContext ?? null
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
    reason,
    semanticContext
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
