import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  classifySingleTopLevelSubtreeChange,
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const TABLE_COLUMN_DELETE_TRANSACTION_FAMILY = 'table-column-delete'
export const TABLE_COLUMN_DELETE_TRANSACTION_BOUNDARY = 'transaction-table-column-delete'

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

const rowTypeMatches = (row, rowIndex) => {
  const name = row?.type?.name || ''
  return rowIndex === 0
    ? name === 'table_header_row' || name === 'table_row'
    : name === 'table_row'
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
    if (!rowTypeMatches(row, rowIndex) || row.childCount !== columns) return null
    for (let cellIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
      if (!isSimpleGridCell(row.child(cellIndex), rowIndex === 0)) return null
    }
  }
  return columns
}

const columnDeletionCandidates = (previousTable, nextTable) => {
  if (
    previousTable?.type?.name !== 'table' ||
    nextTable?.type?.name !== 'table' ||
    previousTable.childCount !== nextTable.childCount ||
    previousTable.childCount < 2
  ) return []
  const previousColumns = previousTable.child(0)?.childCount || 0
  const nextColumns = nextTable.child(0)?.childCount || 0
  if (previousColumns !== nextColumns + 1 || previousColumns <= 1) return []

  const candidates = []
  for (let deletedColumnIndex = 0; deletedColumnIndex < previousColumns; deletedColumnIndex += 1) {
    let equal = true
    for (let rowIndex = 0; rowIndex < previousTable.childCount && equal; rowIndex += 1) {
      const previousRow = previousTable.child(rowIndex)
      const nextRow = nextTable.child(rowIndex)
      if (
        previousRow.type?.name !== nextRow.type?.name ||
        !sourceSyncAttrsEqual(previousRow.attrs, nextRow.attrs) ||
        previousRow.childCount !== nextRow.childCount + 1
      ) {
        equal = false
        break
      }
      for (let nextCellIndex = 0; nextCellIndex < nextRow.childCount; nextCellIndex += 1) {
        const previousCellIndex = nextCellIndex < deletedColumnIndex
          ? nextCellIndex
          : nextCellIndex + 1
        if (previousRow.child(previousCellIndex).eq?.(nextRow.child(nextCellIndex)) !== true) {
          equal = false
          break
        }
      }
    }
    if (equal) candidates.push(deletedColumnIndex)
  }
  return candidates
}

const stagedTableMatches = ({
  table,
  previousTable,
  nextTable,
  processedRows
}) => {
  if (
    table?.type?.name !== 'table' ||
    table.childCount !== previousTable.childCount ||
    !sourceSyncAttrsEqual(table.attrs, previousTable.attrs)
  ) return false
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const expected = rowIndex < processedRows
      ? nextTable.child(rowIndex)
      : previousTable.child(rowIndex)
    if (table.child(rowIndex).eq?.(expected) !== true) return false
  }
  return true
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

const parsePipeLine = (rawLine, expectedColumns) => {
  const line = String(rawLine || '')
  const pipes = []
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '|') pipes.push(index)
  }
  let firstNonSpace = 0
  while (firstNonSpace < line.length && /[ \t]/.test(line[firstNonSpace])) firstNonSpace += 1
  let lastNonSpace = line.length - 1
  while (lastNonSpace >= 0 && /[ \t]/.test(line[lastNonSpace])) lastNonSpace -= 1
  const hasLeadingPipe = line[firstNonSpace] === '|'
  const hasTrailingPipe = lastNonSpace >= 0 && line[lastNonSpace] === '|'
  const columnCount = pipes.length + 1 - (hasLeadingPipe ? 1 : 0) - (hasTrailingPipe ? 1 : 0)
  if (columnCount !== expectedColumns || columnCount <= 0) return null

  const cells = []
  const separatorOffset = hasLeadingPipe ? 1 : 0
  for (let cellIndex = 0; cellIndex < columnCount; cellIndex += 1) {
    const start = cellIndex === 0
      ? (hasLeadingPipe ? pipes[0] + 1 : 0)
      : pipes[separatorOffset + cellIndex - 1] + 1
    const end = cellIndex === columnCount - 1
      ? (hasTrailingPipe ? pipes[pipes.length - 1] : line.length)
      : pipes[separatorOffset + cellIndex]
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return null
    cells.push(Object.freeze({ index: cellIndex, start, end, raw: line.slice(start, end) }))
  }
  return Object.freeze({
    rawLine: line,
    columnCount,
    pipes: Object.freeze(pipes),
    hasLeadingPipe,
    hasTrailingPipe,
    leadingPipeIndex: hasLeadingPipe ? pipes[0] : null,
    trailingPipeIndex: hasTrailingPipe ? pipes[pipes.length - 1] : null,
    cells: Object.freeze(cells)
  })
}

