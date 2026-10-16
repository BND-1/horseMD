// Empty table cells have an authored pipe-delimited slot. They must not use
// the generic empty-paragraph mapper, which correctly refuses unowned gaps.
// This helper runs only after the journal proves every step edits one plain
// cell and leaves all table/row/cell attributes and neighbours unchanged.
export function mapTableCellEmptyTransition({
  journal, classification, expectedDoc, resolveMarkdownOffset, validateMarkdown
}) {
  const fail = reason => ({ ok: false, reason, markdown: journal.source })
  const before = classification.previousParagraph.textContent
  const after = classification.nextParagraph.textContent
  // Escapes, marks, links, line breaks and new delimiters need their own proof.
  if (/[\r\n\\`*_~\[\]<>|]/u.test(after)) return fail('syntax-sensitive-insert')
  let hint
  try {
    hint = resolveMarkdownOffset({
      markdown: journal.source,
      doc: journal.oldDoc,
      pmPos: classification.previousEntry.offset + 2,
      nodePath: classification.cellPath,
      rowIndex: classification.rowIndex,
      cellIndex: classification.cellIndex
    })
  } catch {
    return fail('table-cell-empty-slot-resolution-threw')
  }
  const source = journal.source
  if (!Number.isInteger(hint) || hint < 0 || hint > source.length) {
    return fail('table-cell-empty-slot-unresolved')
  }
  const lineStart = source.lastIndexOf('\n', Math.max(0, hint - 1)) + 1
  let lineEnd = source.indexOf('\n', hint)
  if (lineEnd < 0) lineEnd = source.length
  if (source[lineEnd - 1] === '\r') lineEnd -= 1
  const line = source.slice(lineStart, lineEnd)
  const pipes = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '|') continue
    let slashes = 0
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++
    if (slashes % 2 === 0) pipes.push(i)
  }
  if (!pipes.length) return fail('table-cell-empty-slot-not-pipe-row')
  const segments = []
  let start = 0
  for (const end of [...pipes, line.length]) {
    segments.push({ start, end, raw: line.slice(start, end) })
    start = end + 1
  }
  if (!segments[0].raw.trim()) segments.shift()
  if (segments.length && !segments.at(-1).raw.trim()) segments.pop()
  // The classifier supplies the grid column count, not a visible-text match.
  if (segments.length !== classification.columnCount) return fail('table-cell-empty-slot-column-count')
  if (segments.every(segment => /^:?-+:?$/.test(segment.raw.trim()))) {
    return fail('table-cell-empty-slot-is-delimiter')
  }
  const slot = segments[classification.cellIndex]
  if (!slot || slot.raw.trim() !== before) return fail('table-cell-empty-slot-text-mismatch')
  // Preserve every authored whitespace byte. In an empty slot reserve its
  // last padding character on the right; no whitespace is created or removed.
  const leading = before ? slot.raw.length - slot.raw.trimStart().length : Math.max(0, slot.raw.length - 1)
  const from = lineStart + slot.start + leading
  const to = from + before.length
  const markdown = source.slice(0, from) + after + source.slice(to)
  try {
    if (validateMarkdown({ markdown, expectedDoc }) !== true) return fail('semantic-document-mismatch')
  } catch {
    return fail('semantic-validator-threw')
  }
  return {
    ok: true,
    markdown,
    reason: 'table-cell-empty-transition',
    sourceRange: Object.freeze({ start: from, end: to, rowIndex: classification.rowIndex, cellIndex: classification.cellIndex })
  }
}

// Splits one raw table row on unescaped pipes. Leading/trailing outer pipes
// produce empty edge segments, which are dropped.
const tableRowSegments = (line) => {
  const pipes = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '|') continue
    let slashes = 0
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++
    if (slashes % 2 === 0) pipes.push(i)
  }
  if (!pipes.length) return null
  const segments = []
  let start = 0
  for (const end of [...pipes, line.length]) {
    segments.push({ start, end, raw: line.slice(start, end) })
    start = end + 1
  }
  if (!segments[0].raw.trim()) segments.shift()
  if (segments.length && !segments.at(-1).raw.trim()) segments.pop()
  return segments
}

const escapeTableCellText = (text) => text.replace(/[\\`*_[\]<>|~=$]/g, (character) => `\\${character}`)

/**
 * Structural raw-slot mapping for a plain one-cell text edit (0.13.235).
 *
 * The shared PM→raw position mapper can land on the wrong bytes inside tables
 * (CJK cells, repeated values), which made the step mapper fail with
 * `raw-block-text-mismatch` and left the edit to the legacy canonical guess —
 * a broken-table candidate the validator had to block, so the edit stayed
 * unsaved (fuzz 2026-10-02, seeds 14/15: Save fell into the recovery prompt).
 *
 * Here the table is found by CONTENT: a pipe row whose cells equal the PM
 * header cells, followed by a delimiter row, followed by every PM body row
 * cell-for-cell. The mapper offset only disambiguates identical tables. Only
 * the target slot's text bytes change; padding, pipes, alignment row and all
 * other rows keep their authored bytes. The semantic validator has the final
 * word, on a BOM-less LF-normalized copy.
 */
export function mapTableCellBySlot({
  journal, classification, expectedDoc, resolveMarkdownOffset, validateMarkdown, tableNode
}) {
  const fail = reason => ({ ok: false, reason, markdown: journal.source })
  const source = journal.source
  if (!tableNode) return fail('table-cell-slot-table-missing')
  // Text nodes only: Milkdown's hardbreak declares a `leafText` of "\n" that
  // textContent/textBetween include, while the raw `<br>` spelling carries no
  // text.
  const textOnly = (node) => {
    let text = ''
    node.descendants((child) => {
      if (child.isText) text += child.text
    })
    return text
  }
  const rows = []
  tableNode.forEach((row) => {
    const cells = []
    row.forEach((cell) => cells.push(textOnly(cell)))
    rows.push(cells)
  })
  // Visible form of a raw cell: `<br>` spellings carry no text.
  const visibleRaw = (raw) => raw.replace(/<br\s*\/?>/gi, '').trim()
  if (!rows.length || rows[0].length !== classification.columnCount) return fail('table-cell-slot-grid-shape')

  const lines = []
  for (let index = 0; index <= source.length;) {
    let end = source.indexOf('\n', index)
    if (end < 0) end = source.length
    const contentEnd = source[end - 1] === '\r' ? end - 1 : end
    lines.push({ start: index, end: contentEnd, text: source.slice(index, contentEnd) })
    if (end >= source.length) break
    index = end + 1
  }
  const rowMatches = (lineIndex, cells) => {
    const segments = lines[lineIndex] ? tableRowSegments(lines[lineIndex].text) : null
    // A short authored row (fewer pipes than the widest row) is padded with
    // empty cells by the editor (prosemirror-tables); accept it when every
    // padded cell is still empty (fuzz seeds 34/35).
    if (!segments || !segments.length || segments.length > cells.length) return null
    for (let cell = 0; cell < cells.length; cell++) {
      if (cell >= segments.length) {
        if (cells[cell].trim()) return null
        continue
      }
      if (visibleRaw(segments[cell].raw) !== cells[cell].trim()) return null
    }
    return segments
  }
  const isDelimiterRow = (lineIndex) => {
    const segments = lines[lineIndex] ? tableRowSegments(lines[lineIndex].text) : null
    return Boolean(segments?.length && segments.length <= classification.columnCount &&
      segments.every((segment) => /^\s*:?-+:?\s*$/.test(segment.raw)))
  }
  const candidates = []
  for (let header = 0; header + 1 < lines.length; header++) {
    if (!rowMatches(header, rows[0]) || !isDelimiterRow(header + 1)) continue
    let all = true
    for (let row = 1; row < rows.length && all; row++) {
      if (!rowMatches(header + 1 + row, rows[row])) all = false
    }
    if (all) candidates.push(header)
  }
  if (!candidates.length) return fail('table-cell-slot-table-unmatched')
  let header = candidates[0]
  if (candidates.length > 1) {
    let hint = null
    try {
      hint = resolveMarkdownOffset({
        markdown: source,
        doc: journal.oldDoc,
        pmPos: classification.previousEntry.offset + 2,
        nodePath: classification.cellPath,
        rowIndex: classification.rowIndex,
        cellIndex: classification.cellIndex
      })
    } catch {
      hint = null
    }
    if (!Number.isInteger(hint)) return fail('table-cell-slot-table-ambiguous')
    const span = (h) => {
      const first = lines[h].start
      const last = lines[h + rows.length].end
      return hint < first ? first - hint : hint > last ? hint - last : 0
    }
    const ranked = [...candidates].sort((a, b) => span(a) - span(b))
    if (span(ranked[0]) === span(ranked[1])) return fail('table-cell-slot-table-ambiguous')
    header = ranked[0]
  }

  const lineIndex = classification.rowIndex === 0 ? header : header + 1 + classification.rowIndex
  const segments = rowMatches(lineIndex, rows[classification.rowIndex])
  const slot = segments?.[classification.cellIndex]
  const before = textOnly(classification.previousParagraph)
  if (!slot || visibleRaw(slot.raw) !== before.trim()) return fail('table-cell-slot-text-mismatch')
  // Spell the new cell content: text runs, with in-cell line breaks as `<br>`
  // (the same spelling the table-break serializer emits).
  const spell = (escapeText) => {
    let output = ''
    let ok = true
    classification.nextParagraph.forEach((child) => {
      if (child.isText) output += escapeText(child.text)
      else if (child.type?.name === 'hardbreak' || child.type?.name === 'hard_break') output += '<br>'
      else ok = false
    })
    return ok && !/[\r\n]/.test(output) ? output : null
  }
  // Keep authored padding: replace only the slot's trimmed content. An empty
  // slot reserves its last padding character on the right (as the empty
  // transition does).
  const trimmedStart = slot.raw.length - slot.raw.trimStart().length
  const content = slot.raw.trim()
  const leading = content ? trimmedStart : Math.max(0, slot.raw.length - 1)
  const from = lines[lineIndex].start + slot.start + leading
  const to = from + content.length
  // A raw `|` always splits the cell, so even the most literal spelling escapes
  // it; the second candidate escapes every inline-syntax character.
  const literal = spell((text) => text.replace(/(?<!\\)\|/g, '\\|'))
  const escaped = spell(escapeTableCellText)
  if (literal == null || escaped == null) return fail('table-cell-slot-unspellable')
  for (const spelling of [...new Set([literal, escaped])]) {
    const markdown = source.slice(0, from) + spelling + source.slice(to)
    const normalized = markdown.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
    let ok = false
    try {
      ok = validateMarkdown({ markdown: normalized, expectedDoc }) === true
    } catch {
      return fail('semantic-validator-threw')
    }
    if (ok) {
      return {
        ok: true,
        markdown,
        reason: 'table-cell-slot-text-change',
        sourceRange: Object.freeze({ start: from, end: to, rowIndex: classification.rowIndex, cellIndex: classification.cellIndex })
      }
    }
  }
  return fail('semantic-document-mismatch')
}

/**
 * Multi-cell variant (0.13.235): one journal edited several cells of ONE
 * table (type in a cell, Tab, edit the next cell before a publication point).
 * The single-cell owner needs exactly one changed cell, so this used to fall to
 * the legacy whole-table guess and broke the table (fuzz seed 40). Topology and
 * attrs are proven equal by the caller; here every changed cell's raw slot is
 * located structurally (same content-matching as mapTableCellBySlot) and
 * rewritten from the last to the first, so offsets stay valid. The semantic
 * validator checks the whole result once.
 */
export function mapTableCellsBySlot({
  source, oldTable, newTable, changedCells, expectedDoc, validateMarkdown, hint = null
}) {
  const fail = reason => ({ ok: false, reason, markdown: source })
  const textOnly = (node) => {
    let text = ''
    node.descendants((child) => { if (child.isText) text += child.text })
    return text
  }
  const rows = []
  oldTable.forEach((row) => {
    const cells = []
    row.forEach((cell) => cells.push(textOnly(cell)))
    rows.push(cells)
  })
  const columnCount = rows[0]?.length || 0
  const visibleRaw = (raw) => raw.replace(/<br\s*\/?>/gi, '').trim()
  const lines = []
  for (let index = 0; index <= source.length;) {
    let end = source.indexOf('\n', index)
    if (end < 0) end = source.length
    const contentEnd = source[end - 1] === '\r' ? end - 1 : end
    lines.push({ start: index, end: contentEnd, text: source.slice(index, contentEnd) })
    if (end >= source.length) break
    index = end + 1
  }
  const rowMatches = (lineIndex, cells) => {
    const segments = lines[lineIndex] ? tableRowSegments(lines[lineIndex].text) : null
    // A short authored row (fewer pipes than the widest row) is padded with
    // empty cells by the editor (prosemirror-tables); accept it when every
    // padded cell is still empty (fuzz seeds 34/35).
    if (!segments || !segments.length || segments.length > cells.length) return null
    for (let cell = 0; cell < cells.length; cell++) {
      if (cell >= segments.length) {
        if (cells[cell].trim()) return null
        continue
      }
      if (visibleRaw(segments[cell].raw) !== cells[cell].trim()) return null
    }
    return segments
  }
  const isDelimiterRow = (lineIndex) => {
    const segments = lines[lineIndex] ? tableRowSegments(lines[lineIndex].text) : null
    return Boolean(segments?.length && segments.length <= columnCount &&
      segments.every((segment) => /^\s*:?-+:?\s*$/.test(segment.raw)))
  }
  const candidates = []
  for (let header = 0; header + 1 < lines.length; header++) {
    if (!rowMatches(header, rows[0]) || !isDelimiterRow(header + 1)) continue
    let all = true
    for (let row = 1; row < rows.length && all; row++) {
      if (!rowMatches(header + 1 + row, rows[row])) all = false
    }
    if (all) candidates.push(header)
  }
  if (!candidates.length) return fail('table-cells-slot-table-unmatched')
  let header = candidates[0]
  if (candidates.length > 1) {
    if (!Number.isInteger(hint)) return fail('table-cells-slot-table-ambiguous')
    const span = (h) => {
      const first = lines[h].start
      const last = lines[h + rows.length].end
      return hint < first ? first - hint : hint > last ? hint - last : 0
    }
    const ranked = [...candidates].sort((a, b) => span(a) - span(b))
    if (span(ranked[0]) === span(ranked[1])) return fail('table-cells-slot-table-ambiguous')
    header = ranked[0]
  }

  const spellCell = (paragraph, escapeText) => {
    let output = ''
    let ok = true
    paragraph.forEach((child) => {
      if (child.isText) output += escapeText(child.text)
      else if (child.type?.name === 'hardbreak' || child.type?.name === 'hard_break') output += '<br>'
      else ok = false
    })
    return ok && !/[\r\n]/.test(output) ? output : null
  }
  const literalEscape = (text) => text.replace(/(?<!\\)\|/g, '\\|')
  const edits = []
  for (const { rowIndex, cellIndex } of changedCells) {
    const lineIndex = rowIndex === 0 ? header : header + 1 + rowIndex
    const segments = rowMatches(lineIndex, rows[rowIndex])
    const slot = segments?.[cellIndex]
    if (!slot) return fail('table-cells-slot-missing')
    const newParagraph = newTable.child(rowIndex).child(cellIndex).child(0)
    const trimmedStart = slot.raw.length - slot.raw.trimStart().length
    const content = slot.raw.trim()
    const leading = content ? trimmedStart : Math.max(0, slot.raw.length - 1)
    const from = lines[lineIndex].start + slot.start + leading
    edits.push({ from, to: from + content.length, newParagraph })
  }
  edits.sort((a, b) => b.from - a.from)
  for (const escapeText of [literalEscape, escapeTableCellText]) {
    let markdown = source
    let spellable = true
    for (const edit of edits) {
      const spelling = spellCell(edit.newParagraph, escapeText)
      if (spelling == null) { spellable = false; break }
      markdown = markdown.slice(0, edit.from) + spelling + markdown.slice(edit.to)
    }
    if (!spellable) return fail('table-cells-slot-unspellable')
    const normalized = markdown.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
    let ok = false
    try {
      ok = validateMarkdown({ markdown: normalized, expectedDoc }) === true
    } catch {
      return fail('semantic-validator-threw')
    }
    if (ok) return { ok: true, markdown, reason: 'table-cells-slot-text-change', cellCount: edits.length }
  }
  return fail('semantic-document-mismatch')
}
