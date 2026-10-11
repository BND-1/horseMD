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
