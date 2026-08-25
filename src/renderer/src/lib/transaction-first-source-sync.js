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

  let transactionResult
  if (!sourceRangeMap?.ok) {
    transactionResult = {
      ok: false,
      markdown: original,
      reason: sourceRangeMap?.reason || 'missing-source-range-map'
    }
  } else if (sourceRangeMap.source !== original || !sameDocument(sourceRangeMap.doc, oldState?.doc)) {
    transactionResult = { ok: false, markdown: original, reason: 'stale-source-range-map' }
  } else if (!phaseOneBatchOwned(transactions)) {
    transactionResult = { ok: false, markdown: original, reason: 'phase1-batch-not-owned' }
  } else {
    transactionResult = mapPlainTextTransactionsToSource({
      source: original,
      transactions,
      oldState,
      newState,
      mapPosition: sourceRangeMap.mapPosition,
      blockHints,
      validateMarkdown
    })
  }

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
    mode: result.mode,
    ownership: result.ownership,
    transactionReason: transactionResult.reason,
    comparison,
    promotionEligible,
    publicationOwner: publication.owner,
    sourceMapEntries: sourceRangeMap?.entries?.length || 0
  })

  return result
}
