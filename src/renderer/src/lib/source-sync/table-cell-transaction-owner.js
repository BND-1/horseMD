import { mapPlainTextTransactionsToSource } from '../source-transaction-sync.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  classifySingleAnchoredSubtreeChange,
  onlySourceSyncNodePathChanged,
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath,
  sourceSyncResolvedPositionMatchesPath
} from './top-level-subtree.js'
import {
  transactionsFromSourceSyncTransactionJournal,
  verifySourceSyncTransactionJournalCheckpoint
} from './transaction-journal.js'

export const TABLE_CELL_TRANSACTION_FAMILY = 'table-cell-plain-text-replace'
export const TABLE_CELL_TRANSACTION_BOUNDARY = 'transaction-table-cell-text'

const rejected = (reason, {
  deferred = false,
  reset = false,
  proof = null
} = {}) => Object.freeze({
  ok: false,
  decision: 'rejected',
  deferred,
  reset,
  reason,
  proof
})

const nodeAtPath = (doc, path) => {
  let node = doc
  for (const index of path || []) {
    if (!Number.isInteger(index) || index < 0 || index >= node?.childCount) return null
    node = node.child(index)
  }
  return node
}

const isTableCellType = (name) => name === 'table_cell' || name === 'table_header'

const isSimpleNonEmptyParagraph = (node) => {
  if (
    node?.type?.name !== 'paragraph' ||
    !node.isTextblock ||
    node.content?.size <= 0
  ) return false
  let simple = true
  node.forEach?.((child) => {
    if (!child?.isText || (child.marks?.length || 0) > 0) simple = false
  })
  return simple
}

const isClosedPlainTextSlice = (slice) => {
  if (!slice || slice.size === 0 || slice.content?.size === 0) return true
  if (slice.openStart || slice.openEnd) return false
  let plain = true
  slice.content.forEach?.((node) => {
    if (!node?.isText || (node.marks?.length || 0) > 0) plain = false
  })
  return plain
}

const classifyAnchoredCell = ({ oldDoc, newDoc }) => {
  const attempts = ['table_cell', 'table_header'].map((expectedType) =>
    classifySingleAnchoredSubtreeChange({
      oldDoc,
      newDoc,
      expectedType,
      reasonPrefix: 'table-cell'
    })
  )
  const owned = attempts.filter((attempt) => attempt.ok)
  if (owned.length === 1) return owned[0]
  return rejected('table-cell-anchored-target-count', {
    proof: {
      candidateCount: owned.length,
      attempts: attempts.map((attempt) => ({
        ok: attempt.ok === true,
        reason: attempt.reason || null,
        proof: attempt.proof || null
      }))
    }
  })
}

