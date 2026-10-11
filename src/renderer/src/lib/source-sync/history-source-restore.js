import { isHistoryTransaction } from '@milkdown/prose/history'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import { sameIgnoringHeadingIds } from './editor-only-document.js'

/**
 * Undo/redo source restoration (fuzz seeds 28/36).
 *
 * Rich undo can step back across a source-mode edit: replaceMarkdown's
 * whole-document ReplaceStep is in ProseMirror history, so its inverse
 * restores the pre-edit document in one step (and may turn e.g. a paragraph
 * back into a table). No focused owner can localize that, and the legacy
 * canonical diff fails closed (`unmapped-table-change`), leaving every later
 * edit stranded until Save falls into the recovery prompt.
 *
 * The exact author bytes for such a document are already known: we recorded
 * them when the document was current. This keeps a small ring of
 * (document, source) pairs captured at moments when they were proven to
 * correspond — a Coordinator snapshot whose doc is the live doc, and both
 * sides of a source-mode replacement. A history transaction whose result is
 * one of those documents restores that source; the candidate still goes
 * through the normal Coordinator validator, so a stale record fails closed.
 */
const sameDocument = (left, right) => {
  if (left === right) return true
  if (!left || !right || typeof left.eq !== 'function') return false
  return left.eq(right) || sameIgnoringHeadingIds(left, right)
}

export function isHistoryTransactionBatch(transactions) {
  return (transactions || []).some((transaction) => {
    try {
      return transaction?.docChanged && isHistoryTransaction(transaction)
    } catch {
      return false
    }
  })
}

export function createSourceSnapshotHistory({ limit = 64 } = {}) {
  let entries = []

  const record = ({ doc, source } = {}) => {
    if (!doc || typeof doc.eq !== 'function' || typeof source !== 'string') return false
    const last = entries[entries.length - 1]
    if (last && last.doc === doc && last.source === source) return false
    entries.push(Object.freeze({ doc, source }))
    if (entries.length > limit) entries = entries.slice(entries.length - limit)
    return true
  }

  // Newest first: when the same document appears with different bytes (e.g. a
  // whitespace-only source edit), the most recent spelling wins.
  // Only history transactions call this, so a bounded eq scan is cheap.
  const find = (doc) => {
    if (!doc) return null
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (sameDocument(entries[index].doc, doc)) return entries[index]
    }
    return null
  }

  return Object.freeze({
    record,
    find,
    clear: () => { entries = [] },
    get size() { return entries.length }
  })
}

export function planHistorySourceRestore({
  history,
  transactions,
  newDoc,
  currentSource,
  currentCanonical,
  canonical
} = {}) {
  if (!isHistoryTransactionBatch(transactions)) {
    return Object.freeze({ ok: false, reason: 'history-restore-not-history' })
  }
  const entry = history?.find?.(newDoc)
  if (!entry) return Object.freeze({ ok: false, reason: 'history-restore-unknown-document' })
  if (typeof canonical !== 'string') {
    return Object.freeze({ ok: false, reason: 'history-restore-canonical-missing' })
  }
  const boundary = 'history-source-restore'
  const proof = Object.freeze({
    kind: 'history-source-restore-proof',
    sourceDigest: sourceSyncDigest(String(currentSource ?? '')),
    canonicalDigest: sourceSyncDigest(String(currentCanonical ?? '')),
    restoredDigest: sourceSyncDigest(entry.source),
    documentMatched: true
  })
  const result = Object.freeze({
    markdown: entry.source,
    preserved: true,
    reason: boundary,
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.SOURCE,
    family: 'history-source-restore',
    boundary,
    reason: boundary,
    proof,
    result,
    canonical,
    expectedDoc: newDoc
  })
}
