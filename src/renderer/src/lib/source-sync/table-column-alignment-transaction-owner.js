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

export const TABLE_COLUMN_ALIGNMENT_TRANSACTION_FAMILY = 'table-column-alignment'
export const TABLE_COLUMN_ALIGNMENT_TRANSACTION_BOUNDARY = 'transaction-table-column-alignment'

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

const stableAttrsWithoutAlignment = (attrs = {}) => Object.fromEntries(
  Object.entries(attrs)
    .filter(([key, value]) =>
      key !== 'align' &&
      key !== 'alignment' &&
      value != null
    )
    .sort(([left], [right]) => left.localeCompare(right))
)

const attrsWithoutAlignmentEqual = (left, right) =>
  JSON.stringify(stableAttrsWithoutAlignment(left)) ===
  JSON.stringify(stableAttrsWithoutAlignment(right))

const resolveCellAlignment = (attrs = {}) => {
  const values = [attrs.alignment, attrs.align]
    .filter((value) => value != null && value !== '')
  if (new Set(values).size > 1) {
    return Object.freeze({ ok: false, value: null })
  }
  const value = values[0] ?? 'left'
  return Object.freeze({
    ok: ['left', 'center', 'right'].includes(value),
    value
  })
}

const rowTypeMatches = (row, rowIndex) => {
  const name = row?.type?.name || ''
  return rowIndex === 0
    ? name === 'table_header_row' || name === 'table_row'
    : name === 'table_row'
}

const isSimpleCellParagraph = (node) => {
  if (node?.type?.name !== 'paragraph' || !node.isTextblock) return false
  if (node.content?.size === 0) return true
  let valid = true
  node.forEach?.((child) => {
    const type = child?.type?.name || ''
    const plainText = child?.isText && (child.marks?.length || 0) === 0
    const emptyPlaceholder = type === 'hardbreak' || type === 'hard_break'
    if (!plainText && !emptyPlaceholder) valid = false
  })
  return valid
}

const isSimpleGridCell = (cell, header) => Boolean(
  cell &&
  cell.type?.name === (header ? 'table_header' : 'table_cell') &&
  (cell.attrs?.colspan ?? 1) === 1 &&
  (cell.attrs?.rowspan ?? 1) === 1 &&
  cell.attrs?.colwidth == null &&
  cell.childCount === 1 &&
  isSimpleCellParagraph(cell.child(0))
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

const columnAlignmentCandidates = (previousTable, nextTable) => {
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
    const previousAlignments = []
    const nextAlignments = []
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
        const previousAlignment = resolveCellAlignment(previousCell.attrs)
        const nextAlignment = resolveCellAlignment(nextCell.attrs)
        if (
          previousCell.type?.name !== nextCell.type?.name ||
          previousCell.content?.eq?.(nextCell.content) !== true ||
          !attrsWithoutAlignmentEqual(previousCell.attrs, nextCell.attrs) ||
          !previousAlignment.ok ||
          !nextAlignment.ok ||
          previousAlignment.value === nextAlignment.value
        ) {
          valid = false
          break
        }
        previousAlignments.push(previousAlignment.value)
        nextAlignments.push(nextAlignment.value)
      }
    }
    if (
      valid &&
      new Set(previousAlignments).size === 1 &&
      new Set(nextAlignments).size === 1
    ) {
      candidates.push(Object.freeze({
        columnIndex,
        previousAlignment: previousAlignments[0],
        nextAlignment: nextAlignments[0]
      }))
    }
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
    cells.push(Object.freeze({
      index: cellIndex,
      start,
      end,
      raw: line.slice(start, end)
    }))
  }
  return Object.freeze({
    rawLine: line,
    columnCount,
    cells: Object.freeze(cells)
  })
}

const parseDelimiterCell = (raw) => {
  const match = String(raw || '').match(/^([ \t]*)(:?)(-{3,})(:?)([ \t]*)$/)
  if (!match) return null
  const leftColon = match[2] === ':'
  const rightColon = match[4] === ':'
  const alignment = leftColon && rightColon
    ? 'center'
    : rightColon
      ? 'right'
      : 'left'
  return Object.freeze({
    leading: match[1],
    dashes: match[3],
    trailing: match[5],
    alignment
  })
}

const delimiterRawForAlignment = (parsed, alignment) => {
  const core = alignment === 'center'
    ? `:${parsed.dashes}:`
    : alignment === 'right'
      ? `${parsed.dashes}:`
      : `:${parsed.dashes}`
  return `${parsed.leading}${core}${parsed.trailing}`
}

