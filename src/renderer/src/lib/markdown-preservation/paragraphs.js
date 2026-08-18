import {
  sourceRawFromVisibleIndex,
  sourceVisiblePositionAtRaw,
  sourceVisibleIndex
} from '../../mode-visible-map.js'
import {
  adaptCanonicalRegionToSource,
  canonicalFreshTextToSource,
  canonicalTextToSource,
  isTableLine,
  lineAt,
  lineEndingNear,
  listMarker,
  markdownLines
} from './core.js'
import {
  preserveChangedLineRegion,
  sameVisibleLines,
  visibleLineEntries
} from './regions.js'

const emptyCanonicalQuoteLine = /^\s*(?:>\s*)+(?:<br\s*\/?>\s*)?$/i
const emptyAuthoredQuoteLine = /^\s*(?:>\s*)+$/

// After the user clears a blockquote's text, Crepe keeps an empty blockquote
// (`> <br />`) and the authored source keeps a syntax-only `>` row. Pressing
// Backspace once more removes the blockquote node. Because `>` and `<br />`
// contribute no visible characters, the generic visible-stream mapper sees a
// zero-width structural change and cannot find the raw source row; it used to
// report success while leaving `>` behind, so save/reopen resurrected the
// quote. Map the complete zero-visible gap between the same neighbouring text
// anchors and replace it with the gap from the next canonical document.
export const preserveRemovedEmptyBlockquote = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousChanged = previous.slice(start, previousEnd)
  const nextChanged = next.slice(start, nextEnd)
  const previousRows = previousChanged.split(/\r\n|\n|\r/).filter((line) => line.trim())
  if (
    !previousRows.length ||
    !previousRows.every((line) => emptyCanonicalQuoteLine.test(line)) ||
    sourceVisibleIndex(previousChanged).text ||
    sourceVisibleIndex(nextChanged).text
  ) {
    return null
  }

  const previousVisible = sourceVisibleIndex(previous)
  const sourceVisible = sourceVisibleIndex(source)
  const nextVisible = sourceVisibleIndex(next)
  if (nextVisible.text !== previousVisible.text) return null

  const startVisible = sourceVisiblePositionAtRaw(previous, start).visibleIndex
  const endVisible = sourceVisiblePositionAtRaw(previous, previousEnd).visibleIndex
  if (startVisible !== endVisible) return null

  // The authored source may already diverge from canonical elsewhere (for
  // example a mid-line literal `*`). Do not repeat the old whole-document
  // equality mistake: uniquely anchor up to 24 visible characters on both
  // sides of this zero-width boundary and map only that local source gap.
  const contextBefore = previousVisible.text.slice(Math.max(0, startVisible - 24), startVisible)
  const contextAfter = previousVisible.text.slice(startVisible, startVisible + 24)
  const context = contextBefore + contextAfter
  if (!context) return null
  const contextAt = sourceVisible.text.indexOf(context)
  if (contextAt < 0 || sourceVisible.text.indexOf(context, contextAt + 1) >= 0) return null
  const sourceBoundary = contextAt + contextBefore.length

  const sourceStart = sourceRawFromVisibleIndex(source, sourceBoundary, 'backward')
  const sourceEnd = sourceRawFromVisibleIndex(source, sourceBoundary, 'forward')
  const previousStart = sourceRawFromVisibleIndex(previous, startVisible, 'backward')
  const previousEndRaw = sourceRawFromVisibleIndex(previous, endVisible, 'forward')
  const nextStart = sourceRawFromVisibleIndex(next, startVisible, 'backward')
  const nextEndRaw = sourceRawFromVisibleIndex(next, endVisible, 'forward')
  if (
    !Number.isFinite(sourceStart) ||
    !Number.isFinite(sourceEnd) ||
    !Number.isFinite(previousStart) ||
    !Number.isFinite(previousEndRaw) ||
    !Number.isFinite(nextStart) ||
    !Number.isFinite(nextEndRaw) ||
    sourceStart > sourceEnd ||
    previousStart > previousEndRaw ||
    nextStart > nextEndRaw
  ) {
    return null
  }

  const sourceGap = source.slice(sourceStart, sourceEnd)
  const sourceRows = sourceGap.split(/\r\n|\n|\r/).filter((line) => line.trim())
  const previousGap = previous.slice(previousStart, previousEndRaw)
  const previousGapRows = previousGap.split(/\r\n|\n|\r/).filter((line) => line.trim())
  const nextGap = next.slice(nextStart, nextEndRaw)
  const nextRows = nextGap.split(/\r\n|\n|\r/).filter((line) => line.trim())
  const sourceQuoteRows = sourceRows.filter((line) => emptyAuthoredQuoteLine.test(line))
  const previousQuoteRows = previousGapRows.filter((line) => emptyCanonicalQuoteLine.test(line))
  const nextQuoteRows = nextRows.filter((line) => emptyCanonicalQuoteLine.test(line))
  const otherRows = (rows, isQuote) => rows
    .filter((line) => !isQuote.test(line))
    .map((line) => line.trim())
  if (
    !sourceQuoteRows.length ||
    sourceQuoteRows.length !== previousQuoteRows.length ||
    nextQuoteRows.length >= previousQuoteRows.length ||
    JSON.stringify(otherRows(sourceRows, emptyAuthoredQuoteLine)) !==
      JSON.stringify(otherRows(previousGapRows, emptyCanonicalQuoteLine)) ||
    JSON.stringify(otherRows(nextRows, emptyCanonicalQuoteLine)) !==
      JSON.stringify(otherRows(previousGapRows, emptyCanonicalQuoteLine))
  ) {
    return null
  }

  return {
    markdown: source.slice(0, sourceStart) +
      adaptCanonicalRegionToSource(
        withoutStandaloneEmptyBlockLines(nextGap),
        source,
        { start: sourceStart, end: sourceEnd }
      ) +
      source.slice(sourceEnd),
    preserved: true,
    reason: 'empty-blockquote-removed'
  }
}

