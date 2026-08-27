import {
  createPmPosToMarkdownOffsetMapper,
  pmPosToMarkdownOffset
} from '../components/editor-source-map.js'
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

  // The default scalar PM→source mapper parses the complete Markdown on each
  // call. A SourceRangeMap needs two positions per eligible paragraph, so use
  // one prepared snapshot when the default mapper is selected. Tests and future
  // callers can still inject a custom scalar mapper unchanged.
  const preparedMapPosition = mapPosition === pmPosToMarkdownOffset
    ? createPmPosToMarkdownOffsetMapper(normalizedSource, doc, remark)
    : null
  if (mapPosition === pmPosToMarkdownOffset && !preparedMapPosition) {
    return {
      ok: false,
      reason: 'markdown-position-snapshot-failed',
      source: String(source || ''),
      normalizedSource,
      doc,
      entries,
      rejected,
      mapPosition: () => null
    }
  }
  const resolveRawOffset = (pmPos) => preparedMapPosition
    ? preparedMapPosition(pmPos)
    : mapPosition(normalizedSource, pmPos, doc, remark)

  doc.forEach((node, pmBlockStart) => {
    if (!isSimplePlainParagraph(node)) {
      rejected.push({ pmBlockStart, nodeType: node?.type?.name || 'unknown', reason: 'unsupported-block' })
      return
    }

    const pmContentStart = pmBlockStart + 1
    const pmContentEnd = pmContentStart + node.content.size
    const rawStart = resolveRawOffset(pmContentStart)
    const rawEnd = resolveRawOffset(pmContentEnd)
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

export const TRANSACTION_FIRST_FAMILIES = Object.freeze({
  PLAIN_PARAGRAPH_INLINE_REPLACE: 'plain-paragraph-inline-replace'
})

const PHASE_ONE_PLAIN_PARAGRAPH_FAMILY = TRANSACTION_FIRST_FAMILIES.PLAIN_PARAGRAPH_INLINE_REPLACE

const isClosedPlainTextSlice = (slice) => {
  if (!slice || slice.size === 0 || slice.content?.size === 0) return true
  if (slice.openStart || slice.openEnd) return false
  let plain = true
  slice.content.forEach((node) => {
    if (!node?.isText || (node.marks?.length || 0) > 0) plain = false
  })
  return plain
}

/**
 * Phase 1 authority classifier. A ReplaceStep constructor is not sufficient
 * evidence: paragraph splits and structural commands can use the same step
 * family. This classifier admits only one closed inline edit inside one mapped,
 * top-level, unmarked paragraph whose result remains the same kind of block.
 */
export function classifyPhaseOnePlainParagraphTransaction({
  transactions,
  oldState,
  newState,
  sourceRangeMap
}) {
  const reject = (reason) => ({ owned: false, family: null, reason })
  const changed = (transactions || []).filter((transaction) => transaction?.docChanged)
  if (changed.length !== 1) return reject('phase1-changed-transaction-count')

  const transaction = changed[0]
  if (transaction.steps?.length !== 1) return reject('phase1-step-count')
  const step = transaction.steps[0]
  if (step?.constructor?.name !== 'ReplaceStep') return reject('phase1-step-not-replace')
  if (!Number.isFinite(step.from) || !Number.isFinite(step.to)) {
    return reject('phase1-unresolvable-range')
  }
  if (!sameDocument(transaction.before, oldState?.doc)) {
    return reject('phase1-transaction-chain-mismatch')
  }

  const stepDoc = transaction.docs?.[0] || oldState?.doc
  let $from
  let $to
  try {
    $from = stepDoc?.resolve?.(step.from)
    $to = stepDoc?.resolve?.(step.to)
  } catch {
    return reject('phase1-unresolvable-range')
  }
  if (!$from || !$to) return reject('phase1-unresolvable-range')
  if (!$from.sameParent($to)) return reject('phase1-cross-parent-range')
  if ($from.depth !== 1 || $from.parent?.type?.name !== 'paragraph') {
    return reject('phase1-non-top-level-paragraph')
  }
  if (!isSimplePlainParagraph($from.parent)) {
    return reject('phase1-non-plain-source-paragraph')
  }
  if (!isClosedPlainTextSlice(step.slice)) {
    return reject('phase1-structural-slice')
  }

  const owners = (sourceRangeMap?.entries || []).filter((entry) =>
    entry?.nodeType === 'paragraph' &&
    step.from >= entry.pmContentStart &&
    step.to <= entry.pmContentEnd)
  if (owners.length !== 1) return reject('phase1-range-outside-source-map')

  const topBlockStart = $from.before(1)
  const resultDoc = transaction.doc
  const nextBlock = resultDoc?.nodeAt?.(topBlockStart)
  if (!nextBlock?.isTextblock || nextBlock.type?.name !== 'paragraph') {
    return reject('phase1-result-not-plain-paragraph')
  }
  if (nextBlock.content?.size <= 0) return reject('phase1-result-empty-paragraph')
  if (!isSimplePlainParagraph(nextBlock)) {
    return reject('phase1-result-not-plain-paragraph')
  }
  if (!sameDocument(resultDoc, newState?.doc)) {
    return reject('phase1-final-document-mismatch')
  }

  return {
    owned: true,
    family: PHASE_ONE_PLAIN_PARAGRAPH_FAMILY,
    reason: 'phase1-plain-paragraph-inline-replace',
    pmBlockStart: topBlockStart,
    sourceMapEntry: owners[0]
  }
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
  const classification = classifyPhaseOnePlainParagraphTransaction({
    transactions,
    oldState,
    newState,
    sourceRangeMap
  })
  if (!classification.owned) {
    return {
      ok: false,
      markdown: original,
      reason: classification.reason,
      family: null,
      classificationReason: classification.reason
    }
  }
  const mapped = mapPlainTextTransactionsToSource({
    source: original,
    transactions,
    oldState,
    newState,
    mapPosition: sourceRangeMap.mapPosition,
    blockHints,
    validateMarkdown
  })
  return {
    ...mapped,
    family: classification.family,
    classificationReason: classification.reason
  }
}

const compareCandidates = (transactionResult, legacy) => {
  if (!transactionResult?.ok) return 'transaction-rejected'
  if (!legacy) return 'legacy-unavailable'
  return transactionResult.markdown === legacy.markdown ? 'byte-equal' : 'byte-diverged'
}

/**
 * Pure publication policy for transaction-first rollout. AUTHORITATIVE is only
 * a rollout mode; it is not ownership proof by itself. A transaction may own
 * publication only when the exact callback snapshot still matches, the mapped
 * candidate is valid, and the complete chain family is explicitly allowlisted.
 * Every other decision returns the existing legacy/source checkpoint bytes.
 */
export function selectTransactionFirstPublication({
  mode = TRANSACTION_FIRST_MODES.SHADOW,
  snapshotMatched = true,
  transaction = null,
  family = transaction?.family || null,
  allowedFamilies = [],
  legacyResult = null,
  fallbackSource = ''
}) {
  const rolloutMode = validModes.has(mode) ? mode : TRANSACTION_FIRST_MODES.SHADOW
  const legacy = normalizeLegacyResult(legacyResult)
  const fallback = {
    owner: legacy ? 'legacy' : 'source-checkpoint',
    markdown: legacy?.markdown ?? String(fallbackSource || ''),
    reason: legacy?.reason || 'no-legacy-candidate'
  }
  const reject = (decisionReason) => ({
    authorityEligible: false,
    decisionReason,
    publication: fallback
  })

  if (rolloutMode !== TRANSACTION_FIRST_MODES.AUTHORITATIVE) {
    return reject('authority-disabled')
  }
  if (!snapshotMatched) return reject('authority-snapshot-stale')
  if (!transaction?.ok) return reject('authority-transaction-rejected')
  if (!family) return reject('authority-family-missing')
  if (transaction.family !== family) return reject('authority-family-mismatch')

  const allowed = new Set(Array.isArray(allowedFamilies) ? allowedFamilies : [])
  if (!allowed.has(family)) return reject('authority-family-not-allowed')

  return {
    authorityEligible: true,
    decisionReason: 'authority-owned',
    publication: {
      owner: 'transaction',
      markdown: transaction.markdown,
      reason: transaction.reason
    }
  }
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
    baselineSource: original,
    oldDoc: oldState?.doc || null,
    baselineDoc: oldState?.doc || null,
    newDoc: newState?.doc || null,
    ownership: transaction.ok ? 'owned' : 'rejected',
    transaction,
    family: transaction.family || null,
    chainLength: 1,
    chainReasons: [transaction.reason],
    sourceMapEntries: sourceRangeMap?.entries?.length || 0,
    stepNames: stepNamesFor(transactions)
  }
}

const rejectedChainCheckpoint = ({
  checkpoint,
  mode,
  baselineSource,
  oldState,
  newState,
  transactions,
  reason
}) => {
  const originalBaseline = String(
    checkpoint?.baselineSource ?? checkpoint?.source ?? baselineSource ?? ''
  )
  const rolloutMode = validModes.has(checkpoint?.mode)
    ? checkpoint.mode
    : (validModes.has(mode) ? mode : TRANSACTION_FIRST_MODES.SHADOW)
  const chainLength = (checkpoint?.chainLength || 0) + 1
  const stepNames = [
    ...(checkpoint?.stepNames || []),
    ...stepNamesFor(transactions)
  ]
  const chainReasons = [
    ...(checkpoint?.chainReasons || []),
    reason
  ].slice(-20)
  return {
    mode: rolloutMode,
    source: originalBaseline,
    baselineSource: originalBaseline,
    oldDoc: checkpoint?.oldDoc || oldState?.doc || null,
    baselineDoc: checkpoint?.baselineDoc || checkpoint?.oldDoc || oldState?.doc || null,
    newDoc: newState?.doc || checkpoint?.newDoc || null,
    ownership: 'rejected',
    transaction: {
      ok: false,
      markdown: originalBaseline,
      reason,
      family: null,
      classificationReason: reason
    },
    family: null,
    chainLength,
    chainReasons,
    sourceMapEntries: checkpoint?.sourceMapEntries || 0,
    stepNames
  }
}

/**
 * Extend one pending shadow checkpoint across multiple PM dispatches that may
 * arrive before a deferred markdownUpdated callback. The authored baseline is
 * immutable for callback ownership, while each owned transaction maps against
 * the exact source candidate produced by the previous transaction.
 *
 * A rejected member makes the whole pending chain non-promotable. We never
 * restart from a stale authored baseline inside the same deferred callback
 * window because that would recreate the A -> D intent-collapse problem this
 * migration is designed to remove.
 */
export function advanceTransactionFirstSourceSync({
  checkpoint = null,
  mode = TRANSACTION_FIRST_MODES.SHADOW,
  baselineSource,
  transactions,
  oldState,
  newState,
  buildSourceRangeMap,
  sourceRangeMap = null,
  blockHints = [],
  validateMarkdown
}) {
  const requestedBaseline = String(baselineSource || '')
  if (!checkpoint) {
    const initialMap = sourceRangeMap || (
      typeof buildSourceRangeMap === 'function'
        ? buildSourceRangeMap({ source: requestedBaseline, doc: oldState?.doc })
        : null
    )
    return captureTransactionFirstSourceSync({
      mode,
      source: requestedBaseline,
      transactions,
      oldState,
      newState,
      sourceRangeMap: initialMap,
      blockHints,
      validateMarkdown
    })
  }

  const originalBaseline = String(checkpoint.baselineSource ?? checkpoint.source ?? '')
  if (requestedBaseline !== originalBaseline) {
    return rejectedChainCheckpoint({
      checkpoint,
      mode,
      baselineSource: requestedBaseline,
      oldState,
      newState,
      transactions,
      reason: 'shadow-chain-baseline-changed'
    })
  }
  if (!sameDocument(checkpoint.newDoc, oldState?.doc)) {
    return rejectedChainCheckpoint({
      checkpoint,
      mode,
      baselineSource: originalBaseline,
      oldState,
      newState,
      transactions,
      reason: 'shadow-chain-document-gap'
    })
  }
  if (!checkpoint.transaction?.ok) {
    return rejectedChainCheckpoint({
      checkpoint,
      mode,
      baselineSource: originalBaseline,
      oldState,
      newState,
      transactions,
      reason: 'shadow-chain-prior-rejected'
    })
  }

  const workingSource = checkpoint.transaction.markdown
  const nextMap = typeof buildSourceRangeMap === 'function'
    ? buildSourceRangeMap({ source: workingSource, doc: oldState?.doc })
    : sourceRangeMap
  if (!nextMap?.ok) {
    return rejectedChainCheckpoint({
      checkpoint,
      mode,
      baselineSource: originalBaseline,
      oldState,
      newState,
      transactions,
      reason: 'shadow-chain-source-map-failed'
    })
  }

  const transaction = computeTransactionCandidate({
    source: workingSource,
    transactions,
    oldState,
    newState,
    sourceRangeMap: nextMap,
    blockHints,
    validateMarkdown
  })
  const chainLength = (checkpoint.chainLength || 1) + 1
  const stepNames = [
    ...(checkpoint.stepNames || []),
    ...stepNamesFor(transactions)
  ]
  const chainReasons = [
    ...(checkpoint.chainReasons || []),
    transaction.reason
  ].slice(-20)

  return {
    mode: checkpoint.mode,
    source: originalBaseline,
    baselineSource: originalBaseline,
    oldDoc: checkpoint.oldDoc || checkpoint.baselineDoc || null,
    baselineDoc: checkpoint.baselineDoc || checkpoint.oldDoc || null,
    newDoc: newState?.doc || null,
    ownership: transaction.ok ? 'owned' : 'rejected',
    transaction,
    family: transaction.ok && checkpoint.family === transaction.family
      ? transaction.family
      : null,
    chainLength,
    chainReasons,
    sourceMapEntries: nextMap.entries?.length || 0,
    stepNames
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
  legacyResult = null,
  allowedFamilies = []
}) {
  if (!checkpoint) return null

  const source = String(currentSource || '')
  const legacy = normalizeLegacyResult(legacyResult)
  let comparison
  let reconcileReason
  let snapshotMatched = true

  const checkpointSource = String(checkpoint.baselineSource ?? checkpoint.source ?? '')
  if (source !== checkpointSource) {
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
  const authority = selectTransactionFirstPublication({
    mode: checkpoint.mode,
    snapshotMatched,
    transaction: checkpoint.transaction,
    family: checkpoint.family,
    allowedFamilies,
    legacyResult: legacy,
    fallbackSource: source
  })
  const publication = authority.publication

  const result = {
    mode: checkpoint.mode,
    ownership: checkpoint.ownership,
    transaction: checkpoint.transaction,
    legacy,
    comparison,
    promotionEligible,
    reconcileReason,
    authorityDecision: authority.decisionReason,
    authorityEligible: authority.authorityEligible,
    publication
  }

  trace({
    phase: 'reconcile',
    mode: result.mode,
    ownership: result.ownership,
    transactionReason: checkpoint.transaction?.reason || 'missing-transaction-result',
    transactionFamily: checkpoint.transaction?.family || null,
    comparison,
    promotionEligible,
    publicationOwner: publication.owner,
    authorityDecision: authority.decisionReason,
    authorityEligible: authority.authorityEligible,
    chainLength: checkpoint.chainLength || 1,
    chainReasons: checkpoint.chainReasons || [],
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
  legacyResult = null,
  allowedFamilies = []
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
  const authority = selectTransactionFirstPublication({
    mode: rolloutMode,
    snapshotMatched: true,
    transaction: transactionResult,
    family: transactionResult.family,
    allowedFamilies,
    legacyResult: legacy,
    fallbackSource: original
  })
  const publication = authority.publication

  const result = {
    mode: rolloutMode,
    ownership: transactionResult.ok ? 'owned' : 'rejected',
    transaction: transactionResult,
    legacy,
    comparison,
    promotionEligible,
    authorityDecision: authority.decisionReason,
    authorityEligible: authority.authorityEligible,
    publication
  }

  trace({
    phase: 'immediate',
    mode: result.mode,
    ownership: result.ownership,
    transactionReason: transactionResult.reason,
    transactionFamily: transactionResult.family || null,
    comparison,
    promotionEligible,
    publicationOwner: publication.owner,
    authorityDecision: authority.decisionReason,
    authorityEligible: authority.authorityEligible,
    sourceMapEntries: sourceRangeMap?.entries?.length || 0,
    stepNames: stepNamesFor(transactions),
    reconcileReason: 'immediate'
  })

  return result
}
