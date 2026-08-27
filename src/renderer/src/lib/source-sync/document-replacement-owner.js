import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'

export const DOCUMENT_REPLACEMENT_BOUNDARIES = Object.freeze({
  RAW_MARKDOWN_PASTE: 'raw-markdown-paste',
  WHOLE_DOCUMENT: 'whole-document-replacement'
})

const sameDocument = (left, right) => {
  if (left === right) return true
  if (!left || !right) return false
  return typeof left.eq === 'function' ? left.eq(right) : false
}

const rejected = (reason, proof = null) => Object.freeze({
  ok: false,
  decision: 'rejected',
  reason,
  proof
})

const owned = ({ owner, family, boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: boundary,
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner,
    family,
    boundary,
    reason: boundary,
    proof,
    result,
    canonical,
    expectedDoc,
    publication: Object.freeze({
      ownership: null,
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
 * Owns two explicit document-replacement families that previously appeared as
 * unstructured branches inside markdownUpdated:
 *
 * - exact Markdown clipboard bytes inserted into a proven PM selection;
 * - one ReplaceStep whose pre-transaction AllSelection covered the whole doc.
 *
 * Mapping/formatting remains in the established helpers. This owner only binds
 * their result to the captured source/canonical baseline and resulting PM doc.
 */
export function createDocumentReplacementSourceSyncOwner({
  formatWholeDocumentSource
} = {}) {
  if (typeof formatWholeDocumentSource !== 'function') {
    throw new TypeError('document replacement owner requires formatWholeDocumentSource')
  }

  const captureRawMarkdownPaste = ({
    source,
    canonical,
    oldDoc,
    markdown,
    from,
    to,
    replacesWholeDocument = false
  } = {}) => {
    if (
      typeof source !== 'string' ||
      typeof canonical !== 'string' ||
      typeof markdown !== 'string' ||
      !oldDoc ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from < 0 ||
      to < from
    ) return rejected('raw-markdown-paste-capture-incomplete')

    const token = {
      kind: 'raw-markdown-paste',
      tokenId: sourceSyncDigest([
        sourceSyncDigest(source),
        sourceSyncDigest(canonical),
        sourceSyncDigest(markdown),
        from,
        to,
        replacesWholeDocument ? 1 : 0
      ].join('|')),
      source,
      canonical,
      oldDoc,
      expectedDoc: null,
      markdown,
      from,
      to,
      replacesWholeDocument: replacesWholeDocument === true,
      transactionBound: false,
      transactionCount: 0
    }
    return Object.freeze({ ok: true, token })
  }

  const bindRawMarkdownPasteTransaction = ({
    token,
    activeToken,
    transactions,
    oldDoc,
    newDoc
  } = {}) => {
    if (!token || activeToken !== token || token.kind !== 'raw-markdown-paste') {
      return rejected('raw-markdown-paste-token-stale')
    }
    if (!sameDocument(token.oldDoc, oldDoc) || !newDoc) {
      return rejected('raw-markdown-paste-transaction-baseline-mismatch')
    }
    const changed = (transactions || []).filter((transaction) => transaction?.docChanged)
    if (!changed.length) return rejected('raw-markdown-paste-transaction-missing')

    let document = oldDoc
    for (const transaction of changed) {
      if (!sameDocument(transaction.before, document) || !transaction.doc) {
        return rejected('raw-markdown-paste-transaction-chain-mismatch')
      }
      document = transaction.doc
    }
    if (!sameDocument(document, newDoc)) {
      return rejected('raw-markdown-paste-transaction-result-mismatch')
    }
    if (token.expectedDoc && !sameDocument(token.expectedDoc, newDoc)) {
      return rejected('raw-markdown-paste-transaction-rebound')
    }

    token.expectedDoc = newDoc
    token.transactionBound = true
    token.transactionCount = changed.length
    return Object.freeze({ ok: true, token })
  }

  const planRawMarkdownPaste = ({
    token,
    activeToken,
    currentSource,
    currentCanonical,
    canonical,
    expectedDoc
  } = {}) => {
    const boundary = DOCUMENT_REPLACEMENT_BOUNDARIES.RAW_MARKDOWN_PASTE
    if (!token || activeToken !== token || token.kind !== 'raw-markdown-paste') {
      return rejected('raw-markdown-paste-token-stale')
    }
    if (
      typeof currentSource !== 'string' ||
      typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' ||
      !expectedDoc
    ) return rejected('raw-markdown-paste-publication-incomplete')
    if (currentSource !== token.source || currentCanonical !== token.canonical) {
      return rejected('raw-markdown-paste-snapshot-stale')
    }
    if (
      !token.transactionBound ||
      !token.expectedDoc ||
      !sameDocument(token.expectedDoc, expectedDoc)
    ) return rejected('raw-markdown-paste-document-unproven')

    const proof = Object.freeze({
      kind: 'document-replacement-ownership-proof',
      mode: 'raw-markdown-paste',
      tokenId: token.tokenId,
      sourceDigest: sourceSyncDigest(token.source),
      canonicalDigest: sourceSyncDigest(token.canonical),
      markdownDigest: sourceSyncDigest(token.markdown),
      from: token.from,
      to: token.to,
      replacesWholeDocument: token.replacesWholeDocument,
      transactionCount: token.transactionCount,
      tokenIdentityMatched: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return owned({
      owner: SOURCE_SYNC_OWNERS.SOURCE,
      family: 'raw-markdown-paste',
      boundary,
      markdown: token.markdown,
      canonical,
      expectedDoc,
      proof
    })
  }

  const captureWholeDocumentReplacement = ({
    source,
    canonical,
    originalDoc,
    expectedDoc
  } = {}) => {
    if (
      typeof source !== 'string' ||
      typeof canonical !== 'string' ||
      !originalDoc ||
      !expectedDoc
    ) return rejected('whole-document-replacement-capture-incomplete')

    const token = Object.freeze({
      kind: 'whole-document-replacement',
      tokenId: sourceSyncDigest([
        sourceSyncDigest(source),
        sourceSyncDigest(canonical),
        sourceSyncDigest(JSON.stringify(originalDoc?.toJSON?.() || null)),
        sourceSyncDigest(JSON.stringify(expectedDoc?.toJSON?.() || null))
      ].join('|')),
      source,
      canonical,
      originalDoc,
      expectedDoc
    })
    return Object.freeze({ ok: true, token })
  }

  const planWholeDocumentReplacement = ({
    token,
    activeToken,
    currentSource,
    currentCanonical,
    canonical,
    replacementCanonical,
    expectedDoc
  } = {}) => {
    const boundary = DOCUMENT_REPLACEMENT_BOUNDARIES.WHOLE_DOCUMENT
    if (!token || activeToken !== token || token.kind !== 'whole-document-replacement') {
      return rejected('whole-document-replacement-token-stale')
    }
    if (
      typeof currentSource !== 'string' ||
      typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' ||
      typeof replacementCanonical !== 'string' ||
      !expectedDoc
    ) return rejected('whole-document-replacement-publication-incomplete')
    if (currentSource !== token.source || currentCanonical !== token.canonical) {
      return rejected('whole-document-replacement-snapshot-stale')
    }
    if (!sameDocument(token.expectedDoc, expectedDoc)) {
      return rejected('whole-document-replacement-document-mismatch')
    }

    let markdown
    try {
      markdown = formatWholeDocumentSource({
        canonical: replacementCanonical,
        previousSource: token.source
      })
    } catch (error) {
      return rejected(`whole-document-replacement-format-threw:${error?.name || 'Error'}`)
    }
    if (typeof markdown !== 'string') {
      return rejected('whole-document-replacement-format-invalid')
    }

    const proof = Object.freeze({
      kind: 'document-replacement-ownership-proof',
      mode: 'whole-document-replacement',
      tokenId: token.tokenId,
      sourceDigest: sourceSyncDigest(token.source),
      canonicalDigest: sourceSyncDigest(token.canonical),
      replacementCanonicalDigest: sourceSyncDigest(replacementCanonical),
      markdownDigest: sourceSyncDigest(markdown),
      tokenIdentityMatched: true,
      snapshotMatched: true,
      documentMatched: true,
      wholeDocument: true
    })
    return owned({
      owner: SOURCE_SYNC_OWNERS.TRANSACTION,
      family: 'whole-document-replacement',
      boundary,
      markdown,
      canonical,
      expectedDoc,
      proof
    })
  }

  return Object.freeze({
    captureRawMarkdownPaste,
    bindRawMarkdownPasteTransaction,
    planRawMarkdownPaste,
    captureWholeDocumentReplacement,
    planWholeDocumentReplacement
  })
}