// A rich-text edit that removes every character of a paragraph replaces its
// text with Crepe's internal standalone `<br />` placeholder. That placeholder
// is not authored Markdown and must never enter the raw source: the emptied
// paragraph maps to deleting its authored lines while the surrounding
// blank-line separators (and every untouched byte) stay exactly as written.
export const preserveEmptiedParagraph = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const nextEmptyLines = standaloneEmptyBlockLines(next)
  if (!nextEmptyLines.length) return null
  const nextChangedText = withoutStandaloneEmptyBlockLines(next.slice(start, nextEnd)).trim()
  const previousChangedText = withoutStandaloneEmptyBlockLines(previous.slice(start, previousEnd)).trim()
  // Inside a blockquote the emptied paragraph strips down to its `>` markers;
  // that is an empty paragraph, not authored text.
  const isEmptyParagraphResidue = (value) => !/[^\s>]/.test(value)
  // The delta must be exactly "real text became empty paragraph(s)". Inserting
  // a fresh empty block, or editing text, belongs to the other handlers.
  if (!isEmptyParagraphResidue(nextChangedText) || isEmptyParagraphResidue(previousChangedText)) return null
  // The emptied paragraphs are the entire delta between otherwise identical
  // documents. The source may legitimately disagree with the canonical's
  // visible stream ELSEWHERE (for example a mid-line `* ` that remark parses
  // as a list item while the authored line keeps it as paragraph text). Only
  // the mapped region must align; preserveChangedLineRegion verifies that
  // locally and fails closed, so a whole-document equality check here would
  // veto valid empty-paragraph mappings and let <br /> leak.
  if (previous.slice(0, start) !== next.slice(0, start)) return null
  if (previous.slice(previousEnd) !== next.slice(nextEnd)) return null
  // At least one emptied paragraph's `<br />` line must sit inside the change
  // span (inside a blockquote the shared `> ` marker sits outside the literal
  // change, so the line only overlaps it). OTHER empty paragraphs elsewhere in
  // the document must not veto the mapping: they live in untouched source
  // bytes and cannot leak through this localized replacement.
  if (!nextEmptyLines.some((range) => range.end >= start && range.start <= nextEnd)) return null
  // Backspace can empty a list item and Enter can immediately lift that empty
  // item into a standalone ProseMirror paragraph. Canonical then replaces the
  // list row with a bare `<br />`; generic line replacement removes the token
  // but leaves one extra blank line. Delete the uniquely matching authored row
  // including its own EOL instead, preserving the existing separator before
  // the following block byte-for-byte.
  const previousLine = lineAt(previous, start)
  const previousLineText = previous.slice(previousLine.start, previousLine.end)
  const bareEmptyParagraph = nextEmptyLines.some((range) =>
    range.end >= start &&
    range.start <= nextEnd &&
    /^\s*<br\s*\/?>\s*$/i.test(next.slice(range.start, range.end))
  )
  if (bareEmptyParagraph && listMarker(previousLineText)) {
    const previousVisible = sourceVisibleIndex(previousLineText).text.trim()
    const sourceRows = markdownLines(source).filter((line) =>
      listMarker(line.text) && sourceVisibleIndex(line.text).text.trim() === previousVisible
    )
    if (previousVisible && sourceRows.length === 1) {
      const [row] = sourceRows
      const rowEnd = row.end < source.length && source[row.end] === '\n'
        ? row.end + 1
        : row.end
      const removedTrailingRow = rowEnd === source.length
      const kept = source.slice(0, row.start) + source.slice(rowEnd)
      const sourceTrailingBreakCount = (
        source.match(/(?:\r\n|\r|\n)*$/)?.[0]?.match(/\r\n|\r|\n/g) || []
      ).length
      const trailingNewlineGrowth = removedTrailingRow
        ? sourceTrailingBreakCount === 0 ? 2 : 1
        : 0
      return {
        // Enter twice exits the list into a real trailing paragraph. Keep one
        // raw blank-line slot for the next typed block; otherwise a later list
        // input rule has nowhere to attach and its marker is glued to the
        // previous list item. This is user-authored Enter state, not Crepe's
        // serializer padding.
        markdown: removedTrailingRow
          ? kept + lineEndingNear(source, row.start)
          : kept,
        preserved: true,
        reason: 'empty-list-item-removed',
        // A no-final-newline file needs two physical line endings after the
        // final empty row is removed: one terminates the surviving row and one
        // owns the blank block boundary. A source that already ended in EOL
        // needs only one additional break.
        trailingNewlineGrowth
      }
    }
  }
  return preserveChangedLineRegion({
    source,
    previous,
    next,
    start,
    previousEnd,
    nextEnd,
    reason: 'paragraph-emptied',
    transformReplacement: withoutStandaloneEmptyBlockLines
  })
}

