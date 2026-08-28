import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  classifySingleTopLevelSubtreeChange,
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const TABLE_ROW_DELETE_TRANSACTION_FAMILY = 'table-row-delete'
export const TABLE_ROW_DELETE_TRANSACTION_BOUNDARY = 'transaction-table-row-delete'

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

const isEmptyClosedSlice = (slice) => Boolean(
  slice &&
  slice.size === 0 &&
  slice.content?.size === 0 &&
  slice.openStart === 0 &&
  slice.openEnd === 0
)

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

const isSimpleGridCell = (cell, header) => Boolean(
  cell &&
  cell.type?.name === (header ? 'table_header' : 'table_cell') &&
  (cell.attrs?.colspan ?? 1) === 1 &&
  (cell.attrs?.rowspan ?? 1) === 1 &&
  cell.attrs?.colwidth == null &&
  cell.childCount === 1
)

const simpleGridColumnCount = (table) => {
  if (table?.type?.name !== 'table' || table.childCount < 2) return null
  const columns = table.child(0)?.childCount || 0
  if (columns <= 0) return null
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex)
    const rowType = row?.type?.name || ''
    const rowTypeMatches = rowIndex === 0
      ? rowType === 'table_header_row' || rowType === 'table_row'
      : rowType === 'table_row'
    if (!rowTypeMatches || row.childCount !== columns) return null
    for (let cellIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
      if (!isSimpleGridCell(row.child(cellIndex), rowIndex === 0)) return null
    }
  }
  return columns
}

const rowDeletionCandidates = (previousTable, nextTable) => {
  if (
    previousTable?.childCount !== nextTable?.childCount + 1 ||
    previousTable?.type?.name !== 'table' ||
    nextTable?.type?.name !== 'table'
  ) return []
  const candidates = []
  for (let deletedIndex = 0; deletedIndex < previousTable.childCount; deletedIndex += 1) {
    let equal = true
    for (let nextIndex = 0; nextIndex < nextTable.childCount; nextIndex += 1) {
      const previousIndex = nextIndex < deletedIndex ? nextIndex : nextIndex + 1
      if (previousTable.child(previousIndex).eq?.(nextTable.child(nextIndex)) !== true) {
        equal = false
        break
      }
    }
    if (equal) candidates.push(deletedIndex)
  }
  return candidates
}

const physicalLineAt = (markdown, rawOffset) => {
  const text = String(markdown || '')
  const offset = Math.max(0, Math.min(
    Number.isFinite(rawOffset) ? rawOffset : 0,
    text.length
  ))
  let start = offset
  while (start > 0) {
    const code = text.charCodeAt(start - 1)
    if (code === 10 || code === 13) break
    start -= 1
  }

  let textEnd = offset
  while (textEnd < text.length) {
    const code = text.charCodeAt(textEnd)
    if (code === 10 || code === 13) break
    textEnd += 1
  }

  let end = textEnd
  if (text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10) end += 2
  else if (text.charCodeAt(end) === 13 || text.charCodeAt(end) === 10) end += 1

  return Object.freeze({
    start,
    textEnd,
    end,
    eol: text.slice(textEnd, end),
    rawLine: text.slice(start, textEnd)
  })
}

