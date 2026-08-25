import { pmPosToMarkdownOffset } from '../components/editor-source-map.js'
import { mapPlainTextTransactionsToSource } from './source-transaction-sync.js'

export const TRANSACTION_FIRST_MODES = Object.freeze({
  SHADOW: 'shadow',
  OBSERVE: 'observe',
  AUTHORITATIVE: 'authoritative'
})

const validModes = new Set(Object.values(TRANSACTION_FIRST_MODES))

const normalizeMappingSource = (source) => {
  const raw = String(source || '')
  const withoutBom = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
  return withoutBom.replace(/\r\n|\r/g, '\n')
}

const sameDocument = (left, right) => {
  if (!left || !right) return false
  if (left === right) return true
  return typeof left.eq === 'function' ? left.eq(right) : false
}

const isSimplePlainParagraph = (node) => {
  if (!node?.isTextblock || node.type?.name !== 'paragraph' || node.content?.size <= 0) return false
  let simple = true
  node.descendants((child) => {
    if (!child.isText || (child.marks?.length || 0) > 0) simple = false
    return false
  })
  return simple
}

const rangeContains = (entry, pmPos) =>
  pmPos >= entry.pmContentStart && pmPos <= entry.pmContentEnd

/**
 * Phase-0 source map: only top-level plain paragraphs whose complete PM body is
 * one contiguous, byte-identical range in the normalized authored Markdown.
 *
 * The returned offsets intentionally use the same normalized coordinate space
 * as mapPlainTextTransactionsToSource(): BOM removed and CRLF/CR converted to
 * LF. The transaction mapper itself keeps the original bytes in lockstep.
 */
export function buildPlainParagraphSourceRangeMap({
  source,
  doc,
  remark,
  mapPosition = pmPosToMarkdownOffset
}) {
  const normalizedSource = normalizeMappingSource(source)
  const entries = []
  const rejected = []

  if (!doc || typeof doc.forEach !== 'function') {
    return {
      ok: false,
      reason: 'missing-document',
      source: String(source || ''),
      normalizedSource,
      doc,
      entries,
      rejected,
      mapPosition: () => null
    }
  }
  if (!remark || typeof mapPosition !== 'function') {
    return {
      ok: false,
      reason: 'missing-markdown-position-mapper',
      source: String(source || ''),
      normalizedSource,
      doc,
      entries,
      rejected,
      mapPosition: () => null
    }
  }

  doc.forEach((node, pmBlockStart) => {
    if (!isSimplePlainParagraph(node)) {
      rejected.push({ pmBlockStart, nodeType: node?.type?.name || 'unknown', reason: 'unsupported-block' })
      return
    }

    const pmContentStart = pmBlockStart + 1
    const pmContentEnd = pmContentStart + node.content.size
    const rawStart = mapPosition(normalizedSource, pmContentStart, doc, remark)
    const rawEnd = mapPosition(normalizedSource, pmContentEnd, doc, remark)
    const text = node.textContent || ''

    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart > rawEnd) {
      rejected.push({ pmBlockStart, nodeType: node.type.name, reason: 'unmapped-body' })
      return
    }
    if (rawEnd - rawStart !== node.content.size || normalizedSource.slice(rawStart, rawEnd) !== text) {
      rejected.push({ pmBlockStart, nodeType: node.type.name, reason: 'non-contiguous-authored-body' })
      return
    }

    entries.push({
      nodeType: node.type.name,
      pmBlockStart,
      pmContentStart,
      pmContentEnd,
      rawStart,
      rawEnd,
      text
    })
  })

  const snapshotMapPosition = (markdown, pmPos, stepDoc) => {
    if (String(markdown || '') !== normalizedSource) return null
    if (!sameDocument(stepDoc, doc)) return null
    const matches = entries.filter((entry) => rangeContains(entry, pmPos))
    if (matches.length !== 1) return null
    const entry = matches[0]
    return entry.rawStart + (pmPos - entry.pmContentStart)
  }

  return {
    ok: true,
    reason: 'plain-paragraph-source-map',
    source: String(source || ''),
    normalizedSource,
    doc,
    entries,
    rejected,
    mapPosition: snapshotMapPosition
  }
}