const appendBlockAtDocumentEnd = (source, canonicalBlock) => {
  const eol = lineEndingNear(source, source.length)
  const sourceTrailingBreaks = source.match(/(?:(?:\r\n)|\n|\r)*$/)?.[0] || ''
  const sourceTrailingNewlines = sourceTrailingBreaks.match(/\r\n|\n|\r/g)?.length || 0
  const canonical = withoutStandaloneEmptyBlockLines(canonicalBlock)
    .replace(/^(?:(?:\r\n)|\n|\r)+/, '')
    .replace(/(?:(?:\r\n)|\n|\r)+$/, '')
  // Dedicated-syntax rows (list markers, tables, headings, quotes, fences)
  // must not be spell-checked by the fresh-punctuation restore (that would
  // unescape an authored `\*`), but canonical entity spelling (`&#x20;` for a
  // leading content space) still has to be translated back to authored text.
  // canonicalTextToSource without the fresh flag does exactly that.
  const block = hasDedicatedBlockSyntax(canonical)
    ? canonicalTextToSource(canonical)
    : canonicalFreshTextToSource(canonical)
  if (!block) return null
  const separator = eol.repeat(Math.max(0, 2 - sourceTrailingNewlines))
  const finalNewline = sourceTrailingNewlines > 0 ? eol : ''
  return source + separator +
    adaptCanonicalRegionToSource(block, source, { start: source.length, end: source.length }) +
    finalNewline
}

const trailingSingleLineBlock = (markdown) => {
  const value = String(markdown || '')
  const trailingBreaks = value.match(/(?:(?:\r\n)|\n|\r)*$/)?.[0] || ''
  const end = value.length - trailingBreaks.length
  if (end <= 0) return null
  const before = value.slice(0, end)
  const previousBreak = Math.max(
    before.lastIndexOf('\n'),
    before.lastIndexOf('\r')
  )
  const start = previousBreak + 1
  const prefixBreaks = value.slice(0, start).match(/(?:(?:\r\n)|\n|\r)+$/)?.[0] || ''
  const breakCount = prefixBreaks.match(/\r\n|\n|\r/g)?.length || 0
  if (start > 0 && breakCount < 2) return null
  const text = value.slice(start, end)
  if (!text.trim() || /\r|\n/.test(text)) return null
  return { start, end, text, trailingBreaks }
}

