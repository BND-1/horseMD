import {
  sourceRawFromVisibleIndex,
  sourceVisiblePositionAtRaw,
  sourceVisibleIndex
} from '../../mode-visible-map.js'
import {
  adaptCanonicalRegionToSource,
  canonicalFreshTextToSource,
  isTableLine,
  lineAt,
  lineEndingNear,
  listMarker,
  markdownLines
} from './core.js'
import {
  preserveChangedLineRegion,
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
      return {
        markdown: source.slice(0, row.start) + source.slice(rowEnd),
        preserved: true,
        reason: 'empty-list-item-removed'
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
  const block = hasDedicatedBlockSyntax(canonical)
    ? canonical
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
export const capOutputTrailingNewlines = (markdown, source) => {
  const output = String(markdown || '')
  // A brand-new document generated from an empty source has no authored
  // terminal convention yet; its own serializer newline is the structure.
  if (!String(source || '').trim()) return output
  const outputTrail = output.match(/(?:\r\n|\r|\n)*$/)?.[0] || ''
  const sourceTrail = String(source || '').match(/(?:\r\n|\r|\n)*$/)?.[0] || ''
  const countBreaks = (run) => (run.match(/\r\n|\n|\r/g) || []).length
  if (countBreaks(outputTrail) <= countBreaks(sourceTrail)) return output
  return output.slice(0, output.length - outputTrail.length) + sourceTrail
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
  if (hasDedicatedBlockSyntax(next.slice(start, nextEnd))) return null

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
  const sourceBefore = sourceLines[beforeIndex]
  const sourceAfter = sourceLines[afterIndex]
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

  const sourceGap = source.slice(sourceBefore.end, sourceAfter.start)
  if (standaloneEmptyBlockLines(sourceGap).length) return null
  const nextGap = next.slice(nextBefore.end, nextAfter.start)
  if (directBlockInsertion) {
    const previousGap = previous.slice(previousBefore.end, previousAfter.start)
    if (!nextGap.endsWith(previousGap)) return null
    const insertedGap = canonicalFreshTextToSource(withoutStandaloneEmptyBlockLines(
      nextGap.slice(0, nextGap.length - previousGap.length)
    ))
    if (!insertedGap) return null
    return {
      markdown: source.slice(0, sourceBefore.end) +
        adaptCanonicalRegionToSource(
          insertedGap,
          source,
          { start: sourceBefore.end, end: sourceBefore.end }
        ) +
        source.slice(sourceBefore.end),
      preserved: true,
      reason: 'middle-block-inserted'
    }
  }

  const sourceGapRegion = { start: sourceBefore.end, end: sourceAfter.start }
  return {
    markdown: source.slice(0, sourceBefore.end) +
      adaptCanonicalRegionToSource(
        canonicalFreshTextToSource(withoutStandaloneEmptyBlockLines(nextGap)),
        source,
        sourceGapRegion
      ) +
      source.slice(sourceAfter.start),
    preserved: true,
    reason: previousChangedEmpty
      ? 'middle-empty-block-filled'
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
