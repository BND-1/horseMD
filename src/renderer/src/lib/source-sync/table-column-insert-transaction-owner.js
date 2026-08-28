import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  classifySingleTopLevelSubtreeChange,
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const TABLE_COLUMN_INSERT_TRANSACTION_FAMILY = 'table-column-insert'
export const TABLE_COLUMN_INSERT_TRANSACTION_BOUNDARY = 'transaction-table-column-insert'

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

const rowTypeMatches = (row, rowIndex) => {
  const name = row?.type?.name || ''
  return rowIndex === 0
    ? name === 'table_header_row' || name === 'table_row'
    : name === 'table_row'
}

const resolveCellAlignment = (attrs = {}) => {
  const values = [attrs.alignment, attrs.align]
    .filter((value) => value != null && value !== '')
  if (new Set(values).size > 1) {
    return Object.freeze({ ok: false, value: null })
  }
  const value = values[0] ?? null
  return Object.freeze({
    ok: [null, 'left', 'center', 'right'].includes(value),
    value
  })
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

const isSimpleSourceGrid = (table, columns) => {
  if (simpleGridColumnCount(table) !== columns) return false
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex)
    for (let cellIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
      if (!isSimpleNonEmptyParagraph(row.child(cellIndex).child(0))) return false
    }
  }
  return true
}

const isEmptyInsertedCell = (cell, header) => Boolean(
  isSimpleGridCell(cell, header) &&
  isEditorEmptyParagraph(cell.child(0))
)