const resolveTableDelimiterLayout = ({
  markdown,
  doc,
  tableIndex,
  table,
  columns,
  resolveMarkdownOffset,
  side
}) => {
  const headerOffsets = []
  for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
    const paragraphEntry = sourceSyncNodeEntryAtPath(doc, [tableIndex, 0, columnIndex, 0])
    if (!paragraphEntry || paragraphEntry.type !== 'paragraph') {
      return rejected(`table-column-alignment-${side}-header-path`)
    }
    let rawOffset
    try {
      rawOffset = resolveMarkdownOffset({
        markdown,
        pmPos: paragraphEntry.contentStart,
        doc,
        topLevelIndex: tableIndex,
        rowIndex: 0,
        cellIndex: columnIndex,
        nodePath: paragraphEntry.path
      })
    } catch {
      return rejected(`table-column-alignment-${side}-source-map-threw`)
    }
    if (!Number.isFinite(rawOffset)) {
      return rejected(`table-column-alignment-${side}-source-map-missing`)
    }
    headerOffsets.push(rawOffset)
  }

  const headerLines = headerOffsets.map((offset) => physicalLineAt(markdown, offset))
  const headerLine = headerLines[0]
  if (
    !headerLine ||
    !headerLine.eol ||
    !headerLines.every((line) =>
      line.start === headerLine.start && line.textEnd === headerLine.textEnd
    )
  ) return rejected(`table-column-alignment-${side}-header-line`)
  const parsedHeader = parsePipeLine(headerLine.rawLine, columns)
  if (!parsedHeader) return rejected(`table-column-alignment-${side}-header-pipes`)
  for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
    const localOffset = headerOffsets[columnIndex] - headerLine.start
    const cell = parsedHeader.cells[columnIndex]
    if (localOffset < cell.start || localOffset > cell.end) {
      return rejected(`table-column-alignment-${side}-header-occurrence`)
    }
  }

  const delimiterLine = physicalLineAt(markdown, headerLine.end)
  if (delimiterLine.start !== headerLine.end || delimiterLine.rawLine.length === 0) {
    return rejected(`table-column-alignment-${side}-delimiter-line`)
  }
  const parsedDelimiter = parsePipeLine(delimiterLine.rawLine, columns)
  if (!parsedDelimiter) return rejected(`table-column-alignment-${side}-delimiter-pipes`)
  const delimiters = []
  for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
    const parsed = parseDelimiterCell(parsedDelimiter.cells[columnIndex].raw)
    if (!parsed) return rejected(`table-column-alignment-${side}-delimiter-cell`)
    const cellAlignment = resolveCellAlignment(table.child(0).child(columnIndex).attrs)
    if (!cellAlignment.ok || parsed.alignment !== cellAlignment.value) {
      return rejected(`table-column-alignment-${side}-delimiter-alignment`)
    }
    delimiters.push(parsed)
  }

  return Object.freeze({
    ok: true,
    headerLine,
    delimiterLine,
    parsedHeader,
    parsedDelimiter,
    delimiters: Object.freeze(delimiters)
  })
}

const applyRawEdit = (source, edit) =>
  `${source.slice(0, edit.from)}${edit.text}${source.slice(edit.to)}`

