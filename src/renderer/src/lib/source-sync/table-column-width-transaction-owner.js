import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  classifySingleTopLevelSubtreeChange,
  onlySourceSyncNodePathChanged,
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const TABLE_COLUMN_WIDTH_TRANSACTION_FAMILY = 'table-column-width'
export const TABLE_COLUMN_WIDTH_TRANSACTION_BOUNDARY = 'transaction-table-column-width'

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

const stableAttrsWithoutColumnWidth = (attrs = {}) => Object.fromEntries(
  Object.entries(attrs)
    .filter(([key, value]) => key !== 'colwidth' && value != null)
    .sort(([left], [right]) => left.localeCompare(right))
)

const attrsWithoutColumnWidthEqual = (left, right) =>
  JSON.stringify(stableAttrsWithoutColumnWidth(left)) ===
  JSON.stringify(stableAttrsWithoutColumnWidth(right))

const columnWidthValue = (attrs = {}) => {
  const value = attrs.colwidth
  if (value == null) return Object.freeze({ ok: true, value: null })
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !Number.isInteger(value[0]) ||
    value[0] <= 0
  ) return Object.freeze({ ok: false, value: null })
  return Object.freeze({ ok: true, value: value[0] })
}

const rowTypeMatches = (row, rowIndex) => {
  if (rowIndex === 0) {
    // Standard prosemirror-tables represents the header as `table_row` with
    // `table_header` children; Milkdown GFM uses a dedicated
    // `table_header_row`. Accept exactly these two schema encodings while
    // keeping every header child type strict.
    if (!['table_row', 'table_header_row'].includes(row?.type?.name)) return false
    for (let index = 0; index < row.childCount; index += 1) {
      if (row.child(index)?.type?.name !== 'table_header') return false
    }
    return true
  }
  if (row?.type?.name !== 'table_row') return false
  for (let index = 0; index < row.childCount; index += 1) {
    if (row.child(index)?.type?.name !== 'table_cell') return false
  }
  return true
}

const simpleGridColumnCount = (table) => {
  if (table?.type?.name !== 'table' || table.childCount < 2) return null
  const columns = table.child(0)?.childCount || 0
  if (columns <= 0) return null
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex)
    if (!rowTypeMatches(row, rowIndex) || row.childCount !== columns) return null
    for (let cellIndex = 0; cellIndex < columns; cellIndex += 1) {
      const cell = row.child(cellIndex)
      if (
        (cell.attrs?.colspan ?? 1) !== 1 ||
        (cell.attrs?.rowspan ?? 1) !== 1 ||
        !columnWidthValue(cell.attrs).ok
      ) return null
    }
  }
  return columns
}

const columnWidthCandidates = (previousTable, nextTable) => {
  if (
    previousTable?.type?.name !== 'table' ||
    nextTable?.type?.name !== 'table' ||
    previousTable.childCount !== nextTable.childCount ||
    previousTable.childCount < 2 ||
    !sourceSyncAttrsEqual(previousTable.attrs, nextTable.attrs)
  ) return []
  const columns = simpleGridColumnCount(previousTable)
  if (!columns || simpleGridColumnCount(nextTable) !== columns) return []

  const candidates = []
  for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
    const previousWidths = []
    const nextWidths = []
    let valid = true
    for (let rowIndex = 0; rowIndex < previousTable.childCount && valid; rowIndex += 1) {
      const previousRow = previousTable.child(rowIndex)
      const nextRow = nextTable.child(rowIndex)
      if (
        previousRow.type?.name !== nextRow.type?.name ||
        !sourceSyncAttrsEqual(previousRow.attrs, nextRow.attrs) ||
        previousRow.childCount !== nextRow.childCount
      ) {
        valid = false
        break
      }
      for (let cellIndex = 0; cellIndex < columns; cellIndex += 1) {
        const previousCell = previousRow.child(cellIndex)
        const nextCell = nextRow.child(cellIndex)
        if (cellIndex !== columnIndex) {
          if (previousCell.eq?.(nextCell) !== true) valid = false
          continue
        }
        const previousWidth = columnWidthValue(previousCell.attrs)
        const nextWidth = columnWidthValue(nextCell.attrs)
        if (
          previousCell.type?.name !== nextCell.type?.name ||
          previousCell.content?.eq?.(nextCell.content) !== true ||
          !attrsWithoutColumnWidthEqual(previousCell.attrs, nextCell.attrs) ||
          !previousWidth.ok ||
          !nextWidth.ok ||
          nextWidth.value == null ||
          nextWidth.value < 25 ||
          previousWidth.value === nextWidth.value
        ) {
          valid = false
          break
        }
        previousWidths.push(previousWidth.value)
        nextWidths.push(nextWidth.value)
      }
    }
    if (
      valid &&
      new Set(previousWidths).size === 1 &&
      new Set(nextWidths).size === 1
    ) {
      candidates.push(Object.freeze({
        columnIndex,
        previousWidth: previousWidths[0],
        nextWidth: nextWidths[0]
      }))
    }
  }
  return candidates
}