const columnInsertionCandidates = (previousTable, nextTable) => {
  if (
    previousTable?.type?.name !== 'table' ||
    nextTable?.type?.name !== 'table' ||
    previousTable.childCount !== nextTable.childCount ||
    previousTable.childCount < 2
  ) return []
  const previousColumns = previousTable.child(0)?.childCount || 0
  const nextColumns = nextTable.child(0)?.childCount || 0
  if (nextColumns !== previousColumns + 1 || previousColumns <= 0) return []

  const candidates = []
  for (let insertedColumnIndex = 0; insertedColumnIndex < nextColumns; insertedColumnIndex += 1) {
    let equal = true
    for (let rowIndex = 0; rowIndex < previousTable.childCount && equal; rowIndex += 1) {
      const previousRow = previousTable.child(rowIndex)
      const nextRow = nextTable.child(rowIndex)
      if (
        previousRow.type?.name !== nextRow.type?.name ||
        !sourceSyncAttrsEqual(previousRow.attrs, nextRow.attrs) ||
        nextRow.childCount !== previousRow.childCount + 1
      ) {
        equal = false
        break
      }
      for (let previousCellIndex = 0; previousCellIndex < previousRow.childCount; previousCellIndex += 1) {
        const nextCellIndex = previousCellIndex < insertedColumnIndex
          ? previousCellIndex
          : previousCellIndex + 1
        if (previousRow.child(previousCellIndex).eq?.(nextRow.child(nextCellIndex)) !== true) {
          equal = false
          break
        }
      }
    }
    if (equal) candidates.push(insertedColumnIndex)
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

const insertionBoundaryAt = (doc, tableIndex, rowIndex, insertedColumnIndex) => {
  const rowEntry = sourceSyncNodeEntryAtPath(doc, [tableIndex, rowIndex])
  const row = rowEntry?.node
  if (!row || insertedColumnIndex < 0 || insertedColumnIndex > row.childCount) return null
  if (insertedColumnIndex < row.childCount) {
    return sourceSyncNodeEntryAtPath(
      doc,
      [tableIndex, rowIndex, insertedColumnIndex]
    )?.beforePos ?? null
  }
  return rowEntry.contentStart + row.content.size
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

const blankCellRaw = ({ line, templateCellIndex }) => {
  const cell = line.cells[templateCellIndex]
  const segment = line.parsed.cells[templateCellIndex]
  if (!cell || !segment) return null
  const textStart = cell.rawStart - line.start - segment.start
  const textEnd = cell.rawEnd - line.start - segment.start
  if (
    textStart < 0 ||
    textStart > textEnd ||
    textEnd > segment.raw.length
  ) return null
  const blank = segment.raw.slice(0, textStart) + segment.raw.slice(textEnd)
  return blank.trim() === '' && !blank.includes('|') ? blank : null
}

const insertPipeCell = ({ rawLine, parsed, insertedColumnIndex, cellRaw }) => {
  if (
    !parsed ||
    insertedColumnIndex < 0 ||
    insertedColumnIndex > parsed.columnCount ||
    typeof cellRaw !== 'string' ||
    cellRaw.includes('|')
  ) return null

  const relativeOffset = insertedColumnIndex === 0
    ? parsed.cells[0].start
    : parsed.cells[insertedColumnIndex - 1].end
  const bytes = insertedColumnIndex === 0
    ? `${cellRaw}|`
    : `|${cellRaw}`
  const resultLine = rawLine.slice(0, relativeOffset) + bytes + rawLine.slice(relativeOffset)
  const resultParsed = parsePipeLine(resultLine, parsed.columnCount + 1)
  if (!resultParsed) return null
  return Object.freeze({ relativeOffset, bytes, resultLine, resultParsed })
}

const resolveRowSourceLine = ({
  markdown,
  doc,
  tableIndex,
  rowIndex,
  columns,
  insertedColumnIndex,
  resolveMarkdownOffset,
  side
}) => {
  const rowPath = [tableIndex, rowIndex]
  const rowEntry = sourceSyncNodeEntryAtPath(doc, rowPath)
  const row = rowEntry?.node
  if (!rowTypeMatches(row, rowIndex) || row.childCount !== columns) {
    return rejected(`table-column-insert-${side}-row-shape`)
  }

  let physicalLine = null
  const cells = []
  for (let cellIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
    const cell = row.child(cellIndex)
    if (!isSimpleGridCell(cell, rowIndex === 0)) {
      return rejected(`table-column-insert-${side}-cell-shape`)
    }
    const paragraph = cell.child(0)
    if (!isSimpleNonEmptyParagraph(paragraph)) {
      return rejected(`table-column-insert-${side}-cell-text`)
    }
    const paragraphPath = [...rowPath, cellIndex, 0]
    const paragraphEntry = sourceSyncNodeEntryAtPath(doc, paragraphPath)
    if (!paragraphEntry) return rejected(`table-column-insert-${side}-paragraph-missing`)

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
      return rejected(`table-column-insert-${side}-position-mapper-threw`)
    }
    if (
      !Number.isFinite(rawStart) ||
      !Number.isFinite(rawEnd) ||
      rawStart < 0 ||
      rawStart > rawEnd ||
      rawEnd > markdown.length
    ) return rejected(`table-column-insert-${side}-position-unmapped`)

    const cellLine = physicalLineAt(markdown, rawStart)
    if (!physicalLine) physicalLine = cellLine
    if (
      cellLine.start !== physicalLine.start ||
      rawStart < physicalLine.start ||
      rawEnd > physicalLine.textEnd
    ) return rejected(`table-column-insert-${side}-cross-line-cell`)

    const value = paragraph.textContent || ''
    if (markdown.slice(rawStart, rawEnd) !== value) {
      return rejected(`table-column-insert-${side}-cell-text-mismatch`, {
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
    return rejected(`table-column-insert-${side}-table-line-missing`)
  }
  const parsed = parsePipeLine(physicalLine.rawLine, columns)
  if (!parsed) return rejected(`table-column-insert-${side}-pipe-shape`)
  for (const cell of cells) {
    const segment = parsed.cells[cell.cellIndex]
    const relativeStart = cell.rawStart - physicalLine.start
    const relativeEnd = cell.rawEnd - physicalLine.start
    if (
      relativeStart < segment.start ||
      relativeEnd > segment.end ||
      segment.raw.trim() !== cell.value
    ) return rejected(`table-column-insert-${side}-cell-segment-mismatch`)
  }

  const templateCellIndex = insertedColumnIndex > 0
    ? insertedColumnIndex - 1
    : 0
  const line = Object.freeze({
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
    templateCellIndex
  })
  const cellRaw = blankCellRaw({ line, templateCellIndex })
  if (cellRaw == null) return rejected(`table-column-insert-${side}-blank-cell-template`)
  const insertion = insertPipeCell({
    rawLine: physicalLine.rawLine,
    parsed,
    insertedColumnIndex,
    cellRaw
  })
  if (!insertion || insertion.resultParsed.cells[insertedColumnIndex].raw.trim() !== '') {
    return rejected(`table-column-insert-${side}-line-insert-invalid`)
  }
  for (let nextIndex = 0; nextIndex < insertion.resultParsed.columnCount; nextIndex += 1) {
    if (nextIndex === insertedColumnIndex) continue
    const previousIndex = nextIndex < insertedColumnIndex ? nextIndex : nextIndex - 1
    if (insertion.resultParsed.cells[nextIndex].raw.trim() !== cells[previousIndex].value) {
      return rejected(`table-column-insert-${side}-remaining-cell-mismatch`)
    }
  }

  return Object.freeze({
    ...line,
    blankCellRaw: cellRaw,
    insertion: Object.freeze({
      ...insertion,
      rawOffset: physicalLine.start + insertion.relativeOffset
    })
  })
}

const delimiterCellRaw = ({ segmentRaw, alignment }) => {
  const raw = String(segmentRaw || '')
  const marker = raw.trim()
  if (!/^:?-{1,}:?$/.test(marker)) return null
  const leading = raw.match(/^[ \t]*/)?.[0] || ''
  const trailing = raw.match(/[ \t]*$/)?.[0] || ''
  const dashCount = Math.max(3, (marker.match(/-/g) || []).length)
  const dashes = '-'.repeat(dashCount)
  const aligned = alignment === 'left'
    ? `:${dashes}`
    : alignment === 'center'
      ? `:${dashes}:`
      : alignment === 'right'
        ? `${dashes}:`
        : dashes
  return `${leading}${aligned}${trailing}`
}

const resolveDelimiterLine = ({
  markdown,
  headerLine,
  columns,
  insertedColumnIndex,
  insertedAlignment,
  side
}) => {
  const physicalLine = physicalLineAt(markdown, headerLine.end)
  if (physicalLine.start !== headerLine.end) {
    return rejected(`table-column-insert-${side}-delimiter-position`)
  }
  const parsed = parsePipeLine(physicalLine.rawLine, columns)
  if (!parsed) return rejected(`table-column-insert-${side}-delimiter-shape`)
  if (!parsed.cells.every((cell) => /^:?-{1,}:?$/.test(cell.raw.trim()))) {
    return rejected(`table-column-insert-${side}-delimiter-syntax`)
  }
  const templateCellIndex = insertedColumnIndex > 0
    ? insertedColumnIndex - 1
    : 0
  const cellRaw = delimiterCellRaw({
    segmentRaw: parsed.cells[templateCellIndex]?.raw,
    alignment: insertedAlignment
  })
  if (cellRaw == null) return rejected(`table-column-insert-${side}-delimiter-template`)
  const insertion = insertPipeCell({
    rawLine: physicalLine.rawLine,
    parsed,
    insertedColumnIndex,
    cellRaw
  })
  if (
    !insertion ||
    !insertion.resultParsed.cells.every((cell) => /^:?-{1,}:?$/.test(cell.raw.trim()))
  ) return rejected(`table-column-insert-${side}-delimiter-insert-invalid`)

  return Object.freeze({
    ok: true,
    side,
    start: physicalLine.start,
    textEnd: physicalLine.textEnd,
    end: physicalLine.end,
    eol: physicalLine.eol,
    rawLine: physicalLine.rawLine,
    parsed,
    templateCellIndex,
    insertedCellRaw: cellRaw,
    insertion: Object.freeze({
      ...insertion,
      rawOffset: physicalLine.start + insertion.relativeOffset
    })
  })
}

const resolveTableSourceLayout = ({
  markdown,
  doc,
  tableIndex,
  columns,
  insertedColumnIndex,
  insertedAlignment,
  resolveMarkdownOffset,
  side
}) => {
  const table = sourceSyncNodeEntryAtPath(doc, [tableIndex])?.node
  if (!isSimpleSourceGrid(table, columns)) {
    return rejected(`table-column-insert-${side}-grid-topology`)
  }

  const rows = []
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const rowLine = resolveRowSourceLine({
      markdown,
      doc,
      tableIndex,
      rowIndex,
      columns,
      insertedColumnIndex,
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
    insertedColumnIndex,
    insertedAlignment,
    side
  })
  if (!delimiter.ok) return delimiter
  if (rows[1]?.start !== delimiter.end) {
    return rejected(`table-column-insert-${side}-first-body-position`)
  }
  for (let rowIndex = 2; rowIndex < rows.length; rowIndex += 1) {
    if (rows[rowIndex].start !== rows[rowIndex - 1].end) {
      return rejected(`table-column-insert-${side}-body-row-position`)
    }
  }

  const insertions = [delimiter, ...rows].map((line) => Object.freeze({
    rowIndex: line.rowIndex ?? null,
    kind: line.rowIndex == null ? 'delimiter' : (line.rowIndex === 0 ? 'header' : 'body'),
    rawLine: line.rawLine,
    resultLine: line.insertion.resultLine,
    rawOffset: line.insertion.rawOffset,
    bytes: line.insertion.bytes,
    insertedCellRaw: line.insertedCellRaw ?? line.blankCellRaw
  }))
  const ascending = [...insertions].sort((left, right) => left.rawOffset - right.rawOffset)
  for (let index = 1; index < ascending.length; index += 1) {
    if (ascending[index - 1].rawOffset === ascending[index].rawOffset) {
      return rejected(`table-column-insert-${side}-overlapping-insertions`)
    }
  }

  return Object.freeze({
    ok: true,
    side,
    tablePath: Object.freeze([tableIndex]),
    tableIndex,
    columns,
    insertedColumnIndex,
    insertedAlignment,
    rows: Object.freeze(rows),
    delimiter,
    insertions: Object.freeze(insertions)
  })
}

const applyRawInsertions = (markdown, insertions) => {
  let result = markdown
  for (const insertion of [...insertions].sort((left, right) => right.rawOffset - left.rawOffset)) {
    result = result.slice(0, insertion.rawOffset) +
      insertion.bytes +
      result.slice(insertion.rawOffset)
  }
  return result
}

const classifyTableColumnInsertJournal = ({ journal, expectedDoc }) => {
  const topLevel = classifySingleTopLevelSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'table',
    reasonPrefix: 'table-column-insert'
  })
  if (!topLevel.ok) return topLevel

  const previousTable = topLevel.previousEntry.node
  const nextTable = topLevel.nextEntry.node
  if (!sourceSyncAttrsEqual(previousTable.attrs, nextTable.attrs)) {
    return rejected('table-column-insert-table-attrs-changed')
  }
  if (previousTable.childCount !== nextTable.childCount) {
    return rejected('table-column-insert-row-count')
  }
  const previousColumns = simpleGridColumnCount(previousTable)
  const nextColumns = simpleGridColumnCount(nextTable)
  if (
    !previousColumns ||
    !nextColumns ||
    nextColumns !== previousColumns + 1
  ) return rejected('table-column-insert-grid-topology')
  if (!isSimpleSourceGrid(previousTable, previousColumns)) {
    return rejected('table-column-insert-source-grid-not-simple')
  }

  const candidates = columnInsertionCandidates(previousTable, nextTable)
  if (candidates.length !== 1) {
    return rejected('table-column-insert-owned-column-count', { proof: { candidates } })
  }
  const insertedColumnIndex = candidates[0]
  const insertedCells = []
  for (let rowIndex = 0; rowIndex < nextTable.childCount; rowIndex += 1) {
    const insertedCell = nextTable.child(rowIndex).child(insertedColumnIndex)
    if (!isEmptyInsertedCell(insertedCell, rowIndex === 0)) {
      return rejected('table-column-insert-inserted-column-not-empty')
    }
    insertedCells.push(insertedCell)
  }
  const insertedAttrs = insertedCells[0]?.attrs || {}
  if (!insertedCells.every((cell) => sourceSyncAttrsEqual(cell.attrs, insertedAttrs))) {
    return rejected('table-column-insert-inserted-cell-attrs-differ')
  }
  const resolvedAlignment = resolveCellAlignment(insertedAttrs)
  if (!resolvedAlignment.ok) {
    return rejected('table-column-insert-alignment-unsupported')
  }
  const insertedAlignment = resolvedAlignment.value

  if (journal?.entries?.length !== 1) {
    return rejected('table-column-insert-transaction-count')
  }
  const entry = journal.entries[0]
  if (entry.steps?.length !== previousTable.childCount) {
    return rejected('table-column-insert-step-count')
  }
  if (!sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc)) {
    return rejected('table-column-insert-entry-document-mismatch')
  }

  let currentDoc = journal.oldDoc
  const stepRanges = []
  for (let rowIndex = 0; rowIndex < entry.steps.length; rowIndex += 1) {
    const step = entry.steps[rowIndex]
    if (step?.constructor?.name !== 'ReplaceStep') {
      return rejected('table-column-insert-step-not-replace')
    }
    if (
      !Number.isFinite(step.from) ||
      !Number.isFinite(step.to) ||
      step.from !== step.to ||
      step.structure === true
    ) return rejected('table-column-insert-step-range-invalid')
    if (
      !step.slice ||
      step.slice.openStart !== 0 ||
      step.slice.openEnd !== 0 ||
      step.slice.content?.childCount !== 1
    ) return rejected('table-column-insert-step-slice-shape')

    const stepDoc = entry.stepDocs?.[rowIndex] || (rowIndex === 0 ? entry.beforeDoc : null)
    if (!stepDoc || !sameSourceSyncDocument(stepDoc, currentDoc)) {
      return rejected('table-column-insert-step-document-mismatch')
    }
    const stepTable = sourceSyncNodeEntryAtPath(stepDoc, [topLevel.topLevelIndex])?.node
    if (!stagedTableMatches({
      table: stepTable,
      previousTable,
      nextTable,
      processedRows: rowIndex
    })) return rejected('table-column-insert-step-staged-table-mismatch')

    const expectedCell = nextTable.child(rowIndex).child(insertedColumnIndex)
    const sliceCell = step.slice.content.firstChild
    if (sliceCell?.eq?.(expectedCell) !== true) {
      return rejected('table-column-insert-step-slice-cell-mismatch')
    }
    const boundary = insertionBoundaryAt(
      stepDoc,
      topLevel.topLevelIndex,
      rowIndex,
      insertedColumnIndex
    )
    if (boundary == null || step.from !== boundary) {
      return rejected('table-column-insert-step-outside-owned-boundary', {
        proof: { rowIndex, insertedColumnIndex, from: step.from, expectedFrom: boundary }
      })
    }

    let applied
    try {
      applied = step.apply(stepDoc)
    } catch {
      return rejected('table-column-insert-step-apply-failed')
    }
    if (applied?.failed || !applied?.doc) {
      return rejected('table-column-insert-step-apply-failed')
    }
    const appliedTable = sourceSyncNodeEntryAtPath(applied.doc, [topLevel.topLevelIndex])?.node
    if (!stagedTableMatches({
      table: appliedTable,
      previousTable,
      nextTable,
      processedRows: rowIndex + 1
    })) return rejected('table-column-insert-step-result-mismatch')

    stepRanges.push(Object.freeze({
      rowIndex,
      insertedCellPath: Object.freeze([
        topLevel.topLevelIndex,
        rowIndex,
        insertedColumnIndex
      ]),
      from: step.from,
      to: step.to,
      sliceSize: step.slice.size,
      sliceType: sliceCell.type?.name || null,
      attrs: sliceCell.attrs,
      structure: false
    }))
    currentDoc = applied.doc
  }

  if (
    !sameSourceSyncDocument(currentDoc, entry.afterDoc) ||
    !sameSourceSyncDocument(entry.afterDoc, expectedDoc) ||
    !sameSourceSyncDocument(journal.expectedDoc, expectedDoc)
  ) return rejected('table-column-insert-transaction-result-mismatch')

  return Object.freeze({
    ...topLevel,
    previousTable,
    nextTable,
    tablePath: Object.freeze([topLevel.topLevelIndex]),
    insertedColumnIndex,
    insertedAlignment,
    previousColumnCount: previousColumns,
    nextColumnCount: nextColumns,
    rowCount: previousTable.childCount,
    insertedCellPaths: Object.freeze(stepRanges.map((entry) => entry.insertedCellPath)),
    stepRanges: Object.freeze(stepRanges)
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'table-column-inserted',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: TABLE_COLUMN_INSERT_TRANSACTION_FAMILY,
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

export function createTableColumnInsertTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('table column insert owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('table column insert owner requires validateMarkdown')
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
    boundary = TABLE_COLUMN_INSERT_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('table-column-insert-journal-stale', { reset: true })
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
    ) return rejected('table-column-insert-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('table-column-insert-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('table-column-insert-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyTableColumnInsertJournal({ journal, expectedDoc })
    if (!classification.ok) return classification

    const sourceLayout = resolveTableSourceLayout({
      markdown: journal.source,
      doc: journal.oldDoc,
      tableIndex: classification.topLevelIndex,
      columns: classification.previousColumnCount,
      insertedColumnIndex: classification.insertedColumnIndex,
      insertedAlignment: classification.insertedAlignment,
      resolveMarkdownOffset,
      side: 'source'
    })
    if (!sourceLayout.ok) return sourceLayout
    const previousCanonicalLayout = resolveTableSourceLayout({
      markdown: journal.canonical,
      doc: journal.oldDoc,
      tableIndex: classification.topLevelIndex,
      columns: classification.previousColumnCount,
      insertedColumnIndex: classification.insertedColumnIndex,
      insertedAlignment: classification.insertedAlignment,
      resolveMarkdownOffset,
      side: 'previous-canonical'
    })
    if (!previousCanonicalLayout.ok) return previousCanonicalLayout

    const markdown = applyRawInsertions(journal.source, sourceLayout.insertions)
    let equivalent = false
    try {
      equivalent = validateMarkdown({ markdown, expectedDoc }) === true
    } catch {
      return rejected('table-column-insert-semantic-validator-threw')
    }
    if (!equivalent) return rejected('table-column-insert-semantic-document-mismatch')

    const proof = Object.freeze({
      kind: 'transaction-table-column-insert-proof',
      journalId: journal.journalId,
      family: TABLE_COLUMN_INSERT_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      tablePath: classification.tablePath,
      insertedColumnIndex: classification.insertedColumnIndex,
      insertedAlignment: classification.insertedAlignment,
      previousColumnCount: classification.previousColumnCount,
      nextColumnCount: classification.nextColumnCount,
      rowCount: classification.rowCount,
      insertedCellPaths: classification.insertedCellPaths,
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
    family: TABLE_COLUMN_INSERT_TRANSACTION_FAMILY,
    boundary: TABLE_COLUMN_INSERT_TRANSACTION_BOUNDARY,
    plan
  })
}