const classifyAlignmentJournal = ({ journal, expectedDoc }) => {
  const topLevel = classifySingleTopLevelSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'table',
    reasonPrefix: 'table-column-alignment'
  })
  if (!topLevel.ok) return topLevel
  const previousTable = topLevel.previousEntry.node
  const nextTable = topLevel.nextEntry.node
  const candidates = columnAlignmentCandidates(previousTable, nextTable)
  if (candidates.length !== 1) {
    return rejected('table-column-alignment-column-count', {
      proof: {
        candidateCount: candidates.length,
        candidates
      }
    })
  }
  const candidate = candidates[0]
  const tablePath = Object.freeze([topLevel.topLevelIndex])
  if (!Array.isArray(journal.entries) || journal.entries.length !== 1) {
    return rejected('table-column-alignment-entry-count')
  }
  const entry = journal.entries[0]
  if (!sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc)) {
    return rejected('table-column-alignment-entry-baseline')
  }
  if (entry.steps?.length !== previousTable.childCount) {
    return rejected('table-column-alignment-step-count')
  }

  const stepRanges = []
  let entryDoc = entry.beforeDoc
  for (let rowIndex = 0; rowIndex < entry.steps.length; rowIndex += 1) {
    const step = entry.steps[rowIndex]
    const stepDoc = entry.stepDocs?.[rowIndex] || (rowIndex === 0 ? entry.beforeDoc : null)
    if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
      return rejected('table-column-alignment-step-document-missing')
    }
    const stagedTable = sourceSyncNodeEntryAtPath(stepDoc, tablePath)?.node
    if (!stagedTableMatches({
      table: stagedTable,
      previousTable,
      nextTable,
      processedRows: rowIndex
    })) return rejected('table-column-alignment-staged-table')
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
    ) return rejected('table-column-alignment-step-shape')

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
    ) return rejected('table-column-alignment-step-range')

    let applied
    try {
      applied = step.apply(stepDoc)
    } catch {
      return rejected('table-column-alignment-step-apply-failed')
    }
    if (applied?.failed || !applied?.doc) {
      return rejected('table-column-alignment-step-apply-failed')
    }
    if (!onlySourceSyncNodePathChanged(stepDoc, applied.doc, cellPath)) {
      return rejected('table-column-alignment-step-neighbour-changed')
    }
    const afterCell = sourceSyncNodeEntryAtPath(applied.doc, cellPath)?.node
    if (afterCell?.eq?.(expectedCell) !== true) {
      return rejected('table-column-alignment-step-result')
    }
    const afterTable = sourceSyncNodeEntryAtPath(applied.doc, tablePath)?.node
    if (!stagedTableMatches({
      table: afterTable,
      previousTable,
      nextTable,
      processedRows: rowIndex + 1
    })) return rejected('table-column-alignment-staged-result')

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
    return rejected('table-column-alignment-entry-result')
  }
  if (!sameSourceSyncDocument(entryDoc, expectedDoc)) {
    return rejected('table-column-alignment-final-document')
  }

  return Object.freeze({
    ...topLevel,
    tablePath,
    previousTable,
    nextTable,
    columnIndex: candidate.columnIndex,
    previousAlignment: candidate.previousAlignment,
    nextAlignment: candidate.nextAlignment,
    columns: previousTable.child(0).childCount,
    rowCount: previousTable.childCount,
    stepRanges: Object.freeze(stepRanges)
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'table-column-alignment-changed',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: TABLE_COLUMN_ALIGNMENT_TRANSACTION_FAMILY,
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

export function createTableColumnAlignmentTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('table column alignment owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('table column alignment owner requires validateMarkdown')
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
    boundary = TABLE_COLUMN_ALIGNMENT_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('table-column-alignment-journal-stale', { reset: true })
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
    ) return rejected('table-column-alignment-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('table-column-alignment-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('table-column-alignment-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyAlignmentJournal({ journal, expectedDoc })
    if (!classification.ok) return classification
    const sourceLayout = resolveTableDelimiterLayout({
      markdown: journal.source,
      doc: journal.oldDoc,
      tableIndex: classification.topLevelIndex,
      table: classification.previousTable,
      columns: classification.columns,
      resolveMarkdownOffset,
      side: 'source'
    })
    if (!sourceLayout.ok) return sourceLayout
    const previousCanonicalLayout = resolveTableDelimiterLayout({
      markdown: journal.canonical,
      doc: journal.oldDoc,
      tableIndex: classification.topLevelIndex,
      table: classification.previousTable,
      columns: classification.columns,
      resolveMarkdownOffset,
      side: 'previous-canonical'
    })
    if (!previousCanonicalLayout.ok) return previousCanonicalLayout

    const targetCell = sourceLayout.parsedDelimiter.cells[classification.columnIndex]
    const parsedTarget = sourceLayout.delimiters[classification.columnIndex]
    if (parsedTarget.alignment !== classification.previousAlignment) {
      return rejected('table-column-alignment-source-baseline')
    }
    const replacement = delimiterRawForAlignment(
      parsedTarget,
      classification.nextAlignment
    )
    const edit = Object.freeze({
      from: sourceLayout.delimiterLine.start + targetCell.start,
      to: sourceLayout.delimiterLine.start + targetCell.end,
      text: replacement,
      previousRaw: targetCell.raw,
      resultLine: `${sourceLayout.delimiterLine.rawLine.slice(0, targetCell.start)}${replacement}${sourceLayout.delimiterLine.rawLine.slice(targetCell.end)}`
    })
    const markdown = applyRawEdit(journal.source, edit)
    let equivalent = false
    try {
      equivalent = validateMarkdown({ markdown, expectedDoc }) === true
    } catch {
      return rejected('table-column-alignment-semantic-validator-threw')
    }
    if (!equivalent) {
      return rejected('table-column-alignment-semantic-document-mismatch')
    }

    const proof = Object.freeze({
      kind: 'transaction-table-column-alignment-proof',
      journalId: journal.journalId,
      family: TABLE_COLUMN_ALIGNMENT_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      tablePath: classification.tablePath,
      columnIndex: classification.columnIndex,
      previousAlignment: classification.previousAlignment,
      nextAlignment: classification.nextAlignment,
      columnCount: classification.columns,
      rowCount: classification.rowCount,
      stepRanges: classification.stepRanges,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(markdown),
      sourceLayout: Object.freeze({
        header: Object.freeze({
          rawLine: sourceLayout.headerLine.rawLine,
          eol: sourceLayout.headerLine.eol
        }),
        delimiter: Object.freeze({
          rawLine: sourceLayout.delimiterLine.rawLine,
          eol: sourceLayout.delimiterLine.eol,
          resultLine: edit.resultLine
        }),
        edit
      }),
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({
      boundary,
      markdown,
      canonical,
      expectedDoc,
      proof
    })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: TABLE_COLUMN_ALIGNMENT_TRANSACTION_FAMILY,
    boundary: TABLE_COLUMN_ALIGNMENT_TRANSACTION_BOUNDARY,
    plan
  })
}