const resolveRowSourceRange = ({
  markdown,
  doc,
  tableIndex,
  rowIndex,
  resolveMarkdownOffset,
  side
}) => {
  const rowPath = [tableIndex, rowIndex]
  const rowEntry = sourceSyncNodeEntryAtPath(doc, rowPath)
  const row = rowEntry?.node
  if (row?.type?.name !== 'table_row' || row.childCount <= 0) {
    return rejected(`table-row-delete-${side}-row-missing`)
  }

  let physicalLine = null
  const cells = []
  for (let cellIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
    const cell = row.child(cellIndex)
    if (!isSimpleGridCell(cell, rowIndex === 0)) {
      return rejected(`table-row-delete-${side}-cell-shape`)
    }
    const paragraph = cell.child(0)
    if (!isSimpleNonEmptyParagraph(paragraph)) {
      return rejected(`table-row-delete-${side}-cell-text`)
    }
    const paragraphPath = [...rowPath, cellIndex, 0]
    const paragraphEntry = sourceSyncNodeEntryAtPath(doc, paragraphPath)
    if (!paragraphEntry) return rejected(`table-row-delete-${side}-paragraph-missing`)

    let rawStart
    let rawEnd
    try {
      rawStart = resolveMarkdownOffset({
        markdown,
        pmPos: paragraphEntry.contentStart,
        doc,
        tableIndex,
        rowIndex,
        cellIndex,
        nodePath: paragraphPath
      })
      rawEnd = resolveMarkdownOffset({
        markdown,
        pmPos: paragraphEntry.contentStart + paragraph.content.size,
        doc,
        tableIndex,
        rowIndex,
        cellIndex,
        nodePath: paragraphPath
      })
    } catch {
      return rejected(`table-row-delete-${side}-position-mapper-threw`)
    }
    if (
      !Number.isFinite(rawStart) ||
      !Number.isFinite(rawEnd) ||
      rawStart < 0 ||
      rawStart > rawEnd ||
      rawEnd > markdown.length
    ) return rejected(`table-row-delete-${side}-position-unmapped`)

    const cellLine = physicalLineAt(markdown, rawStart)
    if (!physicalLine) physicalLine = cellLine
    if (
      cellLine.start !== physicalLine.start ||
      rawStart < physicalLine.start ||
      rawEnd > physicalLine.textEnd
    ) return rejected(`table-row-delete-${side}-cross-line-cell`)

    const text = paragraph.textContent || ''
    if (markdown.slice(rawStart, rawEnd) !== text) {
      return rejected(`table-row-delete-${side}-cell-text-mismatch`, {
        proof: { cellIndex, text, rawText: markdown.slice(rawStart, rawEnd) }
      })
    }
    cells.push(Object.freeze({
      cellIndex,
      text,
      pmStart: paragraphEntry.contentStart,
      pmEnd: paragraphEntry.contentStart + paragraph.content.size,
      rawStart,
      rawEnd
    }))
  }

  if (!physicalLine || !physicalLine.rawLine.includes('|')) {
    return rejected(`table-row-delete-${side}-table-line-missing`)
  }
  return Object.freeze({
    ok: true,
    side,
    rowPath: Object.freeze(rowPath),
    rowIndex,
    start: physicalLine.start,
    textEnd: physicalLine.textEnd,
    end: physicalLine.end,
    eol: physicalLine.eol,
    rawLine: physicalLine.rawLine,
    cells: Object.freeze(cells)
  })
}