// A syntax-only trailing paragraph (for example the temporary escaped
// backtick before inline code gets its first character) has no stable visible
// offset. If that exact final line still exists in the authored source, replace
// the line directly and preserve every non-canonical byte before it.
export const preserveTrailingExactLineChange = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const sourceBlock = trailingSingleLineBlock(source)
  const previousBlock = trailingSingleLineBlock(previous)
  const nextBlock = trailingSingleLineBlock(next)
  if (!sourceBlock || !previousBlock || !nextBlock) return null
  if (
    start < previousBlock.start ||
    start < nextBlock.start ||
    previousEnd > previousBlock.end ||
    nextEnd > nextBlock.end ||
    sourceBlock.text !== previousBlock.text
  ) {
    return null
  }

  const replacement = adaptCanonicalRegionToSource(
    nextBlock.text,
    source,
    sourceBlock
  )
  return {
    markdown: source.slice(0, sourceBlock.start) +
      replacement +
      source.slice(sourceBlock.end),
    preserved: true,
    reason: 'trailing-exact-line-change'
  }
}

const trailingEmptyBlock = (markdown) => {
  const match = markdown.match(/(?:^|\n{2})(?:[ \t]*>[ \t]*)*<br\s*\/?>\n*$/i)
  if (!match) return null
  const prefixLength = match[0].startsWith('\n\n') ? 2 : 0
  return {
    start: match.index + prefixLength,
    end: markdown.length
  }
}

// While a user holds Space in a new rich paragraph, Crepe serializes a
// sequence of whitespace-only paragraphs before the first visible character
// arrives (`  `, `   `, `    `, then `&#x20; ...text`). Those intermediate
// snapshots are still empty from the authored-source perspective. Treat them
// like the normal `<br />` placeholder so they cannot enter generic structural
// line mapping and collapse the paragraph boundary onto the previous line.
const trailingCanonicalEmptyBlock = (markdown) => {
  const placeholder = trailingEmptyBlock(markdown)
  if (placeholder) return placeholder
  const match = String(markdown || '').match(
    /(?:^|\n{2})(?:[ \t]*>[ \t]*)*[ \t]+\n*$/
  )
  if (!match) return null
  const prefixLength = match[0].startsWith('\n\n') ? 2 : 0
  return {
    start: match.index + prefixLength,
    end: String(markdown || '').length
  }
}

// Crepe represents an empty paragraph as a standalone `<br />` line. Inside a
// blockquote that line is prefixed by the quote marker (`> <br />`); both
// spellings are editor placeholders, never authored content.
const standaloneEmptyBlockLines = (markdown) => markdownLines(markdown)
  .filter((line) => /^\s*(?:[ \t]*>[ \t]*)*<br\s*\/?>\s*$/i.test(line.text))

export const withoutStandaloneEmptyBlockLines = (markdown) => String(markdown || '')
  .replace(
    /^((?:[ \t]*>[ \t]*)*)[ \t]*<br\s*\/?>[ \t]*$/gim,
    (match, prefix) => prefix.replace(/[ \t]+$/, '')
  )

// The file's terminal line-ending run (0, 1, or more trailing newlines) is
// authored formatting. Crepe can append a serializer blank line after the last
// block (`item\n\n`); only the block bytes belong to the edit, so the output's
// trailing run must never GROW beyond the source's. The source's authored
// trailing blank lines may legitimately become mid-document separators when a
// paragraph is appended, so the output is clamped rather than force-equalized.
export const capOutputTrailingNewlines = (markdown, source, allowedGrowth = 0) => {
  const output = String(markdown || '')
  // A brand-new document generated from an empty source has no authored
  // terminal convention yet; its own serializer newline is the structure.
  if (!String(source || '').trim()) return output
  const outputTrail = output.match(/(?:\r\n|\r|\n)*$/)?.[0] || ''
  const sourceTrail = String(source || '').match(/(?:\r\n|\r|\n)*$/)?.[0] || ''
  const countBreaks = (run) => (run.match(/\r\n|\n|\r/g) || []).length
  const sourceCount = countBreaks(sourceTrail)
  const outputCount = countBreaks(outputTrail)
  const limit = sourceCount + Math.max(0, Number(allowedGrowth) || 0)
  if (outputCount <= limit) return output
  const eol = lineEndingNear(source, source.length)
  return output.slice(0, output.length - outputTrail.length) + sourceTrail + eol.repeat(limit - sourceCount)
}

