const notOwned = (reason, skipped = false) => Object.freeze({
  attempted: false,
  ok: false,
  skipped,
  reason
})

/**
 * Forced save/source-mode boundaries must ask the revision-bound transaction
 * journal before using the canonical-equal committed-baseline fast path.
 *
 * Some focused families (currently table column widths) change only editor PM
 * metadata that GFM cannot serialize. Their canonical Markdown is intentionally
 * unchanged, but Coordinator still needs to advance expectedDoc. Keep this
 * policy pure so editor-api and permanent Node contracts share one decision.
 */
export function publishPendingSourceSyncJournalForFlush({
  generatedScratch = false,
  publishPendingTransactionJournal = null,
  canonical,
  expectedDoc
} = {}) {
  if (generatedScratch) return notOwned('generated-scratch-authority', true)
  if (typeof publishPendingTransactionJournal !== 'function') {
    return notOwned('pending-transaction-journal-unavailable', true)
  }
  const result = publishPendingTransactionJournal({
    canonical,
    expectedDoc,
    notifyChange: false
  })
  if (!result || typeof result !== 'object') {
    return Object.freeze({
      attempted: true,
      ok: false,
      reason: 'pending-transaction-journal-invalid-result'
    })
  }
  return result
}
