import {
  sourceRawFromVisibleIndex,
  sourceVisibleIndex,
  sourceVisiblePositionAtRaw
} from '../../mode-visible-map.js'
import {
  adaptCanonicalRegionToSource,
  commonChange,
  isTableLine,
  lineAt,
  markdownLines
} from './core.js'

const isTableSeparatorLine = (line) => {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|')
  // Milkdown may serialize a table alignment separator with a single dash
  // (`:-:`), even though authored GFM commonly uses three or more. Both forms
  // identify the separator row for source-preservation purposes.
  return cells.length > 1 && cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()))
}

const tableBlockAt = (markdown, offset) => {
  let current = lineAt(markdown, offset)
  let line = markdown.slice(current.start, current.end)
  if (!isTableLine(line) && current.start > 0) {
    current = lineAt(markdown, current.start - 1)
    line = markdown.slice(current.start, current.end)
  }
  if (!isTableLine(line)) return null

  let start = current.start
  let end = current.end
  while (start > 0) {
    const previous = lineAt(markdown, start - 1)
    if (!isTableLine(markdown.slice(previous.start, previous.end))) break
    start = previous.start
  }
  while (end < markdown.length) {
    const next = lineAt(markdown, end + 1)
    if (!isTableLine(markdown.slice(next.start, next.end))) break
    end = next.end
  }
  const table = { start, end: end < markdown.length ? end + 1 : end }
  const lines = markdown.slice(table.start, table.end).trimEnd().split('\n')
  return lines.some(isTableSeparatorLine) ? table : null
}

const tableBlocksIn = (markdown) => {
  const blocks = new Map()
  for (const line of markdownLines(markdown)) {
    if (!isTableLine(line.text)) continue
    const table = tableBlockAt(markdown, line.start)
    if (table) blocks.set(`${table.start}:${table.end}`, table)
  }
  return [...blocks.values()].sort((left, right) => left.start - right.start)
}

const tableVisibleText = (markdown, table) => table
  ? sourceVisibleIndex(markdown.slice(table.start, table.end)).text
  : ''

const tableShape = (markdown, table) => {
  if (!table) return ''
  return markdown
    .slice(table.start, table.end)
    .trimEnd()
    .split('\n')
    .map((line) => {
      if (isTableSeparatorLine(line)) {
        return line
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => {
            const value = cell.trim()
            return `${value.startsWith(':') ? 'l' : ''}${value.endsWith(':') ? 'r' : ''}`
          })
          .join('|')
      }
      return line.split('|').length
    })
    .join('\n')
}

export const hasTableStructureChange = ({ previous, next, start, previousEnd, nextEnd }) => {
  const previousTable = tableBlockAt(previous, start) || tableBlockAt(previous, previousEnd)
  const nextTable = tableBlockAt(next, start) || tableBlockAt(next, nextEnd)
  if (!previousTable && !nextTable) return false
  if (!previousTable || !nextTable) return true
  return tableShape(previous, previousTable) !== tableShape(next, nextTable)
}

export const replaceChangedTableBlock = ({ source, previous, next, start, previousEnd, nextEnd }) => {
  const previousTable = tableBlockAt(previous, start) || tableBlockAt(previous, previousEnd)
  const nextTable = tableBlockAt(next, start) || tableBlockAt(next, nextEnd)
  if (!previousTable || !nextTable) {
    return null
  }

  const tableStart = sourceVisiblePositionAtRaw(previous, previousTable.start)
  const rawInsideSource = sourceRawFromVisibleIndex(source, tableStart.visibleIndex, 'forward')
  const sourceTable = tableBlockAt(source, rawInsideSource)
  const previousText = tableVisibleText(previous, previousTable)
  const sourceText = sourceTable ? tableVisibleText(source, sourceTable) : ''
  if (!sourceTable || sourceText !== previousText) {
    // The document may already be globally diverged because an earlier list
    // uses authored marker/spacing that Crepe canonicalizes. In that case the
    // visible-offset hint above can land on the wrong source table (or in a
    // non-table line). Re-anchor by the complete table-local visible text,
    // choosing the nearest match only when duplicate tables exist.
    const candidates = tableBlocksIn(source).filter((candidate) =>
      tableVisibleText(source, candidate) === previousText
    )
    const replacement = candidates.length === 1
      ? candidates[0]
      : candidates.reduce((best, candidate) => {
          const distance = Math.abs(candidate.start - rawInsideSource)
          return !best || distance < best.distance ? { candidate, distance } : best
        }, null)?.candidate
    if (!replacement) return null
    return {
      markdown: source.slice(0, replacement.start) +
        adaptCanonicalRegionToSource(
          normalizeEmptyTableCells(next.slice(nextTable.start, nextTable.end)),
          source,
          replacement
        ) +
        source.slice(replacement.end),
      preserved: true,
      reason: 'table-block-change-local-anchor'
    }
  }

  return {
    markdown: source.slice(0, sourceTable.start) +
      adaptCanonicalRegionToSource(
        normalizeEmptyTableCells(next.slice(nextTable.start, nextTable.end)),
        source,        sourceTable
      ) +
    source.slice(sourceTable.end),

    preserved: true,
    reason: 'table-block-change'
  }
}