const stagedTableMatches = ({
  table,
  previousTable,
  nextTable,
  columnIndex,
  processedRows
}) => {
  if (
    table?.type?.name !== 'table' ||
    table.childCount !== previousTable.childCount ||
    !sourceSyncAttrsEqual(table.attrs, previousTable.attrs)
  ) return false
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex)
    const previousRow = previousTable.child(rowIndex)
    const nextRow = nextTable.child(rowIndex)
    if (
      row.type?.name !== previousRow.type?.name ||
      !sourceSyncAttrsEqual(row.attrs, previousRow.attrs) ||
      row.childCount !== previousRow.childCount
    ) return false
    for (let cellIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
      const expected = cellIndex === columnIndex && rowIndex < processedRows
        ? nextRow.child(cellIndex)
        : previousRow.child(cellIndex)
      if (row.child(cellIndex).eq?.(expected) !== true) return false
    }
  }
  return true
}

const classifyColumnWidthJournal = ({ journal, expectedDoc }) => {
  const topLevel = classifySingleTopLevelSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'table',
    reasonPrefix: 'table-column-width'
  })
  if (!topLevel.ok) return topLevel
  const previousTable = topLevel.previousEntry.node
  const nextTable = topLevel.nextEntry.node
  const candidates = columnWidthCandidates(previousTable, nextTable)
  if (candidates.length !== 1) {
    return rejected('table-column-width-column-count', {
      proof: {
        candidateCount: candidates.length,
        candidates,
        previousGridColumns: simpleGridColumnCount(previousTable),
        nextGridColumns: simpleGridColumnCount(nextTable)
      }
    })
  }
  const candidate = candidates[0]
  const tablePath = Object.freeze([topLevel.topLevelIndex])
  if (!Array.isArray(journal.entries) || journal.entries.length !== 1) {
    return rejected('table-column-width-entry-count')
  }
  const entry = journal.entries[0]
  if (!sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc)) {
    return rejected('table-column-width-entry-baseline')
  }
  if (entry.steps?.length !== previousTable.childCount) {
    return rejected('table-column-width-step-count')
  }

  const stepRanges = []
  const cellPaths = []
  let entryDoc = entry.beforeDoc
  for (let rowIndex = 0; rowIndex < entry.steps.length; rowIndex += 1) {
    const step = entry.steps[rowIndex]
    const stepDoc = entry.stepDocs?.[rowIndex] || (rowIndex === 0 ? entry.beforeDoc : null)
    if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
      return rejected('table-column-width-step-document-missing')
    }
    const stagedTable = sourceSyncNodeEntryAtPath(stepDoc, tablePath)?.node
    if (!stagedTableMatches({
      table: stagedTable,
      previousTable,
      nextTable,
      columnIndex: candidate.columnIndex,
      processedRows: rowIndex
    })) return rejected('table-column-width-staged-table')
    if (
      step?.constructor?.name !== 'ReplaceAroundStep' ||
      step.structure !== true ||
      !Number.isFinite(step.from) ||
      !Number.isFinite(step.to) ||
      !Number.isFinite(step.gapFrom) ||
      !Number.isFinite(step.gapTo) ||
      step.insert !== 1 ||
      step.slice?.openStart !== 0 ||
      step.slice?.openEnd !== 0 ||
      step.slice?.content?.childCount !== 1
    ) return rejected('table-column-width-step-shape')

    const cellPath = Object.freeze([
      topLevel.topLevelIndex,
      rowIndex,
      candidate.columnIndex
    ])
    const beforeEntry = sourceSyncNodeEntryAtPath(stepDoc, cellPath)
    const beforeCell = beforeEntry?.node
    const expectedCell = nextTable.child(rowIndex).child(candidate.columnIndex)
    const wrapper = step.slice.content.child(0)
    if (
      !beforeEntry ||
      step.from !== beforeEntry.beforePos ||
      step.to !== beforeEntry.beforePos + beforeCell.nodeSize ||
      step.gapFrom !== beforeEntry.contentStart ||
      step.gapTo !== beforeEntry.contentStart + beforeCell.content.size ||
      wrapper?.type?.name !== expectedCell.type?.name ||
      wrapper.childCount !== 0 ||
      !sourceSyncAttrsEqual(wrapper.attrs, expectedCell.attrs)
    ) return rejected('table-column-width-step-range')

    let applied
    try {
      applied = step.apply(stepDoc)
    } catch {
      return rejected('table-column-width-step-apply-failed')
    }
    if (applied?.failed || !applied?.doc) {
      return rejected('table-column-width-step-apply-failed')
    }
    if (!onlySourceSyncNodePathChanged(stepDoc, applied.doc, cellPath)) {
      return rejected('table-column-width-step-neighbour-changed')
    }
    const afterCell = sourceSyncNodeEntryAtPath(applied.doc, cellPath)?.node
    if (afterCell?.eq?.(expectedCell) !== true) {
      return rejected('table-column-width-step-result')
    }
    const afterTable = sourceSyncNodeEntryAtPath(applied.doc, tablePath)?.node
    if (!stagedTableMatches({
      table: afterTable,
      previousTable,
      nextTable,
      columnIndex: candidate.columnIndex,
      processedRows: rowIndex + 1
    })) return rejected('table-column-width-staged-result')

    cellPaths.push(cellPath)
    stepRanges.push(Object.freeze({
      rowIndex,
      cellPath,
      from: step.from,
      to: step.to,
      gapFrom: step.gapFrom,
      gapTo: step.gapTo,
      stepName: step.constructor.name
    }))
    entryDoc = applied.doc
  }
  if (!sameSourceSyncDocument(entryDoc, entry.afterDoc)) {
    return rejected('table-column-width-entry-result')
  }
  if (!sameSourceSyncDocument(entryDoc, expectedDoc)) {
    return rejected('table-column-width-final-document')
  }

  return Object.freeze({
    ...topLevel,
    tablePath,
    previousTable,
    nextTable,
    columnIndex: candidate.columnIndex,
    previousWidth: candidate.previousWidth,
    nextWidth: candidate.nextWidth,
    columns: previousTable.child(0).childCount,
    rowCount: previousTable.childCount,
    cellPaths: Object.freeze(cellPaths),
    stepRanges: Object.freeze(stepRanges)
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'table-column-width-changed',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: TABLE_COLUMN_WIDTH_TRANSACTION_FAMILY,
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
      notifyChange: false
    })
  })
}

