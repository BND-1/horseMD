import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  classifySingleTopLevelSubtreeChange,
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const TABLE_ROW_INSERT_TRANSACTION_FAMILY = 'table-row-insert'
export const TABLE_ROW_INSERT_TRANSACTION_BOUNDARY = 'transaction-table-row-insert'

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

const isEditorEmptyParagraph = (node) => {
  if (node?.type?.name !== 'paragraph' || !node.isTextblock) return false
  if (node.content?.size === 0) return true
  let empty = true
  node.forEach?.((child) => {
    const name = child?.type?.name || ''
    if (name !== 'hardbreak' && name !== 'hard_break') empty = false
  })
  return empty
}

const isStructuralGridCell = (cell, header) => Boolean(
  cell &&
  cell.type?.name === (header ? 'table_header' : 'table_cell') &&
  (cell.attrs?.colspan ?? 1) === 1 &&
  (cell.attrs?.rowspan ?? 1) === 1 &&
  cell.attrs?.colwidth == null &&
  cell.childCount === 1
)

const structuralGridColumnCount = (table) => {
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
      if (!isStructuralGridCell(row.child(cellIndex), rowIndex === 0)) return null
    }
  }
  return columns
}

const isEmptyInsertedRow = (row, columns) => {
  if (row?.type?.name !== 'table_row' || row.childCount !== columns) return false
  for (let cellIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
    const cell = row.child(cellIndex)
    if (!isStructuralGridCell(cell, false) || !isEditorEmptyParagraph(cell.child(0))) {
      return false
    }
  }
  return true
}

const isSimpleTemplateRow = (row, columns) => {
  if (row?.type?.name !== 'table_row' || row.childCount !== columns) return false
  for (let cellIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
    const cell = row.child(cellIndex)
    if (!isStructuralGridCell(cell, false) || !isSimpleNonEmptyParagraph(cell.child(0))) {
      return false
    }
  }
  return true
}

const rowInsertionCandidates = (previousTable, nextTable) => {
  if (
    nextTable?.childCount !== previousTable?.childCount + 1 ||
    previousTable?.type?.name !== 'table' ||
    nextTable?.type?.name !== 'table'
  ) return []
  const candidates = []
  for (let insertedIndex = 0; insertedIndex < nextTable.childCount; insertedIndex += 1) {
    let equal = true
    for (let previousIndex = 0; previousIndex < previousTable.childCount; previousIndex += 1) {
      const nextIndex = previousIndex < insertedIndex ? previousIndex : previousIndex + 1
      if (previousTable.child(previousIndex).eq?.(nextTable.child(nextIndex)) !== true) {
        equal = false
        break
      }
    }
    if (equal) candidates.push(insertedIndex)
  }
  return candidates
}

