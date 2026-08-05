import {
  sourceVisibleIndex
} from '../../mode-visible-map.js'
import {
  adaptCanonicalRegionToSource,
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
  // documents; the source must still represent the same visible content as the
  // previous canonical baseline (otherwise the visible-mismatch path owns the
  // edit and its authored spellings).
  if (previous.slice(0, start) !== next.slice(0, start)) return null
  if (previous.slice(previousEnd) !== next.slice(nextEnd)) return null
  // Inside a blockquote the shared `> ` marker sits outside the literal change
  // span, so an emptied paragraph's `<br />` line only overlaps [start, nextEnd].
  if (!nextEmptyLines.every((range) => range.end >= start && range.start <= nextEnd)) return null
  if (sourceVisibleIndex(source).text !== sourceVisibleIndex(previous).text) return null
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
  const block = withoutStandaloneEmptyBlockLines(canonicalBlock)
    .replace(/^(?:(?:\r\n)|\n|\r)+/, '')
    .replace(/(?:(?:\r\n)|\n|\r)+$/, '')
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
    const insertedGap = withoutStandaloneEmptyBlockLines(
      nextGap.slice(0, nextGap.length - previousGap.length)
    )
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
        withoutStandaloneEmptyBlockLines(nextGap),
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

export const preserveTrailingEmptyBlock = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const sourceEmpty = trailingEmptyBlock(source)
  const previousEmpty = trailingEmptyBlock(previous)
  const nextEmpty = trailingEmptyBlock(next)

  if (!sourceEmpty && !previousEmpty && nextEmpty) {
    return {
      markdown: source,
      preserved: true,
      reason: 'trailing-empty-block-created'
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