const deletionRangeForColumn = (parsed, deletedColumnIndex) => {
  if (
    !parsed ||
    parsed.columnCount <= 1 ||
    deletedColumnIndex < 0 ||
    deletedColumnIndex >= parsed.columnCount
  ) return null
  let from
  let to
  if (deletedColumnIndex === 0) {
    from = parsed.hasLeadingPipe ? parsed.leadingPipeIndex + 1 : 0
    to = parsed.cells[1].start
  } else {
    from = parsed.cells[deletedColumnIndex - 1].end
    to = parsed.cells[deletedColumnIndex].end
  }
  if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to) return null
  return Object.freeze({ from, to })
}

const resultLineAfterColumnDelete = ({ rawLine, parsed, deletedColumnIndex, remainingTexts = null }) => {
  const range = deletionRangeForColumn(parsed, deletedColumnIndex)
  if (!range) return null
  const resultLine = rawLine.slice(0, range.from) + rawLine.slice(range.to)
  const resultParsed = parsePipeLine(resultLine, parsed.columnCount - 1)
  if (!resultParsed) return null
  if (remainingTexts) {
    if (remainingTexts.length !== resultParsed.columnCount) return null
    for (let cellIndex = 0; cellIndex < remainingTexts.length; cellIndex += 1) {
      if (resultParsed.cells[cellIndex].raw.trim() !== remainingTexts[cellIndex]) return null
    }
  }
  return Object.freeze({
    relativeFrom: range.from,
    relativeTo: range.to,
    deletedBytes: rawLine.slice(range.from, range.to),
    resultLine,
    resultParsed
  })
}

const resolveRowSourceLine = ({
  markdown,
  doc,
  tableIndex,
  rowIndex,
  columns,
  deletedColumnIndex,
  resolveMarkdownOffset,
  side
}) => {
  const rowPath = [tableIndex, rowIndex]
  const rowEntry = sourceSyncNodeEntryAtPath(doc, rowPath)
  const row = rowEntry?.node
  if (!rowTypeMatches(row, rowIndex) || row.childCount !== columns) {
    return rejected(`table-column-delete-${side}-row-shape`)
  }

  let physicalLine = null
  const cells = []
  for (let cellIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
    const cell = row.child(cellIndex)
    if (!isSimpleGridCell(cell, rowIndex === 0)) {
      return rejected(`table-column-delete-${side}-cell-shape`)
    }
    const paragraph = cell.child(0)
    if (!isSimpleNonEmptyParagraph(paragraph)) {
      return rejected(`table-column-delete-${side}-cell-text`)
    }
    const paragraphPath = [...rowPath, cellIndex, 0]
    const paragraphEntry = sourceSyncNodeEntryAtPath(doc, paragraphPath)
    if (!paragraphEntry) return rejected(`table-column-delete-${side}-paragraph-missing`)

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
      return rejected(`table-column-delete-${side}-position-mapper-threw`)
    }
    if (
      !Number.isFinite(rawStart) ||
      !Number.isFinite(rawEnd) ||
      rawStart < 0 ||
      rawStart > rawEnd ||
      rawEnd > markdown.length
    ) return rejected(`table-column-delete-${side}-position-unmapped`)

    const cellLine = physicalLineAt(markdown, rawStart)
    if (!physicalLine) physicalLine = cellLine
    if (
      cellLine.start !== physicalLine.start ||
      rawStart < physicalLine.start ||
      rawEnd > physicalLine.textEnd
    ) return rejected(`table-column-delete-${side}-cross-line-cell`)

    const value = paragraph.textContent || ''
    if (markdown.slice(rawStart, rawEnd) !== value) {
      return rejected(`table-column-delete-${side}-cell-text-mismatch`, {
        proof: { rowIndex, cellIndex, value, rawText: markdown.slice(rawStart, rawEnd) }
      })
    }
    cells.push(Object.freeze({
      cellIndex,
      value,
      pmStart: paragraphEntry.contentStart,
      pmEnd: paragraphEntry.contentStart + paragraph.content.size,
      rawStart,
      rawEnd
    }))
  }

  if (!physicalLine || !physicalLine.rawLine.includes('|')) {
    return rejected(`table-column-delete-${side}-table-line-missing`)
  }
  const parsed = parsePipeLine(physicalLine.rawLine, columns)
  if (!parsed) return rejected(`table-column-delete-${side}-pipe-shape`)
  for (const cell of cells) {
    const segment = parsed.cells[cell.cellIndex]
    const relativeStart = cell.rawStart - physicalLine.start
    const relativeEnd = cell.rawEnd - physicalLine.start
    if (
      relativeStart < segment.start ||
      relativeEnd > segment.end ||
      segment.raw.trim() !== cell.value
    ) return rejected(`table-column-delete-${side}-cell-segment-mismatch`)
  }

  const remainingTexts = cells
    .filter((cell) => cell.cellIndex !== deletedColumnIndex)
    .map((cell) => cell.value)
  const deletion = resultLineAfterColumnDelete({
    rawLine: physicalLine.rawLine,
    parsed,
    deletedColumnIndex,
    remainingTexts
  })
  if (!deletion) return rejected(`table-column-delete-${side}-line-delete-invalid`)

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
    parsed,
    cells: Object.freeze(cells),
    deletion: Object.freeze({
      ...deletion,
      rawFrom: physicalLine.start + deletion.relativeFrom,
      rawTo: physicalLine.start + deletion.relativeTo
    })
  })
}