const rangeTouches = (range, start, end) =>
  range.start <= Math.max(start, end) && range.end >= Math.min(start, end)

const hasDedicatedBlockSyntax = (markdown) => markdownLines(markdown).some(({ text }) => {
  const trimmed = text.trim()
  if (!trimmed) return false
  return !!listMarker(text) ||
    isTableLine(text) ||
    /^(?:#{1,6}\s|>|```|~~~|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(trimmed)
})

// A list created by typing into an already-proven empty paragraph owns that
// whole zero-width block slot. A deferred markdownUpdated may publish the list
// rows and the paragraph typed after exiting the list together, so the changed
// region can contain both list markers and ordinary continuation/prose rows.
// Keep headings, quotes, tables, fences, and thematic breaks on their dedicated
// mappers; accepting those here would bypass their source-specific contracts.
const isMiddleListSlotFill = (markdown) => {
  const lines = markdownLines(withoutStandaloneEmptyBlockLines(markdown))
  let hasList = false
  for (const { text } of lines) {
    const trimmed = text.trim()
    if (!trimmed) continue
    if (listMarker(text)) {
      hasList = true
      continue
    }
    if (
      isTableLine(text) ||
      /^(?:#{1,6}\s|>|```|~~~|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(trimmed)
    ) return false
  }
  return hasList
}

// Preserve an empty paragraph inserted between two existing blocks without
// leaking Crepe's transient standalone `<br />` into authored Markdown.
export const preserveMiddleEmptyBlock = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousEmpty = standaloneEmptyBlockLines(previous)
  const nextEmpty = standaloneEmptyBlockLines(next)
  const previousChangedEmpty = previousEmpty.some((range) =>
    rangeTouches(range, start, previousEnd)
  )
  const nextChangedEmpty = nextEmpty.some((range) =>
    rangeTouches(range, start, nextEnd)
  )
  const previousChangedText = withoutStandaloneEmptyBlockLines(
    previous.slice(start, previousEnd)
  ).trim()
  const nextChangedText = withoutStandaloneEmptyBlockLines(
    next.slice(start, nextEnd)
  ).trim()

  if (
    nextEmpty.length > previousEmpty.length &&
    nextChangedEmpty &&
    !previousChangedText &&
    !nextChangedText
  ) {
    return {
      markdown: source,
      preserved: true,
      reason: 'middle-empty-block-created'
    }
  }

  const directBlockInsertion =
    previousEnd === start &&
    !previousChangedText &&
    !!nextChangedText
  if ((!previousChangedEmpty && !directBlockInsertion) || !nextChangedText) return null
  const changedRegion = next.slice(start, nextEnd)
  const middleListSlotFill = previousChangedEmpty && isMiddleListSlotFill(changedRegion)
  if (hasDedicatedBlockSyntax(changedRegion) && !middleListSlotFill) return null

  const previousLines = visibleLineEntries(previous)
  const sourceLines = visibleLineEntries(source)

  let beforeIndex = -1
  for (let index = 0; index < previousLines.length; index += 1) {
    if (previousLines[index].end <= start) beforeIndex = index
  }
  const afterIndex = previousLines.findIndex((line) => line.start >= previousEnd)
  if (beforeIndex < 0 || afterIndex < 0 || afterIndex <= beforeIndex) return null

  const previousBefore = previousLines[beforeIndex]
  const previousAfter = previousLines[afterIndex]
  let sourceBefore
  let sourceAfter
  if (sameVisibleLines(sourceLines, previousLines)) {
    sourceBefore = sourceLines[beforeIndex]
    sourceAfter = sourceLines[afterIndex]
  } else {
    // A divergence near the document start (`- - text`, escaped punctuation,
    // etc.) shifts every later visible-line index. Using beforeIndex directly
    // then inserts a newly filled paragraph into an unrelated earlier quote —
    // especially when many quote rows contain the same “测试” text. Identify
    // the neighbouring visible-line pair by its own ordinal among equivalent
    // pairs instead of borrowing the document-global index.
    const lineKind = (line) => {
      const text = line?.text || ''
      if (/^\s*>/.test(text)) return 'quote'
      if (/^\s*(?:[-+*]|\d{1,9}[.)])\s+/.test(text)) return 'list'
      if (/^\s*#{1,6}\s+/.test(text)) return 'heading'
      if (/^\s*\|/.test(text)) return 'table'
      return 'plain'
    }
    const pairMatches = (lines, before, after) => {
      const matches = []
      for (let index = 0; index < lines.length - 1; index += 1) {
        if (
          lines[index].visible === before.visible &&
          lines[index + 1].visible === after.visible &&
          lineKind(lines[index]) === lineKind(before) &&
          lineKind(lines[index + 1]) === lineKind(after)
        ) matches.push(index)
      }
      return matches
    }
    const previousPairs = pairMatches(previousLines, previousBefore, previousAfter)
    const pairOrdinal = previousPairs.indexOf(beforeIndex)
    const sourcePairs = pairMatches(sourceLines, previousBefore, previousAfter)
    if (
      pairOrdinal < 0 ||
      sourcePairs.length !== previousPairs.length ||
      !Number.isInteger(sourcePairs[pairOrdinal])
    ) return null
    sourceBefore = sourceLines[sourcePairs[pairOrdinal]]
    sourceAfter = sourceLines[sourcePairs[pairOrdinal] + 1]
  }
  if (
    !sourceBefore ||
    !sourceAfter ||
    sourceBefore.visible !== previousBefore.visible ||
    sourceAfter.visible !== previousAfter.visible
  ) {
    return null
  }
  const delta = nextEnd - previousEnd
  const nextBefore = lineAt(next, previousBefore.start)
  const nextAfter = lineAt(next, previousAfter.start + delta)
  if (
    sourceVisibleIndex(next.slice(nextBefore.start, nextBefore.end)).text.trim() !== previousBefore.visible ||
    sourceVisibleIndex(next.slice(nextAfter.start, nextAfter.end)).text.trim() !== previousAfter.visible
  ) {
    return null
  }

  // markdownLines() includes the `\r` byte in a CRLF row's text range. The
  // middle-slot edit owns the complete line ending after the left anchor; a
  // splice at sourceBefore.end would retain that `\r` and then emit a fresh
  // `\r\n`, producing `\r\r\n`. Start before the complete CRLF pair.
  const sourceBeforeContentEnd = sourceBefore.text.endsWith('\r')
    ? sourceBefore.end - 1
    : sourceBefore.end
  const sourceGap = source.slice(sourceBeforeContentEnd, sourceAfter.start)
  if (standaloneEmptyBlockLines(sourceGap).length) return null
  const nextGap = next.slice(nextBefore.end, nextAfter.start)
  if (directBlockInsertion) {
    const previousGap = previous.slice(previousBefore.end, previousAfter.start)
    const insertionAfterGap = nextGap.startsWith(previousGap)
    const insertionBeforeGap = nextGap.endsWith(previousGap)
    if (!insertionAfterGap && !insertionBeforeGap) return null

    // Enter at the start of the following paragraph leaves the canonical
    // `<br />` placeholder in the shared gap, while the next typed block is
    // inserted *after* that placeholder and immediately before the following
    // authored paragraph. The old branch only accepted the opposite ordering
    // (new block before the existing gap), so the first character after a
    // middle Enter fell back to `visible-stream-mismatch`; every later
    // character then accumulated against the stale authored source.
    const insertedGap = canonicalFreshTextToSource(withoutStandaloneEmptyBlockLines(
      insertionAfterGap
        ? nextGap.slice(previousGap.length)
        : nextGap.slice(0, nextGap.length - previousGap.length)
    ))
    if (!insertedGap) return null
    const insertionPoint = insertionAfterGap
      ? sourceAfter.start
      : sourceBeforeContentEnd
    return {
      markdown: source.slice(0, insertionPoint) +
        adaptCanonicalRegionToSource(
          insertedGap,
          source,
          { start: insertionPoint, end: insertionPoint }
        ) +
        source.slice(insertionPoint),
      preserved: true,
      reason: 'middle-block-inserted'
    }
  }

  const sourceGapRegion = { start: sourceBeforeContentEnd, end: sourceAfter.start }
  return {
    markdown: source.slice(0, sourceBeforeContentEnd) +
      adaptCanonicalRegionToSource(
        canonicalFreshTextToSource(withoutStandaloneEmptyBlockLines(nextGap)),
        source,
        sourceGapRegion
      ) +
      source.slice(sourceAfter.start),
    preserved: true,
    reason: previousChangedEmpty
      ? middleListSlotFill
        ? 'middle-empty-block-list-filled'
        : 'middle-empty-block-filled'
      : 'middle-block-inserted'
  }
}

// An unmatched backtick or another punctuation-only line is serialized with
// a protective backslash (`\\``) even though the user typed the raw character.
// Once that authored spelling is committed, changing/deleting it leaves the
// source/canonical visible streams temporarily different and generic mapping
// fails closed. Replace only the unique matching authored line with the next
// spelling of that same line. This matters for multi-key deletion: ProseMirror
// may publish `\`\`\`` -> `\`` in one transaction; deleting the whole source
// row there would make the following keystroke permanently unmappable.
export const preserveEmptiedEscapedLiteralLine = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousLine = lineAt(previous, start)
  if (previousEnd > previousLine.end) return null
  const canonicalLine = previous.slice(previousLine.start, previousLine.end)
  const authoredLine = canonicalFreshTextToSource(canonicalLine)
  const punctuationOnly = /^[\\`*{}\[\]()#+\-.!_>~|]+$/
  if (
    authoredLine === canonicalLine ||
    !authoredLine.trim() ||
    !punctuationOnly.test(authoredLine.trim())
  ) {
    return null
  }

  const nextLine = lineAt(next, Math.min(start, next.length))
  if (nextEnd > nextLine.end) return null
  const nextCanonicalLine = next.slice(nextLine.start, nextLine.end)
  const nextAuthoredLine = withoutStandaloneEmptyBlockLines(
    canonicalFreshTextToSource(nextCanonicalLine)
  )
  const nextHasDedicatedBlockSyntax = /^\s{0,3}(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|\d+[.)](?:\s|$)|`{3,}|~{3,}|\|)/.test(
    nextAuthoredLine
  )
  // This branch owns only serializer-escaped punctuation lines and their
  // empty/plain-text transition, never a new block structure. Replacing the
  // punctuation placeholder with ordinary text is a common final step after
  // deleting a fence experiment; rejecting it would leave the canonical
  // baseline on `` ` `` and make all later edits fail closed.
  if (
    nextAuthoredLine.trim() &&
    (
      nextHasDedicatedBlockSyntax ||
      (
        canonicalFreshTextToSource(nextCanonicalLine) === nextCanonicalLine &&
        punctuationOnly.test(nextAuthoredLine.trim())
      )
    )
  ) {
    return null
  }

  const sourceLines = markdownLines(source)
  const previousLines = markdownLines(previous)
  const previousLineIndex = previousLines.findIndex((line) => (
    line.start === previousLine.start && line.end === previousLine.end
  ))
  // Source and canonical normally retain the same row skeleton even when the
  // serializer escapes punctuation. Prefer that structural identity so two
  // separate raw `` ` `` rows can be edited independently. If earlier edits
  // changed row counts, retain the stricter unique-content fallback.
  const ordinalSourceLine = sourceLines.length === previousLines.length && previousLineIndex >= 0
    ? sourceLines[previousLineIndex]
    : null
  const candidates = sourceLines.filter((line) => line.text === authoredLine)
  const sourceLine = ordinalSourceLine?.text === authoredLine
    ? ordinalSourceLine
    : candidates.length === 1
      ? candidates[0]
      : null
  if (!sourceLine) return null
  return {
    markdown: source.slice(0, sourceLine.start) + nextAuthoredLine + source.slice(sourceLine.end),
    preserved: true,
    reason: nextAuthoredLine.trim()
      ? punctuationOnly.test(nextAuthoredLine.trim())
        ? 'escaped-literal-line-changed'
        : 'escaped-literal-line-replaced'
      : 'escaped-literal-line-emptied'
  }
}