export function createTableColumnWidthTransactionSourceSyncOwner({
  validateMarkdown
} = {}) {
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('table column width owner requires validateMarkdown')
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
    boundary = TABLE_COLUMN_WIDTH_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('table-column-width-journal-stale', { reset: true })
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
    ) return rejected('table-column-width-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('table-column-width-live-snapshot-stale', { reset: true })
    }
    if (canonical !== journal.canonical) {
      return rejected('table-column-width-canonical-changed')
    }

    const classification = classifyColumnWidthJournal({ journal, expectedDoc })
    if (!classification.ok) return classification
    let metadataEquivalent = false
    try {
      metadataEquivalent = validateMarkdown({
        markdown: canonical,
        expectedDoc,
        semanticOptions: {
          ignoreTableColumnWidthPaths: classification.cellPaths
        }
      }) === true
    } catch {
      return rejected('table-column-width-semantic-validator-threw')
    }
    if (!metadataEquivalent) {
      return rejected('table-column-width-semantic-document-mismatch')
    }

    const proof = Object.freeze({
      kind: 'transaction-table-column-width-proof',
      journalId: journal.journalId,
      family: TABLE_COLUMN_WIDTH_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      tablePath: classification.tablePath,
      columnIndex: classification.columnIndex,
      previousWidth: classification.previousWidth,
      nextWidth: classification.nextWidth,
      columnCount: classification.columns,
      rowCount: classification.rowCount,
      cellPaths: classification.cellPaths,
      stepRanges: classification.stepRanges,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(journal.source),
      sourceUnchanged: true,
      canonicalUnchanged: true,
      callbackDocumentEquivalent: callbackDocumentEquivalent === true,
      metadataDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({
      boundary,
      markdown: journal.source,
      canonical,
      expectedDoc,
      proof
    })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: TABLE_COLUMN_WIDTH_TRANSACTION_FAMILY,
    boundary: TABLE_COLUMN_WIDTH_TRANSACTION_BOUNDARY,
    plan
  })
}