const resolveDelimiterLine = ({
  markdown,
  headerLine,
  columns,
  deletedColumnIndex,
  side
}) => {
  const physicalLine = physicalLineAt(markdown, headerLine.end)
  if (physicalLine.start !== headerLine.end) {
    return rejected(`table-column-delete-${side}-delimiter-position`)
  }
  const parsed = parsePipeLine(physicalLine.rawLine, columns)
  if (!parsed) return rejected(`table-column-delete-${side}-delimiter-shape`)
  if (!parsed.cells.every((cell) => /^:?-{1,}:?$/.test(cell.raw.trim()))) {
    return rejected(`table-column-delete-${side}-delimiter-syntax`)
  }
  const deletion = resultLineAfterColumnDelete({
    rawLine: physicalLine.rawLine,
    parsed,
    deletedColumnIndex
  })
  if (
    !deletion ||
    !deletion.resultParsed.cells.every((cell) => /^:?-{1,}:?$/.test(cell.raw.trim()))
  ) return rejected(`table-column-delete-${side}-delimiter-delete-invalid`)

  return Object.freeze({
    ok: true,
    side,
    start: physicalLine.start,
    textEnd: physicalLine.textEnd,
    end: physicalLine.end,
    eol: physicalLine.eol,
    rawLine: physicalLine.rawLine,
    parsed,
    deletion: Object.freeze({
      ...deletion,
      rawFrom: physicalLine.start + deletion.relativeFrom,
      rawTo: physicalLine.start + deletion.relativeTo
    })
  })
}

const resolveTableSourceLayout = ({
  markdown,
  doc,
  tableIndex,
  columns,
  deletedColumnIndex,
  resolveMarkdownOffset,
  side
}) => {
  const table = sourceSyncNodeEntryAtPath(doc, [tableIndex])?.node
  if (simpleGridColumnCount(table) !== columns) {
    return rejected(`table-column-delete-${side}-grid-topology`)
  }

  const rows = []
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const rowLine = resolveRowSourceLine({
      markdown,
      doc,
      tableIndex,
      rowIndex,
      columns,
      deletedColumnIndex,
      resolveMarkdownOffset,
      side
    })
    if (!rowLine.ok) return rowLine
    rows.push(rowLine)
  }
  const delimiter = resolveDelimiterLine({
    markdown,
    headerLine: rows[0],
    columns,
    deletedColumnIndex,
    side
  })
  if (!delimiter.ok) return delimiter
  if (rows[1]?.start !== delimiter.end) {
    return rejected(`table-column-delete-${side}-first-body-position`)
  }
  for (let rowIndex = 2; rowIndex < rows.length; rowIndex += 1) {
    if (rows[rowIndex].start !== rows[rowIndex - 1].end) {
      return rejected(`table-column-delete-${side}-body-row-position`)
    }
  }

  const edits = [delimiter, ...rows].map((line) => Object.freeze({
    rowIndex: line.rowIndex ?? null,
    kind: line.rowIndex == null ? 'delimiter' : (line.rowIndex === 0 ? 'header' : 'body'),
    rawLine: line.rawLine,
    resultLine: line.deletion.resultLine,
    rawFrom: line.deletion.rawFrom,
    rawTo: line.deletion.rawTo,
    deletedBytes: line.deletion.deletedBytes
  }))
  const ascending = [...edits].sort((left, right) => left.rawFrom - right.rawFrom)
  for (let index = 1; index < ascending.length; index += 1) {
    if (ascending[index - 1].rawTo > ascending[index].rawFrom) {
      return rejected(`table-column-delete-${side}-overlapping-edits`)
    }
  }

  return Object.freeze({
    ok: true,
    side,
    tablePath: Object.freeze([tableIndex]),
    tableIndex,
    columns,
    deletedColumnIndex,
    rows: Object.freeze(rows),
    delimiter,
    edits: Object.freeze(edits)
  })
}