const classifyTableCellJournal = ({ journal, expectedDoc }) => {
  const classification = classifyAnchoredCell({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc
  })
  if (!classification.ok) return classification

  const cellPath = classification.nodePath
  const rowPath = cellPath.slice(0, -1)
  const tablePath = cellPath.slice(0, -2)
  const previousCell = classification.previousEntry.node
  const nextCell = classification.nextEntry.node
  const previousRow = nodeAtPath(journal.oldDoc, rowPath)
  const nextRow = nodeAtPath(expectedDoc, rowPath)
  const previousTable = nodeAtPath(journal.oldDoc, tablePath)
  const nextTable = nodeAtPath(expectedDoc, tablePath)
  if (
    cellPath.length < 3 ||
    previousRow?.type?.name !== 'table_row' ||
    nextRow?.type?.name !== 'table_row' ||
    previousTable?.type?.name !== 'table' ||
    nextTable?.type?.name !== 'table'
  ) return rejected('table-cell-path-not-table')
  if (
    !isTableCellType(previousCell.type?.name) ||
    previousCell.type?.name !== nextCell.type?.name ||
    !sourceSyncAttrsEqual(previousTable.attrs, nextTable.attrs) ||
    !sourceSyncAttrsEqual(previousRow.attrs, nextRow.attrs) ||
    !sourceSyncAttrsEqual(previousCell.attrs, nextCell.attrs)
  ) return rejected('table-cell-attrs-or-type-changed')
  if (previousCell.childCount !== 1 || nextCell.childCount !== 1) {
    return rejected('table-cell-paragraph-count')
  }
  const previousParagraph = previousCell.child(0)
  const nextParagraph = nextCell.child(0)
  if (
    !isSimpleNonEmptyParagraph(previousParagraph) ||
    !isSimpleNonEmptyParagraph(nextParagraph)
  ) return rejected('table-cell-not-simple-nonempty')
  if (!sourceSyncAttrsEqual(previousParagraph.attrs, nextParagraph.attrs)) {
    return rejected('table-cell-paragraph-attrs-changed')
  }
  if (previousParagraph.textContent === nextParagraph.textContent) {
    return rejected('table-cell-text-unchanged')
  }

  let currentDoc = journal.oldDoc
  for (const entry of journal.entries || []) {
    if (!sameSourceSyncDocument(entry.beforeDoc, currentDoc)) {
      return rejected('table-cell-transaction-chain-mismatch')
    }
    if (!entry.steps?.length) return rejected('table-cell-step-count')
    let entryDoc = entry.beforeDoc
    for (let index = 0; index < entry.steps.length; index += 1) {
      const step = entry.steps[index]
      if (step?.constructor?.name !== 'ReplaceStep') {
        return rejected('table-cell-step-not-replace')
      }
      if (!Number.isFinite(step.from) || !Number.isFinite(step.to)) {
        return rejected('table-cell-step-range-invalid')
      }
      if (step.structure === true) return rejected('table-cell-structural-step')
      if (!isClosedPlainTextSlice(step.slice)) {
        return rejected('table-cell-structural-slice')
      }

      const stepDoc = entry.stepDocs?.[index] || (index === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
        return rejected('table-cell-step-document-missing')
      }
      let $from
      let $to
      try {
        $from = stepDoc.resolve(step.from)
        $to = stepDoc.resolve(step.to)
      } catch {
        return rejected('table-cell-step-range-unresolvable')
      }
      if (!$from?.sameParent?.($to)) return rejected('table-cell-cross-parent-range')
      const beforeEntry = sourceSyncNodeEntryAtPath(stepDoc, cellPath)
      const cellDepth = cellPath.length
      if (
        !beforeEntry ||
        !isTableCellType(beforeEntry.type) ||
        $from.depth !== cellDepth + 1 ||
        $from.parent?.type?.name !== 'paragraph' ||
        $from.node(cellDepth)?.type?.name !== beforeEntry.type ||
        $from.before(cellDepth) !== beforeEntry.offset ||
        !sourceSyncResolvedPositionMatchesPath($from, cellPath) ||
        !sourceSyncResolvedPositionMatchesPath($to, cellPath) ||
        $from.index(cellDepth) !== 0 ||
        $to.index(cellDepth) !== 0
      ) return rejected('table-cell-step-outside-owned-cell')
      const beforeCell = beforeEntry.node
      const beforeParagraph = beforeCell.childCount === 1 ? beforeCell.child(0) : null
      if (
        beforeCell.type?.name !== previousCell.type?.name ||
        !sourceSyncAttrsEqual(beforeCell.attrs, previousCell.attrs) ||
        !isSimpleNonEmptyParagraph(beforeParagraph) ||
        !sourceSyncAttrsEqual(beforeParagraph.attrs, previousParagraph.attrs)
      ) return rejected('table-cell-step-baseline-mismatch')

      let applied
      try {
        applied = step.apply(stepDoc)
      } catch {
        return rejected('table-cell-step-apply-failed')
      }
      if (applied?.failed || !applied?.doc) {
        return rejected('table-cell-step-apply-failed')
      }
      if (!onlySourceSyncNodePathChanged(stepDoc, applied.doc, cellPath)) {
        return rejected('table-cell-neighbour-or-topology-changed')
      }
      const afterCell = sourceSyncNodeEntryAtPath(applied.doc, cellPath)?.node
      const afterParagraph = afterCell?.childCount === 1 ? afterCell.child(0) : null
      if (
        afterCell?.type?.name !== previousCell.type?.name ||
        !sourceSyncAttrsEqual(afterCell.attrs, previousCell.attrs) ||
        !isSimpleNonEmptyParagraph(afterParagraph) ||
        !sourceSyncAttrsEqual(afterParagraph.attrs, previousParagraph.attrs) ||
        beforeParagraph.eq?.(afterParagraph) === true
      ) return rejected('table-cell-result-not-simple-nonempty')
      entryDoc = applied.doc
    }
    if (!sameSourceSyncDocument(entryDoc, entry.afterDoc)) {
      return rejected('table-cell-transaction-result-mismatch')
    }
    currentDoc = entry.afterDoc
  }
  if (!sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return rejected('table-cell-final-document-mismatch')
  }

  return Object.freeze({
    ...classification,
    cellPath,
    rowPath,
    tablePath,
    rowIndex: cellPath.at(-2),
    cellIndex: cellPath.at(-1),
    previousCell,
    nextCell,
    previousParagraph,
    nextParagraph
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'table-cell-plain-text-change',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: TABLE_CELL_TRANSACTION_FAMILY,
    boundary,
    reason: result.reason,
    baseRevision: proof.transactionJournal.baseRevision,
    baseSourceDigest: proof.transactionJournal.baseSourceDigest,
    baseCanonicalDigest: proof.transactionJournal.baseCanonicalDigest,
    proof,
    result,
    canonical,
    expectedDoc,
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

export function createTableCellTransactionSourceSyncOwner({
  mapTransactions = mapPlainTextTransactionsToSource,
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof mapTransactions !== 'function') {
    throw new TypeError('table cell owner requires mapTransactions')
  }
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('table cell owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('table cell owner requires validateMarkdown')
  }

  const plan = ({
    journal,
    activeJournal,
    snapshot,
    currentSource,
    currentCanonical,
    canonical,
    expectedDoc,
    callbackDocumentEquivalent = false,
    boundary = TABLE_CELL_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('table-cell-journal-stale', { reset: true })
    }
    const verified = verifySourceSyncTransactionJournalCheckpoint({
      checkpoint: journal,
      snapshot,
      expectedDoc
    })
    if (!verified.ok) {
      return rejected(verified.reason, {
        reset: verified.reset,
        proof: verified.proof
      })
    }
    if (
      typeof currentSource !== 'string' ||
      typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' ||
      !expectedDoc
    ) return rejected('table-cell-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('table-cell-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('table-cell-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyTableCellJournal({ journal, expectedDoc })
    if (!classification.ok) return classification
    const transactions = transactionsFromSourceSyncTransactionJournal(journal)
    if (!transactions.length) return rejected('table-cell-step-count')

    let mapped
    try {
      mapped = mapTransactions({
        source: journal.source,
        transactions,
        oldState: { doc: journal.oldDoc },
        newState: { doc: expectedDoc },
        blockHints: [],
        mapPosition: (markdown, pmPos, doc) => resolveMarkdownOffset({
          markdown,
          pmPos,
          doc,
          topLevelIndex: classification.topLevelIndex,
          rowIndex: classification.rowIndex,
          cellIndex: classification.cellIndex,
          nodePath: classification.cellPath
        }),
        validateMarkdown: (markdown, mappedExpectedDoc) => validateMarkdown({
          markdown,
          expectedDoc: mappedExpectedDoc
        })
      })
    } catch (error) {
      return rejected(`table-cell-mapper-threw:${error?.name || 'Error'}`)
    }
    if (!mapped?.ok || typeof mapped.markdown !== 'string') {
      return rejected(mapped?.reason || 'table-cell-mapper-rejected')
    }

    const proof = Object.freeze({
      kind: 'transaction-table-cell-proof',
      journalId: journal.journalId,
      family: TABLE_CELL_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      nodePath: classification.cellPath,
      tablePath: classification.tablePath,
      rowPath: classification.rowPath,
      rowIndex: classification.rowIndex,
      cellIndex: classification.cellIndex,
      cellType: classification.previousCell.type?.name || null,
      previousText: classification.previousParagraph.textContent,
      nextText: classification.nextParagraph.textContent,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(mapped.markdown),
      mapperReason: mapped.reason || null,
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({
      boundary,
      markdown: mapped.markdown,
      canonical,
      expectedDoc,
      proof
    })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: TABLE_CELL_TRANSACTION_FAMILY,
    boundary: TABLE_CELL_TRANSACTION_BOUNDARY,
    plan
  })
}