export const preserveTableTextChange = ({ source, previous, next, start, previousEnd, nextEnd }) => {
  const previousTable = tableBlockAt(previous, start) || tableBlockAt(previous, previousEnd)
  const nextTable = tableBlockAt(next, start) || tableBlockAt(next, nextEnd)
  if (!previousTable || !nextTable) return null
  if (tableShape(previous, previousTable) !== tableShape(next, nextTable)) return null

  const tableStart = sourceVisiblePositionAtRaw(previous, previousTable.start)
  const rawInsideSource = sourceRawFromVisibleIndex(source, tableStart.visibleIndex, 'forward')
  const sourceTable = tableBlockAt(source, rawInsideSource)
  if (!sourceTable) return null

  const sourceTableText = source.slice(sourceTable.start, sourceTable.end)
  const previousTableText = previous.slice(previousTable.start, previousTable.end)
  const nextTableText = next.slice(nextTable.start, nextTable.end)
  const sourceTableVisible = sourceVisibleIndex(sourceTableText).text
  const previousTableVisible = sourceVisibleIndex(previousTableText).text
  const nextTableVisible = sourceVisibleIndex(nextTableText).text
  if (sourceTableVisible !== previousTableVisible || previousTableVisible === nextTableVisible) return null

  const visibleChange = commonChange(previousTableVisible, nextTableVisible)
  const sourceStart = sourceRawFromVisibleIndex(
    sourceTableText,
    visibleChange.start,
    visibleChange.start === visibleChange.previousEnd ? 'backward' : 'forward'
  )
  const sourceEnd = sourceRawFromVisibleIndex(sourceTableText, visibleChange.previousEnd, 'backward')
  const nextStart = sourceRawFromVisibleIndex(nextTableText, visibleChange.start, 'forward')
  const nextRawEnd = sourceRawFromVisibleIndex(nextTableText, visibleChange.nextEnd, 'backward')
  if (
    ![sourceStart, sourceEnd, nextStart, nextRawEnd].every(Number.isFinite) ||
    sourceStart > sourceEnd ||
    nextStart > nextRawEnd
  ) {
    return null
  }

  const replacement = nextTableText.slice(nextStart, nextRawEnd)
  const rawRegion = {
    start: sourceTable.start + sourceStart,
    end: sourceTable.start + sourceEnd
  }
  return {
    markdown: source.slice(0, rawRegion.start) +
      adaptCanonicalRegionToSource(replacement, source, rawRegion) +
      source.slice(rawRegion.end),
    preserved: true,
    reason: 'table-text-change'
  }
}

// Milkdown keeps a generated `<br />` in empty table cells so its Markdown
// serializer can retain the cell count. Normalize only cells whose sole content
// is that marker; a real `text<br>text` line break remains untouched.
export const normalizeEmptyTableCells = (markdown) => {
  const lines = String(markdown || '').split('\n')
  let index = 0
  while (index < lines.length) {
    if (!isTableLine(lines[index])) {
      index++
      continue
    }
    const start = index
    while (index < lines.length && isTableLine(lines[index])) index++
    const block = lines.slice(start, index)
    if (!block.some(isTableSeparatorLine)) continue
    for (let line = start; line < index; line++) {
      lines[line] = lines[line].replace(/(^|\|)(\s*)<br\s*\/?>\s*(?=\||$)/gi, '$1$2')
    }
  }
  return lines.join('\n')
}