const applyRawEdits = (markdown, edits) => {
  let result = markdown
  for (const edit of [...edits].sort((left, right) => right.rawFrom - left.rawFrom)) {
    result = result.slice(0, edit.rawFrom) + result.slice(edit.rawTo)
  }
  return result
}

const classifyTableColumnDeleteJournal = ({ journal, expectedDoc }) => {
  const topLevel = classifySingleTopLevelSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'table',
    reasonPrefix: 'table-column-delete'
  })
  if (!topLevel.ok) return topLevel

  const previousTable = topLevel.previousEntry.node
  const nextTable = topLevel.nextEntry.node
  if (!sourceSyncAttrsEqual(previousTable.attrs, nextTable.attrs)) {
    return rejected('table-column-delete-table-attrs-changed')
  }
  if (previousTable.childCount !== nextTable.childCount) {
    return rejected('table-column-delete-row-count')
  }
  const previousColumns = simpleGridColumnCount(previousTable)
  const nextColumns = simpleGridColumnCount(nextTable)
  if (
    !previousColumns ||
    !nextColumns ||
    previousColumns !== nextColumns + 1 ||
    previousColumns <= 1
  ) return rejected('table-column-delete-grid-topology')

  const candidates = columnDeletionCandidates(previousTable, nextTable)
  if (candidates.length !== 1) {
    return rejected('table-column-delete-owned-column-count', { proof: { candidates } })
  }
  const deletedColumnIndex = candidates[0]
  for (let rowIndex = 0; rowIndex < previousTable.childCount; rowIndex += 1) {
    const deletedCell = previousTable.child(rowIndex).child(deletedColumnIndex)
    if (
      !isSimpleGridCell(deletedCell, rowIndex === 0) ||
      !isSimpleNonEmptyParagraph(deletedCell.child(0))
    ) return rejected('table-column-delete-deleted-column-not-simple')
  }

  if (journal?.entries?.length !== 1) {
    return rejected('table-column-delete-transaction-count')
  }
  const entry = journal.entries[0]
  if (entry.steps?.length !== previousTable.childCount) {
    return rejected('table-column-delete-step-count')
  }
  if (!sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc)) {
    return rejected('table-column-delete-entry-document-mismatch')
  }

  let currentDoc = journal.oldDoc
  const stepRanges = []
  for (let rowIndex = 0; rowIndex < entry.steps.length; rowIndex += 1) {
    const step = entry.steps[rowIndex]
    if (step?.constructor?.name !== 'ReplaceStep') {
      return rejected('table-column-delete-step-not-replace')
    }
    if (!Number.isFinite(step.from) || !Number.isFinite(step.to)) {
      return rejected('table-column-delete-step-range-invalid')
    }
    if (!isEmptyClosedSlice(step.slice)) {
      return rejected('table-column-delete-step-slice-not-empty')
    }
    const stepDoc = entry.stepDocs?.[rowIndex] || (rowIndex === 0 ? entry.beforeDoc : null)
    if (!stepDoc || !sameSourceSyncDocument(stepDoc, currentDoc)) {
      return rejected('table-column-delete-step-document-mismatch')
    }
    const stepTable = sourceSyncNodeEntryAtPath(stepDoc, [topLevel.topLevelIndex])?.node
    if (!stagedTableMatches({
      table: stepTable,
      previousTable,
      nextTable,
      processedRows: rowIndex
    })) return rejected('table-column-delete-step-staged-table-mismatch')

    const cellPath = [topLevel.topLevelIndex, rowIndex, deletedColumnIndex]
    const cellEntry = sourceSyncNodeEntryAtPath(stepDoc, cellPath)
    const previousCell = previousTable.child(rowIndex).child(deletedColumnIndex)
    if (
      !cellEntry ||
      cellEntry.node?.eq?.(previousCell) !== true ||
      step.from !== cellEntry.beforePos ||
      step.to !== cellEntry.beforePos + cellEntry.node.nodeSize
    ) return rejected('table-column-delete-step-outside-owned-cell', {
      proof: {
        rowIndex,
        cellPath,
        from: step.from,
        to: step.to,
        expectedFrom: cellEntry?.beforePos ?? null,
        expectedTo: cellEntry ? cellEntry.beforePos + cellEntry.node.nodeSize : null
      }
    })

    let applied
    try {
      applied = step.apply(stepDoc)
    } catch {
      return rejected('table-column-delete-step-apply-failed')
    }
    if (applied?.failed || !applied?.doc) {
      return rejected('table-column-delete-step-apply-failed')
    }
    const appliedTable = sourceSyncNodeEntryAtPath(applied.doc, [topLevel.topLevelIndex])?.node
    if (!stagedTableMatches({
      table: appliedTable,
      previousTable,
      nextTable,
      processedRows: rowIndex + 1
    })) return rejected('table-column-delete-step-result-mismatch')

    stepRanges.push(Object.freeze({
      rowIndex,
      cellPath: Object.freeze(cellPath),
      from: step.from,
      to: step.to,
      nodeSize: previousCell.nodeSize,
      structure: step.structure === true
    }))
    currentDoc = applied.doc
  }

  if (
    !sameSourceSyncDocument(currentDoc, entry.afterDoc) ||
    !sameSourceSyncDocument(entry.afterDoc, expectedDoc) ||
    !sameSourceSyncDocument(journal.expectedDoc, expectedDoc)
  ) return rejected('table-column-delete-transaction-result-mismatch')

  return Object.freeze({
    ...topLevel,
    previousTable,
    nextTable,
    tablePath: Object.freeze([topLevel.topLevelIndex]),
    deletedColumnIndex,
    previousColumnCount: previousColumns,
    nextColumnCount: nextColumns,
    rowCount: previousTable.childCount,
    deletedCellTexts: Object.freeze(Array.from(
      { length: previousTable.childCount },
      (_, rowIndex) => previousTable.child(rowIndex).child(deletedColumnIndex).textContent || ''
    )),
    stepRanges: Object.freeze(stepRanges)
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'table-column-deleted',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: TABLE_COLUMN_DELETE_TRANSACTION_FAMILY,
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

export function createTableColumnDeleteTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('table column delete owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('table column delete owner requires validateMarkdown')
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
    boundary = TABLE_COLUMN_DELETE_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('table-column-delete-journal-stale', { reset: true })
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
    ) return rejected('table-column-delete-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('table-column-delete-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('table-column-delete-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyTableColumnDeleteJournal({ journal, expectedDoc })
    if (!classification.ok) return classification

    const sourceLayout = resolveTableSourceLayout({
      markdown: journal.source,
      doc: journal.oldDoc,
      tableIndex: classification.topLevelIndex,
      columns: classification.previousColumnCount,
      deletedColumnIndex: classification.deletedColumnIndex,
      resolveMarkdownOffset,
      side: 'source'
    })
    if (!sourceLayout.ok) return sourceLayout
    const previousCanonicalLayout = resolveTableSourceLayout({
      markdown: journal.canonical,
      doc: journal.oldDoc,
      tableIndex: classification.topLevelIndex,
      columns: classification.previousColumnCount,
      deletedColumnIndex: classification.deletedColumnIndex,
      resolveMarkdownOffset,
      side: 'previous-canonical'
    })
    if (!previousCanonicalLayout.ok) return previousCanonicalLayout

    const markdown = applyRawEdits(journal.source, sourceLayout.edits)
    let equivalent = false
    try {
      equivalent = validateMarkdown({ markdown, expectedDoc }) === true
    } catch {
      return rejected('table-column-delete-semantic-validator-threw')
    }
    if (!equivalent) return rejected('table-column-delete-semantic-document-mismatch')

    const proof = Object.freeze({
      kind: 'transaction-table-column-delete-proof',
      journalId: journal.journalId,
      family: TABLE_COLUMN_DELETE_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      tablePath: classification.tablePath,
      deletedColumnIndex: classification.deletedColumnIndex,
      previousColumnCount: classification.previousColumnCount,
      nextColumnCount: classification.nextColumnCount,
      rowCount: classification.rowCount,
      deletedCellTexts: classification.deletedCellTexts,
      stepRanges: classification.stepRanges,
      stepDetails: journal.stepDetails,
      sourceLayout,
      previousCanonicalLayout,
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
    family: TABLE_COLUMN_DELETE_TRANSACTION_FAMILY,
    boundary: TABLE_COLUMN_DELETE_TRANSACTION_BOUNDARY,
    plan
  })
}
