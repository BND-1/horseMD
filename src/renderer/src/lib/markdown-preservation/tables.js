
import { isTableLine } from './core.js'

const isTableSeparatorLine = (line) => {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|')
  // Milkdown may serialize a table alignment separator with a single dash
  // (`:-:`), even though authored GFM commonly uses three or more. Both forms
  // identify the separator row for source-preservation purposes.
  return cells.length > 1 && cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()))
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