const normalizeLegacyResult = (legacyResult) => {
  if (typeof legacyResult === 'string') {
    return { markdown: legacyResult, reason: 'legacy-string' }
  }
  if (legacyResult && typeof legacyResult.markdown === 'string') {
    return {
      markdown: legacyResult.markdown,
      reason: legacyResult.reason || 'legacy-result',
      preserved: legacyResult.preserved
    }
  }
  return null
}

const phaseOneBatchOwned = (transactions) => {
  const changed = (transactions || []).filter((transaction) => transaction?.docChanged)
  if (changed.length !== 1) return false
  return changed[0].steps?.length === 1 && changed[0].steps[0]?.constructor?.name === 'ReplaceStep'
}

const stepNamesFor = (transactions) =>
  (transactions || []).flatMap((transaction) =>
    (transaction?.steps || []).map((step) => step?.constructor?.name || 'UnknownStep'))

const computeTransactionCandidate = ({
  source,
  transactions,
  oldState,
  newState,
  sourceRangeMap,
  blockHints = [],
  validateMarkdown
}) => {
  const original = String(source || '')
  if (!sourceRangeMap?.ok) {
    return {
      ok: false,
      markdown: original,
      reason: sourceRangeMap?.reason || 'missing-source-range-map'
    }
  }
  if (sourceRangeMap.source !== original || !sameDocument(sourceRangeMap.doc, oldState?.doc)) {
    return { ok: false, markdown: original, reason: 'stale-source-range-map' }
  }
  if (!phaseOneBatchOwned(transactions)) {
    return { ok: false, markdown: original, reason: 'phase1-batch-not-owned' }
  }
  return mapPlainTextTransactionsToSource({
    source: original,
    transactions,
    oldState,
    newState,
    mapPosition: sourceRangeMap.mapPosition,
    blockHints,
    validateMarkdown
  })
}

const compareCandidates = (transactionResult, legacy) => {
  if (!transactionResult?.ok) return 'transaction-rejected'
  if (!legacy) return 'legacy-unavailable'
  return transactionResult.markdown === legacy.markdown ? 'byte-equal' : 'byte-diverged'
}

const trace = (event) => {
  if (!Array.isArray(globalThis.__hmTransactionFirstTrace)) return
  globalThis.__hmTransactionFirstTrace.push(event)
  if (globalThis.__hmTransactionFirstTrace.length > 200) {
    globalThis.__hmTransactionFirstTrace.shift()
  }
}

/**
 * Capture transaction-side evidence at dispatch time. This checkpoint is not
 * publishable on its own; the live editor reconciles it later with the final
 * legacy candidate produced by markdownUpdated.
 */
export function captureTransactionFirstSourceSync({
  mode = TRANSACTION_FIRST_MODES.SHADOW,
  source,
  transactions,
  oldState,
  newState,
  sourceRangeMap,
  blockHints = [],
  validateMarkdown
}) {
  const original = String(source || '')
  const rolloutMode = validModes.has(mode) ? mode : TRANSACTION_FIRST_MODES.SHADOW
  const transaction = computeTransactionCandidate({
    source: original,
    transactions,
    oldState,
    newState,
    sourceRangeMap,
    blockHints,
    validateMarkdown
  })
  return {
    mode: rolloutMode,
    source: original,
    oldDoc: oldState?.doc || null,
    newDoc: newState?.doc || null,
    ownership: transaction.ok ? 'owned' : 'rejected',
    transaction,
    sourceMapEntries: sourceRangeMap?.entries?.length || 0,
    stepNames: stepNamesFor(transactions)
  }
}

/**
 * Compare a dispatch-time checkpoint with the exact legacy candidate that the
 * editor is about to publish. Deferred/coalesced callbacks can make a
 * checkpoint stale; that is telemetry, not a user-visible integrity failure.
 */