const classifyTableRowDeleteJournal = ({ journal, expectedDoc }) => {
  const topLevel = classifySingleTopLevelSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'table',
    reasonPrefix: 'table-row-delete'
  })
  if (!topLevel.ok) return topLevel

  const previousTable = topLevel.previousEntry.node
  const nextTable = topLevel.nextEntry.node
  if (!sourceSyncAttrsEqual(previousTable.attrs, nextTable.attrs)) {
    return rejected('table-row-delete-table-attrs-changed')
  }
  if (previousTable.childCount !== nextTable.childCount + 1) {
    return rejected('table-row-delete-row-count')
  }
  if (nextTable.childCount < 2) {
    return rejected('table-row-delete-last-body-row')
  }
  const previousColumns = simpleGridColumnCount(previousTable)
  if (!previousColumns) return rejected('table-row-delete-grid-topology')

  if (journal?.entries?.length !== 1) {
    return rejected('table-row-delete-transaction-count')
  }
  const entry = journal.entries[0]
  if (entry.steps?.length !== 1) return rejected('table-row-delete-step-count')
  const step = entry.steps[0]
  if (step?.constructor?.name !== 'ReplaceStep') {
    return rejected('table-row-delete-step-not-replace')
  }
  if (!Number.isFinite(step.from) || !Number.isFinite(step.to)) {
    return rejected('table-row-delete-step-range-invalid')
  }
  if (!isEmptyClosedSlice(step.slice)) {
    return rejected('table-row-delete-step-slice-not-empty')
  }
  const stepDoc = entry.stepDocs?.[0] || entry.beforeDoc
  if (!stepDoc || !sameSourceSyncDocument(stepDoc, journal.oldDoc)) {
    return rejected('table-row-delete-step-document-mismatch')
  }

  const candidates = rowDeletionCandidates(previousTable, nextTable)
  const matching = candidates.filter((rowIndex) => {
    const rowEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, [topLevel.topLevelIndex, rowIndex])
    return Boolean(
      rowEntry &&
      step.from === rowEntry.beforePos &&
      step.to === rowEntry.beforePos + rowEntry.node.nodeSize
    )
  })
  if (matching.length !== 1) {
    return rejected('table-row-delete-owned-row-count', {
      proof: { candidates, matching, from: step.from, to: step.to }
    })
  }
  const deletedRowIndex = matching[0]
  if (deletedRowIndex === 0) return rejected('table-row-delete-header-row')
  const nextColumns = simpleGridColumnCount(nextTable)
  if (previousColumns !== nextColumns) {
    return rejected('table-row-delete-grid-topology')
  }
  const deletedRow = previousTable.child(deletedRowIndex)
  for (let cellIndex = 0; cellIndex < deletedRow.childCount; cellIndex += 1) {
    const cell = deletedRow.child(cellIndex)
    if (!isSimpleGridCell(cell, false) || !isSimpleNonEmptyParagraph(cell.child(0))) {
      return rejected('table-row-delete-deleted-row-not-simple')
    }
  }

  let applied
  try {
    applied = step.apply(stepDoc)
  } catch {
    return rejected('table-row-delete-step-apply-failed')
  }
  if (applied?.failed || !applied?.doc) {
    return rejected('table-row-delete-step-apply-failed')
  }
  if (
    !sameSourceSyncDocument(applied.doc, entry.afterDoc) ||
    !sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(entry.afterDoc, expectedDoc) ||
    !sameSourceSyncDocument(journal.expectedDoc, expectedDoc)
  ) return rejected('table-row-delete-transaction-result-mismatch')

  return Object.freeze({
    ...topLevel,
    previousTable,
    nextTable,
    tablePath: Object.freeze([topLevel.topLevelIndex]),
    rowPath: Object.freeze([topLevel.topLevelIndex, deletedRowIndex]),
    deletedRowIndex,
    deletedRow,
    columnCount: previousColumns,
    step
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'table-row-deleted',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: TABLE_ROW_DELETE_TRANSACTION_FAMILY,
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

export function createTableRowDeleteTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('table row delete owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('table row delete owner requires validateMarkdown')
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
    boundary = TABLE_ROW_DELETE_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('table-row-delete-journal-stale', { reset: true })
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
    ) return rejected('table-row-delete-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('table-row-delete-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('table-row-delete-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyTableRowDeleteJournal({ journal, expectedDoc })
    if (!classification.ok) return classification

    const sourceRange = resolveRowSourceRange({
      markdown: journal.source,
      doc: journal.oldDoc,
      tableIndex: classification.topLevelIndex,
      rowIndex: classification.deletedRowIndex,
      resolveMarkdownOffset,
      side: 'source'
    })
    if (!sourceRange.ok) return sourceRange
    const previousCanonicalRange = resolveRowSourceRange({
      markdown: journal.canonical,
      doc: journal.oldDoc,
      tableIndex: classification.topLevelIndex,
      rowIndex: classification.deletedRowIndex,
      resolveMarkdownOffset,
      side: 'previous-canonical'
    })
    if (!previousCanonicalRange.ok) return previousCanonicalRange

    const markdown = journal.source.slice(0, sourceRange.start) +
      journal.source.slice(sourceRange.end)
    let equivalent = false
    try {
      equivalent = validateMarkdown({ markdown, expectedDoc }) === true
    } catch {
      return rejected('table-row-delete-semantic-validator-threw')
    }
    if (!equivalent) return rejected('table-row-delete-semantic-document-mismatch')

    const proof = Object.freeze({
      kind: 'transaction-table-row-delete-proof',
      journalId: journal.journalId,
      family: TABLE_ROW_DELETE_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      tablePath: classification.tablePath,
      rowPath: classification.rowPath,
      deletedRowIndex: classification.deletedRowIndex,
      columnCount: classification.columnCount,
      deletedCellTexts: Object.freeze(sourceRange.cells.map((cell) => cell.text)),
      stepDetail: journal.stepDetails?.[0] || null,
      stepRange: Object.freeze({
        from: classification.step.from,
        to: classification.step.to,
        structure: classification.step.structure === true
      }),
      sourceRange,
      previousCanonicalRange,
      transactionJournal: verified.proof,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(markdown),
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({ boundary, markdown, canonical, expectedDoc, proof })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: TABLE_ROW_DELETE_TRANSACTION_FAMILY,
    boundary: TABLE_ROW_DELETE_TRANSACTION_BOUNDARY,
    plan
  })
}