const insertionBoundaryAt = (doc, tableIndex, table, insertedIndex) => {
  if (insertedIndex < table.childCount) {
    return sourceSyncNodeEntryAtPath(doc, [tableIndex, insertedIndex])?.beforePos ?? null
  }
  const tableEntry = sourceSyncNodeEntryAtPath(doc, [tableIndex])
  return tableEntry ? tableEntry.contentStart + table.content.size : null
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

const nearestLineEnding = (markdown, rawOffset) => {
  const text = String(markdown || '')
  const describe = (index) => {
    const code = text.charCodeAt(index)
    if (code === 13) return text.charCodeAt(index + 1) === 10 ? '\r\n' : '\r'
    if (code === 10) return index > 0 && text.charCodeAt(index - 1) === 13 ? '\r\n' : '\n'
    return null
  }
  for (let index = Math.max(0, rawOffset); index < text.length; index += 1) {
    const eol = describe(index)
    if (eol) return eol
  }
  for (let index = Math.min(text.length - 1, rawOffset - 1); index >= 0; index -= 1) {
    const eol = describe(index)
    if (eol) return eol
  }
  return null
}

const resolveTemplateRowRange = ({
  markdown,
  doc,
  tableIndex,
  rowIndex,
  columns,
  resolveMarkdownOffset,
  side
}) => {
  const rowPath = [tableIndex, rowIndex]
  const rowEntry = sourceSyncNodeEntryAtPath(doc, rowPath)
  const row = rowEntry?.node
  if (!isSimpleTemplateRow(row, columns)) {
    return rejected(`table-row-insert-${side}-template-row-not-simple`)
  }

  let physicalLine = null
  const cells = []
  for (let cellIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
    const paragraph = row.child(cellIndex).child(0)
    const paragraphPath = [...rowPath, cellIndex, 0]
    const paragraphEntry = sourceSyncNodeEntryAtPath(doc, paragraphPath)
    if (!paragraphEntry) return rejected(`table-row-insert-${side}-paragraph-missing`)

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
      return rejected(`table-row-insert-${side}-position-mapper-threw`)
    }
    if (
      !Number.isFinite(rawStart) ||
      !Number.isFinite(rawEnd) ||
      rawStart < 0 ||
      rawStart > rawEnd ||
      rawEnd > markdown.length
    ) return rejected(`table-row-insert-${side}-position-unmapped`)

    const cellLine = physicalLineAt(markdown, rawStart)
    if (!physicalLine) physicalLine = cellLine
    if (
      cellLine.start !== physicalLine.start ||
      rawStart < physicalLine.start ||
      rawEnd > physicalLine.textEnd
    ) return rejected(`table-row-insert-${side}-cross-line-cell`)

    const text = paragraph.textContent || ''
    if (markdown.slice(rawStart, rawEnd) !== text) {
      return rejected(`table-row-insert-${side}-cell-text-mismatch`, {
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
    return rejected(`table-row-insert-${side}-table-line-missing`)
  }

  let blankLine = physicalLine.rawLine
  for (const cell of [...cells].sort((left, right) => right.rawStart - left.rawStart)) {
    const relativeStart = cell.rawStart - physicalLine.start
    const relativeEnd = cell.rawEnd - physicalLine.start
    blankLine = blankLine.slice(0, relativeStart) + blankLine.slice(relativeEnd)
  }
  if (!blankLine.includes('|')) {
    return rejected(`table-row-insert-${side}-blank-line-invalid`)
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
    blankLine,
    cells: Object.freeze(cells)
  })
}

const createRawInsertion = ({ markdown, templateRange, insertedRowIndex }) => {
  const eol = templateRange.eol || nearestLineEnding(markdown, templateRange.start)
  if (!eol) return rejected('table-row-insert-line-ending-missing')

  if (insertedRowIndex === 1) {
    return Object.freeze({
      ok: true,
      rawOffset: templateRange.start,
      placement: 'before-first-body-row',
      eol,
      bytes: templateRange.blankLine + eol
    })
  }
  if (templateRange.eol) {
    return Object.freeze({
      ok: true,
      rawOffset: templateRange.end,
      placement: 'after-template-row',
      eol,
      bytes: templateRange.blankLine + eol
    })
  }
  return Object.freeze({
    ok: true,
    rawOffset: templateRange.textEnd,
    placement: 'append-after-unterminated-row',
    eol,
    bytes: eol + templateRange.blankLine
  })
}

const classifyTableRowInsertJournal = ({ journal, expectedDoc }) => {
  const topLevel = classifySingleTopLevelSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'table',
    reasonPrefix: 'table-row-insert'
  })
  if (!topLevel.ok) return topLevel

  const previousTable = topLevel.previousEntry.node
  const nextTable = topLevel.nextEntry.node
  if (!sourceSyncAttrsEqual(previousTable.attrs, nextTable.attrs)) {
    return rejected('table-row-insert-table-attrs-changed')
  }
  if (nextTable.childCount !== previousTable.childCount + 1) {
    return rejected('table-row-insert-row-count')
  }
  const previousColumns = structuralGridColumnCount(previousTable)
  const nextColumns = structuralGridColumnCount(nextTable)
  if (!previousColumns || previousColumns !== nextColumns) {
    return rejected('table-row-insert-grid-topology')
  }

  if (journal?.entries?.length !== 1) {
    return rejected('table-row-insert-transaction-count')
  }
  const entry = journal.entries[0]
  if (entry.steps?.length !== 1) return rejected('table-row-insert-step-count')
  const step = entry.steps[0]
  if (step?.constructor?.name !== 'ReplaceStep') {
    return rejected('table-row-insert-step-not-replace')
  }
  if (
    !Number.isFinite(step.from) ||
    !Number.isFinite(step.to) ||
    step.from !== step.to
  ) return rejected('table-row-insert-step-range-invalid')
  if (
    !step.slice ||
    step.slice.openStart !== 0 ||
    step.slice.openEnd !== 0 ||
    step.slice.content?.childCount !== 1
  ) return rejected('table-row-insert-step-slice-shape')
  const stepDoc = entry.stepDocs?.[0] || entry.beforeDoc
  if (!stepDoc || !sameSourceSyncDocument(stepDoc, journal.oldDoc)) {
    return rejected('table-row-insert-step-document-mismatch')
  }

  const candidates = rowInsertionCandidates(previousTable, nextTable)
  const matching = candidates.filter((insertedRowIndex) => {
    const insertedRow = nextTable.child(insertedRowIndex)
    const boundary = insertionBoundaryAt(
      journal.oldDoc,
      topLevel.topLevelIndex,
      previousTable,
      insertedRowIndex
    )
    return Boolean(
      insertedRowIndex > 0 &&
      boundary === step.from &&
      step.slice.content.firstChild?.eq?.(insertedRow) === true &&
      isEmptyInsertedRow(insertedRow, previousColumns)
    )
  })
  if (matching.length !== 1) {
    return rejected('table-row-insert-owned-row-count', {
      proof: { candidates, matching, from: step.from, to: step.to }
    })
  }
  const insertedRowIndex = matching[0]
  const insertedRow = nextTable.child(insertedRowIndex)
  const templateRowIndex = insertedRowIndex > 1 ? insertedRowIndex - 1 : 1
  const templateRow = previousTable.child(templateRowIndex)
  if (!isSimpleTemplateRow(templateRow, previousColumns)) {
    return rejected('table-row-insert-template-row-not-simple')
  }

  let applied
  try {
    applied = step.apply(stepDoc)
  } catch {
    return rejected('table-row-insert-step-apply-failed')
  }
  if (applied?.failed || !applied?.doc) {
    return rejected('table-row-insert-step-apply-failed')
  }
  if (
    !sameSourceSyncDocument(applied.doc, entry.afterDoc) ||
    !sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(entry.afterDoc, expectedDoc) ||
    !sameSourceSyncDocument(journal.expectedDoc, expectedDoc)
  ) return rejected('table-row-insert-transaction-result-mismatch')

  return Object.freeze({
    ...topLevel,
    previousTable,
    nextTable,
    tablePath: Object.freeze([topLevel.topLevelIndex]),
    insertedRowPath: Object.freeze([topLevel.topLevelIndex, insertedRowIndex]),
    insertedRowIndex,
    insertedRow,
    templateRowPath: Object.freeze([topLevel.topLevelIndex, templateRowIndex]),
    templateRowIndex,
    templateRow,
    columnCount: previousColumns,
    step
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'table-row-inserted',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: TABLE_ROW_INSERT_TRANSACTION_FAMILY,
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

export function createTableRowInsertTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('table row insert owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('table row insert owner requires validateMarkdown')
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
    boundary = TABLE_ROW_INSERT_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('table-row-insert-journal-stale', { reset: true })
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
    ) return rejected('table-row-insert-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('table-row-insert-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('table-row-insert-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyTableRowInsertJournal({ journal, expectedDoc })
    if (!classification.ok) return classification

    const sourceTemplateRange = resolveTemplateRowRange({
      markdown: journal.source,
      doc: journal.oldDoc,
      tableIndex: classification.topLevelIndex,
      rowIndex: classification.templateRowIndex,
      columns: classification.columnCount,
      resolveMarkdownOffset,
      side: 'source'
    })
    if (!sourceTemplateRange.ok) return sourceTemplateRange
    const previousCanonicalTemplateRange = resolveTemplateRowRange({
      markdown: journal.canonical,
      doc: journal.oldDoc,
      tableIndex: classification.topLevelIndex,
      rowIndex: classification.templateRowIndex,
      columns: classification.columnCount,
      resolveMarkdownOffset,
      side: 'previous-canonical'
    })
    if (!previousCanonicalTemplateRange.ok) return previousCanonicalTemplateRange

    const insertion = createRawInsertion({
      markdown: journal.source,
      templateRange: sourceTemplateRange,
      insertedRowIndex: classification.insertedRowIndex
    })
    if (!insertion.ok) return insertion
    const markdown = journal.source.slice(0, insertion.rawOffset) +
      insertion.bytes +
      journal.source.slice(insertion.rawOffset)

    let equivalent = false
    try {
      equivalent = validateMarkdown({ markdown, expectedDoc }) === true
    } catch {
      return rejected('table-row-insert-semantic-validator-threw')
    }
    if (!equivalent) return rejected('table-row-insert-semantic-document-mismatch')

    const proof = Object.freeze({
      kind: 'transaction-table-row-insert-proof',
      journalId: journal.journalId,
      family: TABLE_ROW_INSERT_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      tablePath: classification.tablePath,
      insertedRowPath: classification.insertedRowPath,
      insertedRowIndex: classification.insertedRowIndex,
      templateRowPath: classification.templateRowPath,
      templateRowIndex: classification.templateRowIndex,
      columnCount: classification.columnCount,
      stepDetail: journal.stepDetails?.[0] || null,
      stepRange: Object.freeze({
        from: classification.step.from,
        to: classification.step.to,
        structure: classification.step.structure === true,
        sliceSize: classification.step.slice?.size ?? null
      }),
      sourceTemplateRange,
      previousCanonicalTemplateRange,
      insertion,
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
    family: TABLE_ROW_INSERT_TRANSACTION_FAMILY,
    boundary: TABLE_ROW_INSERT_TRANSACTION_BOUNDARY,
    plan
  })
}