export const preserveTrailingEmptyBlock = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const sourceEmpty = trailingEmptyBlock(source)
  const previousEmpty = trailingCanonicalEmptyBlock(previous)
  const nextEmpty = trailingCanonicalEmptyBlock(next)

  if (!sourceEmpty && !previousEmpty && nextEmpty) {
    // A leading-space segment (`&#x20;   文本`, U+200B-sentineled in source)
    // deleted down to a blank canonical row makes `nextEmpty` true — this is
    // a deletion, not a newly created empty block. When the canonical tail
    // segment is a leading-space segment and the authored tail segment shows
    // the same visible text, drop the authored segment instead of keeping it
    // (which resurrected deleted content in source mode and after reopen).
    const trailingVisibleLine = (value) => {
      const body = String(value || '').replace(/\r?\n$/, '')
      const lines = body.split('\n')
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (lines[index].trim()) {
          let start = 0
          for (let before = 0; before < index; before += 1) start += lines[before].length + 1
          return { text: lines[index], start, end: start + lines[index].length }
        }
      }
      return null
    }
    const sourceTailLine = trailingVisibleLine(source)
    const previousTailLine = trailingVisibleLine(previous)
    const stripSentinel = (line) => String(line || '')
      .replace(/\u200B/g, '')
      .replace(/&#x20;/g, ' ')
      .replace(/^\s+/, '')
    if (
      sourceTailLine &&
      previousTailLine &&
      /^\s*(?:\u200B|&#x20;)/.test(previousTailLine.text) &&
      stripSentinel(sourceTailLine.text) === stripSentinel(previousTailLine.text) &&
      // Only a change that actually touches the segment is a deletion. Pressing
      // Enter after the segment (canonical grows a `<br />` empty block, which
      // makes `nextEmpty` true) must NOT drop the authored leading-space row.
      start <= previousTailLine.end
    ) {
      return {
        markdown: source.slice(0, sourceTailLine.start) + source.slice(sourceTailLine.end),
        preserved: true,
        reason: 'trailing-leading-space-deleted'
      }
    }
    return {
      markdown: source,
      preserved: true,
      reason: 'trailing-empty-block-created'
    }
  }

  if (previousEmpty && nextEmpty) {
    const previousChanged = withoutStandaloneEmptyBlockLines(
      previous.slice(start, previousEnd)
    )
    const nextChanged = withoutStandaloneEmptyBlockLines(
      next.slice(start, nextEnd)
    )
    if (!previousChanged.trim() && !nextChanged.trim()) {
      return {
        markdown: source,
        preserved: true,
        reason: 'trailing-empty-block-whitespace'
      }
    }
  }

  if (
    !sourceEmpty &&
    previousEmpty &&
    !nextEmpty &&
    start <= previousEmpty.end &&
    previousEnd >= previousEmpty.start
  ) {
    const markdown = appendBlockAtDocumentEnd(source, next.slice(start, nextEnd))
    if (markdown !== null) {
      return {
        markdown,
        preserved: true,
        reason: 'trailing-empty-block-filled'
      }
    }
  }

  return null
}

export const preserveAppendedParagraph = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd,
  replacementVisible
}) => {
  const replacement = next.slice(start, nextEnd)
  // This shortcut owns only a new plain paragraph at the physical document
  // end. Headings, lists, quotes, fences, tables, and other block syntax must
  // continue through their structural handlers; otherwise moving this proof
  // ahead of the diverged-visible branch could flatten a real structure.
  if (hasDedicatedBlockSyntax(replacement)) return null
  const previousTrailingNewlines = previous.match(/\n*$/)?.[0].length || 0
  const replacementLeadingNewlines = replacement.match(/^\n*/)?.[0].length || 0
  if (
    start !== previous.length ||
    previousEnd !== start ||
    !replacementVisible ||
    (
      replacementLeadingNewlines === 0 &&
      previousTrailingNewlines < 2
    )
  ) {
    return null
  }

  const markdown = appendBlockAtDocumentEnd(source, replacement)
  if (markdown === null) return null

  return {
    markdown,
    preserved: true,
    reason: 'appended-paragraph'
  }
}