export function reconcileTransactionFirstSourceSync({
  checkpoint,
  currentSource,
  currentDoc,
  legacyResult = null
}) {
  if (!checkpoint) return null

  const source = String(currentSource || '')
  const legacy = normalizeLegacyResult(legacyResult)
  let comparison
  let reconcileReason
  let snapshotMatched = true

  if (source !== checkpoint.source) {
    comparison = 'shadow-stale-source'
    reconcileReason = 'source-checkpoint-changed'
    snapshotMatched = false
  } else if (!sameDocument(currentDoc, checkpoint.newDoc)) {
    comparison = 'shadow-stale-document'
    reconcileReason = 'callback-document-changed'
    snapshotMatched = false
  } else {
    comparison = compareCandidates(checkpoint.transaction, legacy)
    reconcileReason = 'matched-snapshot'
  }

  const promotionEligible = snapshotMatched && comparison === 'byte-equal'
  let publication = {
    owner: legacy ? 'legacy' : 'source-checkpoint',
    markdown: legacy?.markdown ?? source,
    reason: legacy?.reason || 'no-legacy-candidate'
  }
  if (
    snapshotMatched &&
    checkpoint.mode === TRANSACTION_FIRST_MODES.AUTHORITATIVE &&
    checkpoint.transaction?.ok
  ) {
    publication = {
      owner: 'transaction',
      markdown: checkpoint.transaction.markdown,
      reason: checkpoint.transaction.reason
    }
  }

  const result = {
    mode: checkpoint.mode,
    ownership: checkpoint.ownership,
    transaction: checkpoint.transaction,
    legacy,
    comparison,
    promotionEligible,
    reconcileReason,
    publication
  }

  trace({
    phase: 'reconcile',
    mode: result.mode,
    ownership: result.ownership,
    transactionReason: checkpoint.transaction?.reason || 'missing-transaction-result',
    comparison,
    promotionEligible,
    publicationOwner: publication.owner,
    sourceMapEntries: checkpoint.sourceMapEntries || 0,
    stepNames: checkpoint.stepNames || [],
    reconcileReason
  })

  return result
}

/**
 * Rollout coordinator. In shadow/observe modes the transaction candidate can
 * never change publication. Authoritative mode publishes only an owned,
 * validated transaction candidate and otherwise falls back to legacy.
 */
export function runTransactionFirstSourceSync({
  mode = TRANSACTION_FIRST_MODES.SHADOW,
  source,
  transactions,
  oldState,
  newState,
  sourceRangeMap,
  blockHints = [],
  validateMarkdown,
  legacyResult = null
}) {
  const original = String(source || '')
  const rolloutMode = validModes.has(mode) ? mode : TRANSACTION_FIRST_MODES.SHADOW
  const legacy = normalizeLegacyResult(legacyResult)

  const transactionResult = computeTransactionCandidate({
    source: original,
    transactions,
    oldState,
    newState,
    sourceRangeMap,
    blockHints,
    validateMarkdown
  })

  const comparison = compareCandidates(transactionResult, legacy)
  const promotionEligible = comparison === 'byte-equal'

  let publication = {
    owner: legacy ? 'legacy' : 'source-checkpoint',
    markdown: legacy?.markdown ?? original,
    reason: legacy?.reason || 'no-legacy-candidate'
  }
  if (rolloutMode === TRANSACTION_FIRST_MODES.AUTHORITATIVE && transactionResult.ok) {
    publication = {
      owner: 'transaction',
      markdown: transactionResult.markdown,
      reason: transactionResult.reason
    }
  }

  const result = {
    mode: rolloutMode,
    ownership: transactionResult.ok ? 'owned' : 'rejected',
    transaction: transactionResult,
    legacy,
    comparison,
    promotionEligible,
    publication
  }

  trace({
    phase: 'immediate',
    mode: result.mode,
    ownership: result.ownership,
    transactionReason: transactionResult.reason,
    comparison,
    promotionEligible,
    publicationOwner: publication.owner,
    sourceMapEntries: sourceRangeMap?.entries?.length || 0,
    stepNames: stepNamesFor(transactions),
    reconcileReason: 'immediate'
  })

  return result
}
