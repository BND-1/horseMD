import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'

export const LIST_CONVERSION_SNAPSHOT_BOUNDARIES = Object.freeze({
  BLOCK_TO_LIST: 'block-to-list-command-snapshot',
  LIST_TYPE: 'list-conversion-command-snapshot'
})

const listTargets = new Set(['bullet_list', 'ordered_list', 'task_list'])

const sameDocument = (left, right) => {
  if (left === right) return true
  if (!left || !right) return false
  return typeof left.eq === 'function' ? left.eq(right) : false
}

const rejected = (reason, proof = null) => Object.freeze({
  ok: false,
  reason,
  proof
})

const createOwnedPlan = ({
  boundary,
  markdown,
  canonical,
  expectedDoc,
  proof,
  mapperReason = null
}) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: mapperReason || boundary,
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    owner: SOURCE_SYNC_OWNERS.LEGACY,
    family: 'legacy-preservation',
    boundary,
    proof,
    result,
    publication: Object.freeze({
      result,
      canonical,
      expectedDoc,
      validationSite: boundary,
      boundary,
      notifyChange: true
    })
  })
}

/**
 * Owns only the synchronous source snapshot produced by an already-successful
 * list command. Mapping and list transformation stay in their existing helpers;
 * this module proves that the computed source/canonical pair still belongs to
 * the exact pre-command baseline and converted PM document before Coordinator
 * publication. Any stale/missing proof defers to markdownUpdated.
 */
export function createListConversionSnapshotSourceSyncOwner() {
  const planBlockToList = ({
    source,
    previousCanonical,
    currentSource,
    currentCanonical,
    result,
    canonical,
    expectedDoc,
    targetType,
    sourceOffset = null
  } = {}) => {
    const boundary = LIST_CONVERSION_SNAPSHOT_BOUNDARIES.BLOCK_TO_LIST
    if (!listTargets.has(targetType)) return rejected('block-to-list-target-invalid')
    if (
      typeof source !== 'string' ||
      typeof previousCanonical !== 'string' ||
      typeof currentSource !== 'string' ||
      typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' ||
      !expectedDoc
    ) return rejected('block-to-list-snapshot-incomplete')
    if (currentSource !== source || currentCanonical !== previousCanonical) {
      return rejected('block-to-list-snapshot-stale')
    }
    if (!result || typeof result.markdown !== 'string') {
      return rejected('block-to-list-result-missing')
    }
    if (result.preserved === false) {
      return rejected(result.reason || 'block-to-list-result-rejected')
    }
    if (result.markdown === source || canonical === previousCanonical) {
      return rejected('block-to-list-snapshot-no-change')
    }

    const proof = Object.freeze({
      kind: 'list-conversion-command-snapshot',
      mode: 'block-to-list',
      targetType,
      sourceOffset: Number.isFinite(sourceOffset) ? sourceOffset : null,
      sourceDigest: sourceSyncDigest(source),
      previousCanonicalDigest: sourceSyncDigest(previousCanonical),
      markdownDigest: sourceSyncDigest(result.markdown),
      canonicalDigest: sourceSyncDigest(canonical),
      mapperReason: result.reason || null
    })
    return createOwnedPlan({
      boundary,
      markdown: result.markdown,
      canonical,
      expectedDoc,
      proof,
      mapperReason: result.reason || 'block-to-list-command-snapshot'
    })
  }

  const planListTypeConversion = ({
    token,
    activeToken,
    currentSource,
    currentCanonical,
    expectedDoc
  } = {}) => {
    const boundary = LIST_CONVERSION_SNAPSHOT_BOUNDARIES.LIST_TYPE
    if (!token || activeToken !== token) {
      return rejected('list-conversion-command-token-stale')
    }
    if (!listTargets.has(token.targetType)) {
      return rejected('list-conversion-command-target-invalid')
    }
    if (
      typeof token.source !== 'string' ||
      typeof token.previous !== 'string' ||
      typeof token.convertedSource !== 'string' ||
      typeof token.convertedCanonical !== 'string' ||
      typeof currentSource !== 'string' ||
      typeof currentCanonical !== 'string' ||
      !token.convertedDoc ||
      !expectedDoc
    ) return rejected('list-conversion-command-snapshot-incomplete')
    if (currentSource !== token.source || currentCanonical !== token.previous) {
      return rejected('list-conversion-command-snapshot-stale')
    }
    if (!sameDocument(token.convertedDoc, expectedDoc)) {
      return rejected('list-conversion-command-document-mismatch')
    }
    if (
      token.convertedSource === token.source ||
      token.convertedCanonical === token.previous
    ) return rejected('list-conversion-command-snapshot-no-change')

    const proof = Object.freeze({
      kind: 'list-conversion-command-snapshot',
      mode: 'list-type-conversion',
      targetType: token.targetType,
      sourceOffset: Number.isFinite(token.sourceOffset) ? token.sourceOffset : null,
      previousOffset: Number.isFinite(token.previousOffset) ? token.previousOffset : null,
      listPos: Number.isFinite(token.listPos) ? token.listPos : null,
      anchorPos: Number.isFinite(token.anchorPos) ? token.anchorPos : null,
      sourceDigest: sourceSyncDigest(token.source),
      previousCanonicalDigest: sourceSyncDigest(token.previous),
      markdownDigest: sourceSyncDigest(token.convertedSource),
      canonicalDigest: sourceSyncDigest(token.convertedCanonical),
      tokenIdentityMatched: true,
      convertedDocumentMatched: true
    })
    return createOwnedPlan({
      boundary,
      markdown: token.convertedSource,
      canonical: token.convertedCanonical,
      expectedDoc,
      proof
    })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.LEGACY,
    family: 'legacy-preservation',
    planBlockToList,
    planListTypeConversion
  })
}
