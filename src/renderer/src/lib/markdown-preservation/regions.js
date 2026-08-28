import {
  sourceRawFromVisibleIndex,
  sourceVisibleIndex,
  sourceVisiblePositionAtRaw
} from '../../mode-visible-map.js'
import { LEADING_SPACE_SENTINEL } from '../markdown-leading-space.js'
import { decodeNamedCharacterReference } from 'decode-named-character-reference'
import {
  adaptCanonicalRegionToSource,
  canonicalFreshTextToSource,
  canonicalTextToSource,
  commonChange,
  lineAt,
  lineIndexAt,
  lineEndingNear,
  markdownLines,
  rawOffsetAtVisible
} from './core.js'

// When a paragraph begins with one authored literal space, remark-stringify
// first emits `&#x20;`, which the source layer stores as `U+200B + space`.
// Once the user adds a second ordinary space after the list marker, the
// canonical spelling becomes two plain spaces and the sentinel must disappear.
// A normal visible-offset patch starts after the sentinel, so it otherwise
// survives forever and makes source/canonical diverge on the next keystroke.
export const reconcileLeadingSpaceSentinelTransition = ({
  source,
  previous,
  next,
  markdown
}) => {
  const { start, previousEnd, nextEnd } = commonChange(previous, next)
  const previousStartLine = lineAt(previous, start)
  const previousEndLine = lineAt(previous, Math.max(start, previousEnd - 1))
  const nextStartLine = lineAt(next, start)
  const nextEndLine = lineAt(next, Math.max(start, nextEnd - 1))
  if (
    previousStartLine.start !== previousEndLine.start ||
    nextStartLine.start !== nextEndLine.start ||
    /\\r|\\n/.test(next.slice(start, nextEnd))
  ) return null

  const previousLineText = previous.slice(previousStartLine.start, previousStartLine.end)
  const nextLineText = next.slice(nextStartLine.start, nextStartLine.end)
  if (
    !previousLineText.includes('&#x20;') ||
    nextLineText.includes('&#x20;')
  ) return null

  const previousVisible = sourceVisibleIndex(previousLineText).text
  const nextVisible = sourceVisibleIndex(nextLineText).text
  const sentinel = `${LEADING_SPACE_SENTINEL} `
  const sourceLines = markdownLines(source)
  const sourceCandidates = sourceLines
    .filter((line) => line.text.includes(sentinel))
    .filter((line) => sourceVisibleIndex(line.text).text === previousVisible)
  if (sourceCandidates.length !== 1) return null

  const resultLines = markdownLines(markdown)
  let resultCandidates = resultLines
    .filter((line) => line.text.includes(sentinel))
    .filter((line) => sourceVisibleIndex(line.text).text === previousVisible)

  // RS-77: deleting the entire visible body of a sentinel-backed list row can
  // leave `localized-change` with a result line whose visible text is now empty.
  // The old lookup searched only by the previous visible body and therefore
  // could not find the already-patched row. For this exact zero-visible case,
  // fall back to the same line ordinal only when the edit stayed single-line,
  // source/result line counts are unchanged, and that result line still owns
  // the sentinel. The final visible equality check below remains authoritative.
  if (resultCandidates.length === 0 && nextVisible === '' && sourceLines.length === resultLines.length) {
    const sourceCandidate = sourceCandidates[0]
    const sourceLineIndex = sourceLines.findIndex((line) =>
      line.start === sourceCandidate.start && line.end === sourceCandidate.end
    )
    const positionalCandidate = sourceLineIndex >= 0 ? resultLines[sourceLineIndex] : null
    if (positionalCandidate?.text.includes(sentinel)) resultCandidates = [positionalCandidate]
  }
  if (resultCandidates.length !== 1) return null

  const candidate = resultCandidates[0]
  const correctedLine = candidate.text.replace(LEADING_SPACE_SENTINEL, '')
  if (sourceVisibleIndex(correctedLine).text !== nextVisible) return null

  return {
    markdown: markdown.slice(0, candidate.start) +
      correctedLine +
      markdown.slice(candidate.end),
    reason: 'leading-space-sentinel-reconciled'
  }
}

// RS-76: a list row created with source-owned leading-space syntax can later
// lose all visible body text while intentionally retaining horizontal spaces.
// On a globally-diverged document the generic visible mappers cannot locate
// that zero-visible tail edit. Prove the complete final-row transition instead:
// canonical must change only its last row from `* &#x20;...text` to a spaces-only
// bullet row, and authored source must end in the corresponding sentinel row.
// The sentinel is removed because it would reparse as real paragraph text once
// no non-whitespace body remains.
export const preserveDivergedLeadingSpaceListWhitespaceTail = ({ source, previous, next }) => {
  const tail = (value) => {
    const body = String(value || '').replace(/(?:\r?\n)+$/, '')
    const start = body.lastIndexOf('\n') + 1
    return { prefix: body.slice(0, start), line: body.slice(start) }
  }
  const sourceTail = tail(source)
  const previousTail = tail(previous)
  const nextTail = tail(next)
  if (previousTail.prefix !== nextTail.prefix || previousTail.line === nextTail.line) return null

  const previousRow = previousTail.line.match(
    /^(\s*)([-+*])([ \t]+)&#x20;([ \t]*)(\S.*)$/
  )
  const nextRow = nextTail.line.match(/^(\s*)([-+*])([ \t]+)$/)
  const authoredRow = sourceTail.line.match(
    /^(\s*)([-+*])([ \t]+)\u200B([ \t]+)(\S.*)$/
  )
  if (!previousRow || !nextRow || !authoredRow) return null
  if (
    previousRow[1] !== nextRow[1] ||
    previousRow[2] !== nextRow[2] ||
    authoredRow[1] !== previousRow[1]
  ) return null

  // `&#x20;` is exactly one authored leading space. The source sentinel is
  // syntax only, so the bytes after it must equal the decoded canonical body.
  const canonicalBody = ` ${previousRow[4]}${previousRow[5]}`
  const authoredBody = `${authoredRow[4]}${authoredRow[5]}`
  if (canonicalBody !== authoredBody) return null

  const nextWhitespace = nextTail.line.slice(nextRow[1].length + nextRow[2].length)
  const replacement = authoredRow[1] + authoredRow[2] + nextWhitespace
  return {
    markdown: sourceTail.prefix + replacement + source.slice(
      sourceTail.prefix.length + sourceTail.line.length
    ),
    preserved: true,
    reason: 'diverged-leading-space-list-whitespace-tail'
  }
}

// RS-78: a globally-diverged document can still make one exact local edit at
// its tail: an existing bullet item's non-empty body becomes empty while the
// bullet slot itself survives. Global visible alignment is intentionally unable
// to locate this safely, so prove the raw final row instead. Previous and next
// canonical must differ only in that final row; its bullet syntax is unchanged;
// and the authored final row must be the corresponding bullet body. Only the
// authored body bytes are removed — marker spelling and spacing remain authored.
export const preserveDivergedTailBulletBodyEmptied = ({ source, previous, next }) => {
  const tail = (value) => {
    const text = String(value || '')
    const body = text.replace(/(?:\r?\n)+$/, '')
    const start = body.lastIndexOf('\n') + 1
    return { prefix: body.slice(0, start), line: body.slice(start), text }
  }
  const sourceTail = tail(source)
  const previousTail = tail(previous)
  const nextTail = tail(next)
  if (previousTail.prefix !== nextTail.prefix || previousTail.line === nextTail.line) return null

  const previousRow = previousTail.line.match(/^(\s*)([-+*])([ \t]+)(.*\S)[ \t]*$/)
  const nextRow = nextTail.line.match(/^(\s*)([-+*])([ \t]+)$/)
  const authoredRow = sourceTail.line.match(/^(\s*)([-+*])([ \t]+)(.*\S)[ \t]*$/)
  if (!previousRow || !nextRow || !authoredRow) return null
  if (
    previousRow[1] !== nextRow[1] ||
    previousRow[2] !== nextRow[2] ||
    previousRow[3] !== nextRow[3] ||
    authoredRow[1] !== previousRow[1]
  ) return null

  const previousBodyVisible = sourceVisibleIndex(previousRow[4]).text
  const authoredBodyVisible = sourceVisibleIndex(authoredRow[4]).text
  if (!previousBodyVisible || authoredBodyVisible !== previousBodyVisible) return null

  const replacement = authoredRow[1] + authoredRow[2] + authoredRow[3]
  return {
    markdown: sourceTail.prefix + replacement + sourceTail.text.slice(
      sourceTail.prefix.length + sourceTail.line.length
    ),
    preserved: true,
    reason: 'diverged-tail-bullet-body-emptied'
  }
}

const displayMathBlocks = (markdown) => {
  const value = String(markdown || '')
  const lines = markdownLines(value)
  const blocks = []
  let open = null
  for (const line of lines) {
    if (!/^ {0,3}\$\$\s*$/.test(line.text)) continue
    if (!open) {
      open = {
        openStart: line.start,
        openEnd: line.end,
        contentStart: line.end + (value[line.end] === '\n' ? 1 : 0),
        openLine: line.text
      }
      continue
    }
    blocks.push({
      ...open,
      closeStart: line.start,
      closeEnd: line.end,
      closeLine: line.text
    })
    open = null
  }
  return blocks
}

// The raw bytes between paired `$$` rows include the EOL that terminates the
// final content row, while the ProseMirror code_block text does not. One
// terminal EOL is therefore structural. This also makes `$$\n\n$$` and
// `$$\n$$` equivalent empty blocks, but preserves any additional blank row as
// real math content.
const displayMathSemanticContent = (value) => String(value || '')
  .replace(/\r\n|\r/g, '\n')
  .replace(/\n$/, '')

// Display-math content is serialized as a LaTeX code_block bounded by paired
// `$$` rows. Its first and later CodeMirror edits must replace only that content
// region. Letting the generic middle-block mapper own the insertion adds a blank
// row before the closing `$$`, which changes the parsed code_block text by one
// trailing newline and creates a first-divergence on every keystroke.
export const preserveDisplayMathBlockTextChange = ({
  source,
  previous,
  next,
  start
}) => {
  const previousBlocks = displayMathBlocks(previous)
  const nextBlocks = displayMathBlocks(next)
  const previousIndex = previousBlocks.findIndex((block) =>
    start >= block.contentStart && start <= block.closeStart
  )
  if (previousIndex < 0 || previousIndex >= nextBlocks.length) return null
  const previousBlock = previousBlocks[previousIndex]
  const nextBlock = nextBlocks[previousIndex]
  if (
    previousBlock.openLine !== nextBlock.openLine ||
    previousBlock.closeLine !== nextBlock.closeLine ||
    previous.slice(0, previousBlock.openStart) !== next.slice(0, nextBlock.openStart) ||
    previous.slice(previousBlock.closeEnd) !== next.slice(nextBlock.closeEnd)
  ) return null

  const sourceBlocks = displayMathBlocks(source)
  const sourceBlock = sourceBlocks[previousIndex]
  if (!sourceBlock) return null
  const sourceContent = source.slice(sourceBlock.contentStart, sourceBlock.closeStart)
  const canonicalContent = previous.slice(previousBlock.contentStart, previousBlock.closeStart)
  if (
    displayMathSemanticContent(sourceContent) !==
    displayMathSemanticContent(canonicalContent)
  ) return null

  const nextContent = next.slice(nextBlock.contentStart, nextBlock.closeStart)
  const eol = lineEndingNear(source, sourceBlock.contentStart)
  const replacement = nextContent.replace(/\r\n|\r|\n/g, eol)
  return {
    markdown: source.slice(0, sourceBlock.contentStart) +
      replacement +
      source.slice(sourceBlock.closeStart),
    preserved: true,
    reason: 'display-math-block-content-change',
    sourceContent,
    canonicalContent,
    nextContent
  }
}

const fencedBlocks = (markdown) => {
  const source = String(markdown || '')
  const lines = markdownLines(source)
  const blocks = []
  let open = null
  for (const line of lines) {
    // `markdownLines` deliberately retains the CR byte in a CRLF row so raw
    // offsets remain physical-source offsets. Classify Markdown syntax against
    // the logical line without that terminator; JavaScript `.` does not match
    // `\r`, which previously made every CRLF opening fence invisible while the
    // closing `\s*` still appeared valid.
    const lineText = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
    if (!open) {
      const match = lineText.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (match) {
        const fenceOffset = lineText.indexOf(match[1])
        const fenceStart = line.start + fenceOffset
        const fenceEnd = fenceStart + match[1].length
        open = {
          openStart: line.start,
          openEnd: line.end,
          contentStart: line.end + (source[line.end] === '\n' ? 1 : 0),
          openLine: lineText,
          indent: lineText.slice(0, fenceOffset),
          char: match[1][0],
          length: match[1].length,
          fenceStart,
          fenceEnd,
          infoStart: fenceEnd,
          infoEnd: line.start + lineText.length,
          infoRaw: match[2]
        }
      }
      continue
    }
    const close = lineText.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
    if (!close || close[1][0] !== open.char || close[1].length < open.length) continue
    blocks.push({
      ...open,
      closeStart: line.start,
      closeEnd: line.end,
      closeLine: lineText
    })
    open = null
  }
  return blocks
}

export const fencedCodeBlockAt = (markdown, offset) => {
  const source = String(markdown || '')
  const safe = Math.max(0, Math.min(Number(offset) || 0, source.length))
  return fencedBlocks(source).find((block) =>
    safe >= block.openStart && safe <= block.closeEnd
  ) || null
}

// Code-block content is a distinct transaction owner. When an empty fenced
// block in the middle of a diverged document receives its first characters,
// the visible-line mapper sees only a new plain line and the generic middle
// paragraph handler can insert that text before the opening fence. Prove the
// edit against the paired fence boundaries first and replace only the source
// block's content region; never let a paragraph mapper own this transaction.
export const preserveFencedCodeBlockTextChange = ({
  source,
  previous,
  next,
  start
}) => {
  const previousBlocks = fencedBlocks(previous)
  const nextBlocks = fencedBlocks(next)
  const previousIndex = previousBlocks.findIndex((block) =>
    start >= block.contentStart && start <= block.closeStart
  )
  if (previousIndex < 0 || previousIndex >= nextBlocks.length) return null
  const previousBlock = previousBlocks[previousIndex]
  const nextBlock = nextBlocks[previousIndex]
  if (
    previousBlock.openLine !== nextBlock.openLine ||
    previousBlock.closeLine !== nextBlock.closeLine ||
    previous.slice(0, previousBlock.openStart) !== next.slice(0, nextBlock.openStart) ||
    previous.slice(previousBlock.closeEnd) !== next.slice(nextBlock.closeEnd)
  ) return null

  const sourceBlocks = fencedBlocks(source)
  const sourceBlock = sourceBlocks[previousIndex]
  if (!sourceBlock) return null
  if (
    sourceBlock.char !== previousBlock.char ||
    sourceBlock.length !== previousBlock.length ||
    sourceVisibleIndex(source.slice(sourceBlock.contentStart, sourceBlock.closeStart)).text !==
      sourceVisibleIndex(previous.slice(previousBlock.contentStart, previousBlock.closeStart)).text
  ) return null

  const sourceContent = source.slice(sourceBlock.contentStart, sourceBlock.closeStart)
  const nextContent = next.slice(nextBlock.contentStart, nextBlock.closeStart)
  const eol = source.includes(String.fromCharCode(13, 10))
    ? String.fromCharCode(13, 10)
    : String.fromCharCode(10)
  const replacement = nextContent
    .split(String.fromCharCode(13, 10)).join(eol)
    .split(String.fromCharCode(13)).join(eol)
    .split(String.fromCharCode(10)).join(eol)
  return {
    markdown: source.slice(0, sourceBlock.contentStart) +
      replacement +
      source.slice(sourceBlock.closeStart),
    preserved: true,
    reason: 'fenced-code-block-content-change',
    sourceContent,
    canonicalContent: previous.slice(previousBlock.contentStart, previousBlock.closeStart),
    nextContent
  }
}

const lineRegion = (markdown, start, end) => {
  const first = lineAt(markdown, start)
  // `end` is exclusive. When a structural insertion is exactly a newline,
  // the unchanged suffix starts at `end` on a new line and must travel with
  // the replacement.
  const last = lineAt(markdown, Math.max(start, end))
  return { start: first.start, end: last.end }
}

const isBlockPrefix = (value) =>
  /^\s*(?:#{1,6}|>|[-+*]|\d{1,9}[.)])?\s*$/.test(value)

export const hasStructuralPrefixChange = ({ previous, next, start, previousEnd, nextEnd }) => {
  const previousLine = lineAt(previous, start)
  const nextLine = lineAt(next, start)
  return isBlockPrefix(previous.slice(previousLine.start, previousEnd)) &&
    isBlockPrefix(next.slice(nextLine.start, nextEnd))
}

// A user edit before a later visible-stream mismatch is safe only when the
// bounded visible context agrees at the exact ordinal positions.
export const preserveLocallyAlignedTextChange = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  // This fallback owns text inside one existing source line only. Markdown
  // block separators carry no visible characters, so accepting a multiline
  // insertion here can map a sibling list/heading/fence to the byte before the
  // source's final newline (`3. item* sibling`). Dedicated block/line mappers
  // run before and after this function and retain the structural context.
  const previousStartLine = lineAt(previous, start)
  const previousEndLine = lineAt(previous, Math.max(start, previousEnd - 1))
  const nextStartLine = lineAt(next, start)
  const nextEndLine = lineAt(next, Math.max(start, nextEnd - 1))
  if (
    previousStartLine.start !== previousEndLine.start ||
    nextStartLine.start !== nextEndLine.start ||
    /\r|\n/.test(next.slice(start, nextEnd))
  ) return null
  const previousVisible = sourceVisibleIndex(previous)
  const sourceVisible = sourceVisibleIndex(source)
  const startVisible = sourceVisiblePositionAtRaw(previous, start)
  const endVisible = sourceVisiblePositionAtRaw(previous, previousEnd)
  const visibleStart = startVisible.visibleIndex
  const visibleEnd = endVisible.visibleIndex
  const replacement = next.slice(start, nextEnd)
  const replacementVisible = sourceVisibleIndex(replacement).text
  const previousChangedVisible = previousVisible.text.slice(visibleStart, visibleEnd)
  if (!previousChangedVisible && !replacementVisible) return null

  const changedLines = lineRegion(previous, start, previousEnd)
  const lineVisibleStart = sourceVisiblePositionAtRaw(previous, changedLines.start).visibleIndex
  const lineVisibleEnd = sourceVisiblePositionAtRaw(previous, changedLines.end).visibleIndex
  const contextStart = Math.max(lineVisibleStart, visibleStart - 64)
  const contextEnd = Math.min(lineVisibleEnd, visibleEnd + 64)
  if (
    sourceVisible.text.slice(contextStart, visibleStart) !==
      previousVisible.text.slice(contextStart, visibleStart) ||
    sourceVisible.text.slice(visibleStart, visibleEnd) !== previousChangedVisible ||
    sourceVisible.text.slice(visibleEnd, contextEnd) !==
      previousVisible.text.slice(visibleEnd, contextEnd)
  ) {
    return null
  }

  let rawStart = rawOffsetAtVisible(source, startVisible)
  let rawEnd = rawOffsetAtVisible(source, endVisible)
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart > rawEnd) return null

  // Markdown trailing spaces are intentionally absent from the visible stream.
  // For a pure insertion at the canonical line's raw end, a backward-affinity
  // visible position therefore maps to the byte before those spaces. Inserting
  // there turns `text ` + `body` into `textbody ` even though the editor made
  // `text body`. Move only this exact line-end insertion across an authored
  // horizontal-whitespace tail; replacements/deletions and edits before the
  // tail retain their existing coordinates.
  if (
    start === previousEnd &&
    nextEnd > start &&
    start === previousStartLine.end &&
    rawStart === rawEnd &&
    /[ \t]$/.test(previous.slice(previousStartLine.start, previousStartLine.end))
  ) {
    const sourceLine = lineAt(source, rawStart)
    const sourceTail = source.slice(rawStart, sourceLine.end)
    if (
      /^[ \t]+$/.test(sourceTail) &&
      sourceVisibleIndex(source.slice(sourceLine.start, sourceLine.end)).text ===
        sourceVisibleIndex(previous.slice(previousStartLine.start, previousStartLine.end)).text
    ) {
      rawStart = sourceLine.end
      rawEnd = sourceLine.end
    }
  }

  return {
    markdown: source.slice(0, rawStart) +
      adaptCanonicalRegionToSource(replacement, source, { start: rawStart, end: rawEnd }) +
      source.slice(rawEnd),
    preserved: true,
    reason: 'locally-aligned-change'
  }
}

// A document can have a permanent visible-stream divergence before the block
// being edited (nested `- 4. text`, a literal mid-line `*`, serializer-only
// entities, etc.). Ordinal visible offsets then point at the wrong source
// location even though the changed text and its immediate context are unique.
// For a single-line text delta, locate that bounded context in the authored
// visible stream and apply only the corresponding raw range. Structural and
// multi-line changes stay with their dedicated handlers.
export const preserveUniquelyAnchoredTextChange = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousStartLine = lineAt(previous, start)
  const previousEndLine = lineAt(previous, Math.max(start, previousEnd - 1))
  const nextStartLine = lineAt(next, start)
  const nextEndLine = lineAt(next, Math.max(start, nextEnd - 1))
  if (
    previousStartLine.start !== previousEndLine.start ||
    nextStartLine.start !== nextEndLine.start
  ) return null

  const previousVisible = sourceVisibleIndex(previous)
  const sourceVisible = sourceVisibleIndex(source)
  const startPosition = sourceVisiblePositionAtRaw(previous, start)
  const endPosition = sourceVisiblePositionAtRaw(previous, previousEnd)
  const visibleStart = startPosition.visibleIndex
  const visibleEnd = endPosition.visibleIndex
  const changedVisible = previousVisible.text.slice(visibleStart, visibleEnd)
  const replacement = next.slice(start, nextEnd)
  const replacementVisible = sourceVisibleIndex(replacement).text
  if ((!changedVisible && !replacementVisible) || /\r|\n/.test(replacement)) return null

  const before = previousVisible.text.slice(Math.max(0, visibleStart - 32), visibleStart)
  const after = previousVisible.text.slice(visibleEnd, visibleEnd + 32)
  const context = before + changedVisible + after
  if (!context) return null
  const contextAt = sourceVisible.text.indexOf(context)
  if (contextAt < 0 || sourceVisible.text.indexOf(context, contextAt + 1) >= 0) return null

  const mappedStart = contextAt + before.length
  const mappedEnd = mappedStart + changedVisible.length
  const rawStart = sourceRawFromVisibleIndex(source, mappedStart, startPosition.visibleAffinity)
  const rawEnd = sourceRawFromVisibleIndex(source, mappedEnd, endPosition.visibleAffinity)
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart > rawEnd) return null
  if (sourceVisibleIndex(source.slice(rawStart, rawEnd)).text !== changedVisible) return null

  return {
    markdown: source.slice(0, rawStart) +
      adaptCanonicalRegionToSource(replacement, source, { start: rawStart, end: rawEnd }) +
      source.slice(rawEnd),
    preserved: true,
    reason: 'uniquely-anchored-text-change'
  }
}

// Source represents an empty rich paragraph as an empty authored row while
// canonical uses `<br />`. Their visible streams are equal, but every offset
// at that zero-width row has two valid raw affinities. A later ordinary edit
// can therefore map to the heading/paragraph before the empty row and glue
// blocks together. When source/previous/next retain the same row skeleton and
// the edit stays inside one row, row ordinal is the stronger identity.
export const preserveOrdinalLineTextChange = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const sourceLines = markdownLines(source)
  const previousLines = markdownLines(previous)
  const nextLines = markdownLines(next)
  if (
    sourceLines.length !== previousLines.length ||
    previousLines.length !== nextLines.length
  ) {
    return null
  }
  const hasEmptyPlaceholderDivergence = previousLines.some((line, index) => (
    /^\s*(?:>\s*)*<br\s*\/?>\s*$/i.test(line.text) &&
    !sourceLines[index]?.text.trim()
  ))
  if (!hasEmptyPlaceholderDivergence) return null

  const previousStartLine = lineAt(previous, start)
  const previousEndLine = lineAt(previous, Math.max(start, previousEnd - 1))
  const nextStartLine = lineAt(next, start)
  const nextEndLine = lineAt(next, Math.max(start, nextEnd - 1))
  if (
    previousStartLine.start !== previousEndLine.start ||
    nextStartLine.start !== nextEndLine.start
  ) {
    return null
  }

  const row = previousLines.findIndex((line) => (
    line.start === previousStartLine.start && line.end === previousStartLine.end
  ))
  if (row < 0 || nextLines[row]?.start !== nextStartLine.start) return null
  const sourceLine = sourceLines[row]
  const previousLine = previousLines[row]
  const nextLine = nextLines[row]
  if (
    sourceVisibleIndex(sourceLine.text).text !==
    sourceVisibleIndex(previousLine.text).text
  ) {
    return null
  }

  const replacement = sourceLine.text === previousLine.text
    ? canonicalFreshTextToSource(nextLine.text)
    : adaptCanonicalRegionToSource(nextLine.text, source, sourceLine)
  return {
    markdown: source.slice(0, sourceLine.start) + replacement + source.slice(sourceLine.end),
    preserved: true,
    reason: 'ordinal-line-text-change'
  }
}

// A canonical block is a run of non-blank lines bounded by blank lines. The
// change [start, end) must stay inside one block; crossing a blank-line
// boundary is a structural edit and belongs to the list/table/paragraph paths.
const blockSpan = (markdown, start, end) => {
  const lines = markdownLines(markdown)
  const index = lineIndexAt(lines, start)
  if (index < 0) return null
  const blank = (line) => /^\s*$/.test(line.text)
  let first = index
  while (first > 0 && !blank(lines[first - 1])) first -= 1
  let last = index
  while (last < lines.length - 1 && !blank(lines[last + 1])) last += 1
  // The change end must sit inside the same block (allowing `end === block
  // end`). If it lands past the block, the edit spans multiple canonical
  // blocks and must not use this fallback.
  if (end > lines[last].end) return null
  return { start: lines[first].start, end: lines[last].end }
}

const nonBlankBlockSpans = (markdown) => {
  const lines = markdownLines(markdown)
  const spans = []
  let first = -1
  const push = (last) => {
    if (first < 0 || last < first) return
    spans.push({ start: lines[first].start, end: lines[last].end })
    first = -1
  }
  lines.forEach((line, index) => {
    if (/^\s*$/.test(line.text)) {
      push(index - 1)
      return
    }
    if (first < 0) first = index
  })
  push(lines.length - 1)
  return spans
}

// When the visible streams diverge (source and canonical disagree about how
// the authored bytes map to blocks — a mid-line `* ` that remark parses as a
// list item while the author kept it as paragraph text), both
// preserveLocallyAlignedTextChange and preserveChangedLineRegion fail and the
// façade would roll the edit back: a rich-text deletion never reaches the
// source. If the user's edit is confined to a single canonical block and that
// block can be mapped one-to-one to an authored source block, apply the
// block-level delta directly to the source spelling. Equal-count repeated
// blocks map by ordinal; merged/split or otherwise ambiguous blocks stay
// untouched (fail closed).
export const preserveDivergedBlockTextChange = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousBlock = blockSpan(previous, start, previousEnd)
  const nextBlock = blockSpan(next, start, nextEnd)
  if (!previousBlock || !nextBlock) return null
  const previousText = previous.slice(previousBlock.start, previousBlock.end)
  const nextText = next.slice(nextBlock.start, nextBlock.end)
  if (!previousText || !nextText || previousText === nextText) return null

  // RS-50: generated scratch persists an otherwise-empty GFM task item with a
  // lone U+200B source sentinel because bare `- [ ] ` reparses as ordinary
  // bracket text. On reopen the remark plugin strips that sentinel from the PM
  // paragraph, so the next canonical baseline is `* [ ] <br />`. The first
  // typed body text must CONSUME the source sentinel; the generic diverged-block
  // fallback inserts before it and leaves `text<U+200B>`, which then fails the
  // integrity gate. Prove the exact empty-task lifecycle and map repeated rows
  // by ordinal before replacing only the sentinel body bytes.
  const taskRow = (text) => {
    const match = String(text || '').match(
      /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)\[([ xX])\]([ \t]+)(.*)$/i
    )
    if (!match) return null
    return {
      indent: match[1],
      marker: match[2],
      spacing: match[3],
      checked: match[4].toLowerCase(),
      taskSpacing: match[5],
      body: match[6],
      kind: /^\d/.test(match[2]) ? 'ordered' : 'bullet',
      bodyOffset: match[1].length + match[2].length + match[3].length +
        3 + match[5].length
    }
  }
  const previousTask = taskRow(previousText)
  const nextTask = taskRow(nextText)
  const isEmptyTaskPlaceholder = (body) => {
    const value = String(body || '')
    // preserveRichMarkdownSourceCore() normalizes empty list placeholders
    // before dispatch, so the same editor-owned task slot can arrive either
    // as raw `<br />` (direct mapper tests) or as an empty/whitespace body
    // (the real façade path). Source still has to prove the exact U+200B
    // sentinel row below before this branch can publish anything.
    return !value.trim() || /^<br\s*\/?>\s*$/i.test(value)
  }
  if (
    previousTask &&
    nextTask &&
    previousTask.kind === nextTask.kind &&
    previousTask.checked === nextTask.checked &&
    isEmptyTaskPlaceholder(previousTask.body) &&
    nextTask.body.trim() &&
    !isEmptyTaskPlaceholder(nextTask.body)
  ) {
    const sameTaskShape = (row, target) => row &&
      row.kind === target.kind &&
      row.checked === target.checked &&
      row.indent.length === target.indent.length
    const previousRows = markdownLines(previous)
      .map((line) => ({ line, row: taskRow(line.text) }))
      .filter(({ row }) => sameTaskShape(row, previousTask) && isEmptyTaskPlaceholder(row.body))
    const targetOrdinal = previousRows.findIndex(({ line }) => (
      line.start === previousBlock.start && line.end === previousBlock.end
    ))
    const sourceRows = markdownLines(source)
      .map((line) => ({ line, row: taskRow(line.text) }))
      .filter(({ row }) => (
        sameTaskShape(row, previousTask) && row.body === LEADING_SPACE_SENTINEL
      ))
    if (
      targetOrdinal >= 0 &&
      sourceRows.length === previousRows.length &&
      sourceRows[targetOrdinal]
    ) {
      const { line: sourceLine, row: sourceTask } = sourceRows[targetOrdinal]
      const bodyStart = sourceLine.start + sourceTask.bodyOffset
      const replacement = canonicalTextToSource(nextTask.body)
      return {
        markdown: source.slice(0, bodyStart) + replacement + source.slice(sourceLine.end),
        preserved: true,
        reason: 'empty-task-sentinel-filled'
      }
    }
  }
  if (
    start < previousBlock.start ||
    previousEnd > previousBlock.end ||
    start < nextBlock.start ||
    nextEnd > nextBlock.end
  ) {
    return null
  }

  // The canonical block may spell punctuation with backslash escapes or HTML
  // entities (`\*`, `&#x20;`) that the authored source keeps literal. Try the
  // verbatim block first; if it does not occur, retry with the canonical
  // spelling converted back to plain Markdown.
  const candidates = [previousText]
  const unescapedPrevious = unescapeCanonicalBlock(previousText)
  if (unescapedPrevious && unescapedPrevious !== previousText) {
    candidates.push(unescapedPrevious)
  }
  let first = -1
  let matched = ''

  // Prefer a one-to-one block occurrence mapping over a whole-document
  // substring search. Short paragraph text such as “测试” can occur inside
  // headings, list items, and quotes many times while the standalone block is
  // still unambiguous. Repeated standalone blocks are also safe when source
  // and canonical contain the same number of equivalent blocks: their ordinal
  // identity survives unrelated serializer divergence elsewhere. If remark
  // merged/split one of those blocks, the counts differ and this path refuses
  // to guess; the stricter legacy unique-substring fallback remains below.
  const blockKey = (value) => unescapeCanonicalBlock(value)
    .replace(/\r\n|\r/g, '\n')
  const targetKey = blockKey(previousText)
  const previousMatches = nonBlankBlockSpans(previous)
    .filter((block) => blockKey(previous.slice(block.start, block.end)) === targetKey)
  const targetOrdinal = previousMatches.findIndex((block) => (
    block.start === previousBlock.start && block.end === previousBlock.end
  ))
  const sourceMatches = nonBlankBlockSpans(source)
    .filter((block) => blockKey(source.slice(block.start, block.end)) === targetKey)
  if (
    targetOrdinal >= 0 &&
    previousMatches.length > 0 &&
    sourceMatches.length === previousMatches.length
  ) {
    const sourceBlock = sourceMatches[targetOrdinal]
    first = sourceBlock.start
    matched = source.slice(sourceBlock.start, sourceBlock.end)
  }

  for (const candidate of candidates) {
    if (first >= 0) break
    const found = source.indexOf(candidate)
    if (found >= 0 && source.indexOf(candidate, found + 1) < 0) {
      first = found
      matched = candidate
      break
    }
  }
  if (first < 0 || !matched) return null

  const replacement = unescapeCanonicalBlock(nextText)
  if (!replacement) return null
  // A Crepe-only empty-paragraph `<br />` placeholder must never enter
  // authored source through this fallback; those edits belong to the
  // paragraph-emptied handlers that run before the divergence path.
  if (/^[ \t]*(?:[ \t]*>[ \t]*)*<br\s*\/?>[ \t]*$/im.test(replacement)) return null

  return {
    markdown: source.slice(0, first) +
      adaptCanonicalRegionToSource(
        replacement,
        source,
        { start: first, end: first + matched.length }
      ) +
      source.slice(first + matched.length),
    preserved: true,
    reason: 'diverged-block-change'
  }
}

// RS-73: a source-authored standalone tail image can be parsed by remark as an
// inline atom continuing the deepest preceding ordered-list paragraph. The
// serializer then indents that image under the list, so a later rich Backspace
// deletes the canonical image row while the authored source/canonical streams
// are already permanently diverged. Generic visible mapping cannot own this:
// image atoms contribute zero visible characters and a long document can have
// unrelated earlier divergence. Claim only the exact final-image deletion.
export const preserveDivergedTailImageDelete = ({ source, previous, next }) => {
  const sourceText = String(source || '')
  const previousText = String(previous || '')
  const nextText = String(next || '')
  if (!sourceText || !previousText || previousText === nextText) return null

  const stripTrailingLineEndings = (value) => String(value || '').replace(/(?:\r\n|\r|\n)+$/, '')
  const lastNonBlankIndex = (lines) => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].text.trim()) return index
    }
    return -1
  }
  const previousLines = markdownLines(previousText)
  const previousImageIndex = lastNonBlankIndex(previousLines)
  if (previousImageIndex < 1) return null
  const previousImageLine = previousLines[previousImageIndex]
  const imageToken = previousImageLine.text.trim()
  if (!imageToken.startsWith('![') || !imageToken.includes('](') || !imageToken.endsWith(')')) {
    return null
  }

  // Removing this one final row must explain the complete canonical change.
  // Do not ignore blank-line edits in the middle of the document; only terminal
  // line-ending count is serializer-owned formatting here.
  if (
    stripTrailingLineEndings(previousText.slice(0, previousImageLine.start)) !==
    stripTrailingLineEndings(nextText)
  ) return null

  let previousAnchorIndex = previousImageIndex - 1
  while (previousAnchorIndex >= 0 && !previousLines[previousAnchorIndex].text.trim()) {
    previousAnchorIndex -= 1
  }
  if (previousAnchorIndex < 0) return null
  const previousAnchorVisible = sourceVisibleIndex(previousLines[previousAnchorIndex].text).text.trim()
  if (!previousAnchorVisible) return null

  const sourceLines = markdownLines(sourceText)
  const sourceMatches = sourceLines.filter((line) => line.text.trim() === imageToken)
  if (sourceMatches.length !== 1) return null
  const sourceImageLine = sourceMatches[0]
  if (sourceLines[lastNonBlankIndex(sourceLines)]?.start !== sourceImageLine.start) return null

  const sourceImageIndex = sourceLines.findIndex((line) => line.start === sourceImageLine.start)
  let sourceAnchorIndex = sourceImageIndex - 1
  while (sourceAnchorIndex >= 0 && !sourceLines[sourceAnchorIndex].text.trim()) {
    sourceAnchorIndex -= 1
  }
  if (sourceAnchorIndex < 0) return null
  if (
    sourceVisibleIndex(sourceLines[sourceAnchorIndex].text).text.trim() !== previousAnchorVisible
  ) return null

  const followingEol = sourceText.slice(sourceImageLine.end).match(/^(?:\r\n|\r|\n)/)?.[0] || ''
  const removeEnd = sourceImageLine.end + followingEol.length
  return {
    markdown: sourceText.slice(0, sourceImageLine.start) + sourceText.slice(removeEnd),
    preserved: true,
    reason: 'diverged-tail-image-delete'
  }
}

// A deletion that spans several canonical blocks (a whole tail, or rows from
// several list trees) inside a diverged document defeats every localized
// mapper above and previously rolled back to the OLD source — the deletion
// silently vanished and saving resurrected the content. When the edit is a
// pure visible-text deletion, anchor the canonical's pre-deletion context in
// the authored visible stream (unique occurrence required) and delete the
// mapped raw range. The deleted raw text must match the canonical deletion
// after list markers are stripped; anything else stays fail-closed.
export const preserveDivergedVisibleDelete = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  // Pure deletion only: the replacement must carry no visible text.
  const replacement = next.slice(start, nextEnd)
  if (sourceVisibleIndex(replacement).text) return null

  const prevVis = sourceVisibleIndex(previous).text
  const srcVis = sourceVisibleIndex(source).text
  if (!prevVis || prevVis === srcVis) return null

  const vStart = sourceVisiblePositionAtRaw(previous, start).visibleIndex
  const vEnd = sourceVisiblePositionAtRaw(previous, previousEnd).visibleIndex
  if (vEnd <= vStart) return null
  const delVis = prevVis.slice(vStart, vEnd)
  if (!delVis) return null

  const CTX = 24
  const ctxBefore = prevVis.slice(Math.max(0, vStart - CTX), vStart)
  if (!ctxBefore) return null
  const anchorBefore = srcVis.indexOf(ctxBefore)
  if (anchorBefore < 0) return null
  if (srcVis.indexOf(ctxBefore, anchorBefore + 1) >= 0) return null

  const deleteStartVis = anchorBefore + ctxBefore.length
  let deleteEndVis
  if (vEnd >= prevVis.length) {
    deleteEndVis = srcVis.length
  } else {
    const ctxAfter = prevVis.slice(vEnd, Math.min(prevVis.length, vEnd + CTX))
    if (!ctxAfter) return null
    const anchorAfter = srcVis.indexOf(ctxAfter, deleteStartVis)
    if (anchorAfter < 0) return null
    deleteEndVis = anchorAfter
  }

  const rawStart = rawOffsetAtVisible(source, {
    visibleIndex: deleteStartVis,
    visibleAffinity: 'backward'
  })
  const rawEnd = rawOffsetAtVisible(source, {
    visibleIndex: deleteEndVis,
    visibleAffinity: 'forward'
  })
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart > rawEnd) return null

  // Verify the raw range actually deletes what the canonical deleted (after
  // list markers are stripped — the canonical keeps them as syntax while the
  // authored source keeps them as item text).
  const stripMarkers = (text) => String(text || '')
    .split('\n')
    .map((line) => line.replace(/^[ \t]*(?:[-+*][ \t]+)?(?:\d{1,9}[.)][ \t]+)?/, ''))
    .join('\n')
  const deletedRawVis = sourceVisibleIndex(stripMarkers(source.slice(rawStart, rawEnd))).text
  if (deletedRawVis !== delVis) return null

  return {
    markdown: source.slice(0, rawStart) + source.slice(rawEnd),
    preserved: true,
    reason: 'diverged-visible-delete'
  }
}

const escapePunctuation = /[\\`*{}\[\]()#+\-.!_>~|]/

// Convert a canonical block's escaped spelling back to the plain Markdown the
// author would have typed (`\*` → `*`, `&#x20;` → ` `, `&amp;` → `&`). This
// is the source-spelling twin used only to locate the authored block and to
// spell the replacement; unescapable text is left verbatim.
const unescapeCanonicalBlock = (value) => String(value || '')
  .replace(new RegExp(`\\\\(${escapePunctuation.source})`, 'g'), '$1')
  .replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, name) => {
    if (name.startsWith('#')) {
      try {
        const code = name[1].toLowerCase() === 'x'
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10)
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    return decodeNamedCharacterReference(name) || match
  })

export const visibleLineEntries = (markdown) => markdownLines(markdown)
  .map((line) => ({
    ...line,
    visible: sourceVisibleIndex(line.text).text.trim()
  }))
  .filter((line) => line.visible)

export const sameVisibleLines = (left, right) =>
  left.length === right.length &&
  left.every((line, index) => line.visible === right[index].visible)

const sourceLineRegionFromCanonical = (source, previous, previousRegion) => {
  const sourceLines = visibleLineEntries(source)
  const previousLines = visibleLineEntries(previous)
  if (!sameVisibleLines(sourceLines, previousLines)) return null

  const touched = []
  previousLines.forEach((line, index) => {
    if (line.end >= previousRegion.start && line.start <= previousRegion.end) touched.push(index)
  })

  if (touched.length) {
    const first = sourceLines[touched[0]]
    const last = sourceLines[touched[touched.length - 1]]
    return {
      start: lineAt(source, first.start).start,
      end: lineAt(source, last.end).end
    }
  }

  const before = previousLines.reduce(
    (found, line, index) => line.end < previousRegion.start ? index : found,
    -1
  )
  const after = previousLines.findIndex((line) => line.start > previousRegion.end)
  const start = before >= 0
    ? lineAt(source, sourceLines[before].end).end
    : 0
  const end = after >= 0
    ? lineAt(source, sourceLines[after].start).start
    : source.length
  return { start, end }
}

// Structural edits have no visible-character span. Replace only the touched
// authored lines and keep the complete-document serializer out of this path.
export const preserveChangedLineRegion = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd,
  reason,
  transformReplacement = (value) => value
}) => {
  const previousRegion = lineRegion(previous, start, previousEnd)
  const nextRegion = lineRegion(next, start, nextEnd)
  const startVisible = sourceVisiblePositionAtRaw(previous, previousRegion.start)
  const endVisible = sourceVisiblePositionAtRaw(previous, previousRegion.end)
  const sourceStartRaw = sourceRawFromVisibleIndex(source, startVisible.visibleIndex, 'forward')
  const sourceEndRaw = sourceRawFromVisibleIndex(source, endVisible.visibleIndex, 'backward')
  let sourceRegion = Number.isFinite(sourceStartRaw) && Number.isFinite(sourceEndRaw)
    ? {
        start: lineAt(source, sourceStartRaw).start,
        end: lineAt(source, sourceEndRaw).end
      }
    : null
  const previousText = sourceVisibleIndex(previous.slice(previousRegion.start, previousRegion.end)).text
  const sourceText = sourceRegion
    ? sourceVisibleIndex(source.slice(sourceRegion.start, sourceRegion.end)).text
    : null
  if (!sourceRegion || sourceText !== previousText) {
    sourceRegion = sourceLineRegionFromCanonical(source, previous, previousRegion)
  }
  // A zero-width change on a line boundary (an empty trailing line or a blank
  // separator between blocks) maps ambiguously: the visible-index fallback
  // pulls the region into the previous line and glues a newly inserted block
  // (list/quote/heading) onto it. When the change is a pure insertion at an
  // authored empty line, the source region is exactly that empty line.
  if (
    sourceRegion &&
    previousRegion.start === previousRegion.end &&
    (previousRegion.start === previous.length ||
      lineAt(previous, previousRegion.start).start === previousRegion.start)
  ) {
    const boundary = lineAt(source, Math.min(previousRegion.start, source.length))
    if (boundary.start === previousRegion.start || previousRegion.start >= source.length) {
      sourceRegion = { start: previousRegion.start, end: previousRegion.start }
    }
  }
  if (!sourceRegion) return null

  let replacementText = transformReplacement(next.slice(nextRegion.start, nextRegion.end))
  // Tail zero-width insertion: canonical ends with a blank separator before a
  // new block (`\n\n`), but the authored file may end with a single line
  // ending (user style). Splicing the replacement directly would glue the new
  // block onto the previous authored line (`测试\n1. `), which then breaks
  // every later list skeleton comparison and fail-closes saves. Restore the
  // blank separator when the canonical insertion point sits after a blank
  // separator at the document end and the authored tail lacks it.
  if (
    sourceRegion.start === sourceRegion.end &&
    sourceRegion.start >= source.length &&
    !source.endsWith('\n\n') &&
    !replacementText.startsWith('\n') &&
    /\n\n$/.test(previous.slice(0, previousRegion.start))
  ) {
    replacementText = '\n' + replacementText
  }

  return {
    markdown: source.slice(0, sourceRegion.start) +
      adaptCanonicalRegionToSource(
        replacementText,
        source,
        sourceRegion
      ) +
      source.slice(sourceRegion.end),
    preserved: true,
    reason
  }
}

// RS-75: two adjacent empty list items have no visible body text, so a
// visible-line comparator can mistake "final body became empty" for "final row
// disappeared". Raw tail identity decides ownership before the broad tail
// delete proof runs. Exact marker token/spacing is intentional: `1.` and `1)`
// are distinct authored slots even when their visible bodies are both empty.
const sameTailListSlotBodyEmptied = (previous, next) => {
  const rawTailSlot = (value) => {
    const body = String(value || '').replace(/(?:\r?\n)+$/, '')
    const lineStart = body.lastIndexOf('\n') + 1
    let line = body.slice(lineStart)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    return { prefix: body.slice(0, lineStart), line }
  }
  const listTailSlot = (line) => String(line || '').match(
    /^(\s*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/
  )
  const emptyListBody = (body) => {
    const text = String(body || '').trim()
    return text === '' || /^<br\s*\/?>$/i.test(text)
  }

  const previousTail = rawTailSlot(previous)
  const nextTail = rawTailSlot(next)
  if (previousTail.prefix !== nextTail.prefix || previousTail.line === nextTail.line) return false

  const previousSlot = listTailSlot(previousTail.line)
  const nextSlot = listTailSlot(nextTail.line)
  return Boolean(
    previousSlot &&
    nextSlot &&
    previousSlot[1] === nextSlot[1] &&
    previousSlot[2] === nextSlot[2] &&
    previousSlot[3] === nextSlot[3] &&
    !emptyListBody(previousSlot[4]) &&
    emptyListBody(nextSlot[4])
  )
}

// Deeply diverged documents (unclosed backticks, escaped markers, zero-width
// sentinels) fail every full-document visible-stream mapper. Typing at the
// document end in such a file frequently folds the typed block into the
// canonical final line (an input rule merges a typed `1. ` with a trailing
// authored `2` paragraph into `21. …`, then list rows continue), while the
// authored source still ends with that plain line.
//
// When the whole change lives in the final canonical block, the authored
// source's final line has the same inline text as the canonical pre-edit line
// (spelling may differ in backtick runs), and the canonical post-edit final
// line starts with that pre-edit line, splice the typed continuation onto the
// authored line and append the remaining canonical rows verbatim. The user's
// bytes survive and a reopen renders the same content.
export const preserveDivergedTailBlockAppend = ({
  source,
  previous,
  next,
  start,
  nextEnd
}) => {
  // No hard `nextEnd`-to-end guard here: commonChange's shared suffix can
  // legitimately include a closing fence row (a ` ``` ` -> ` ```` ` extension
  // shares the trailing three ticks), so `nextEnd` may sit well before the end
  // of a genuinely tail edit. The anchor checks below (start must fall on or
  // after the last visible line) are the strict tail-only gate.
  if (previous.slice(0, start) !== next.slice(0, start)) return null
  const stripBacktickSpans = (value) => value.replace(/`+([^`]+)`+/g, '$1')
  // Compare the final non-empty line of the canonical pre-edit document with
  // the authored source's final non-empty line (spelling may differ in
  // backtick runs). Canonical often carries a trailing blank line that the
  // authored source does not.
  const lastVisibleLine = (value, offset = 0) => {
    const body = value.replace(/\r?\n$/, '')
    const lines = body.split('\n')
    let skipped = 0
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const text = lines[index]
      // Empty list items (`23. <br />` in canonical, `- ` in authored source)
      // carry no visible text but are still the anchor a continuation fills.
      // Only pure blank lines and standalone `<br />` placeholders are skipped.
      const content = text.replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s*(?:\[[ xX]\]\s*)?/, '')
      const isBrPlaceholder = !/^\s*(?:[-+*]|\d{1,9}[.)])\s/.test(text) &&
        /^<br\s*\/?>\s*$/.test(content.trim())
      if (
        (content.trim() && !isBrPlaceholder) ||
        /^\s*(?:[-+*]|\d{1,9}[.)])\s*$/.test(text)
      ) {
        if (skipped < offset) {
          skipped += 1
          continue
        }
        let start = 0
        for (let before = 0; before < index; before += 1) start += lines[before].length + 1
        return { text, start }
      }
    }
    return null
  }
  // A complete paired fence block: the first non-empty line opens a fence
  // (optionally with an info string), the last non-empty line is a bare
  // closing fence of the same character run, and no inner line can close it
  // early. Blank lines inside the fence are legal content.
  const isCompleteFenceBlock = (value) => {
    const body = String(value || '').replace(/\r?\n$/, '')
    const lines = body.split('\n').filter((line) => line.trim() !== '')
    if (lines.length < 2) return false
    const open = lines[0].match(/^\s*(`{3,}|~{3,})/)
    if (!open) return false
    const close = lines[lines.length - 1].match(/^\s*(`{3,}|~{3,})\s*$/)
    if (!close || close[1][0] !== open[1][0] || close[1].length < open[1].length) return false
    for (let index = 1; index < lines.length - 1; index += 1) {
      const inner = lines[index].match(/^\s*(`{3,}|~{3,})\s*$/)
      if (inner && inner[1][0] === open[1][0] && inner[1].length >= open[1].length) return false
    }
    return true
  }
  let previousAnchor = lastVisibleLine(previous)
  let sourceAnchor = lastVisibleLine(source)
  let previousLine = previousAnchor?.text
  let sourceLine = sourceAnchor?.text
  if (!previousLine || !sourceLine || !previousAnchor || !sourceAnchor) return null
  // List markers are semantically interchangeable (`-`/`+`/`*` bullets,
  // `1.`/`1)` ordered). Diverged documents frequently spell the same row
  // differently in source vs canonical; the tail anchor must treat those as
  // equal or the precise tail mapper gives up and a line-region mapper glues
  // the typed row onto the previous authored line.
  const markerNormalized = (line) => String(line || '')
    .replace(/^(\s*)[-+*](?=\s)/, (match, ws) => `${ws}*`)
    .replace(/^(\s*)(\d{1,9})[.)](?=\s)/, (match, ws, num) => `${ws}${num}.`)
    .replace(/&#x20;/g, ' ')
    // remark escapes a literal pipe in list text so it cannot be reparsed as
    // table syntax. The authored source may keep the literal `|`; normalize
    // only this serializer escape for tail-anchor comparison.
    .replace(/\\\|/g, '|')
    .replace(/\u200B/g, '')
    // Crepe represents an empty trailing list item as `* <br />`, while the
    // authored source keeps the same slot as `-`/`1. `. They are the same
    // zero-visible tail anchor; retaining the placeholder would make a code
    // fence typed after that item look like an unmapped divergence.
    .replace(/<br\s*\/?>/gi, '')
  const equivalentLine = (left, right) =>
    markerNormalized(stripBacktickSpans(left.trimEnd())) ===
    markerNormalized(stripBacktickSpans(right.trimEnd()))
  // A file whose authored tail is a lone fence line (` ``` `) keeps that line
  // as literal text in canonical (`\`\`\``). Hand-typing a code block after
  // it makes the input rule absorb the canonical literal into a real fenced
  // block, so the canonical tail anchor (`\`\`\``) no longer exists. The
  // authored lone fence line becomes the block's opening fence; fall back to
  // the previous visible line and let the fresh-row path reuse the authored
  // fence line below.
  // Canonical escapes a lone literal fence line per backtick (`\`` + `\`` +
  // `\``), so the literal is `\`\`\``, not one backslash before three ticks.
  const escapedFenceLiteral = (line) => /^\s*(?:\\`){3}\s*$/.test(String(line || ''))
  const loneFenceLine = (line) => /^\s*(?:`{3,}|~{3,})\s*$/.test(String(line || ''))
  const nextTailStartsFence = (() => {
    const tail = String(next || '').replace(/\r?\n$/, '')
    const tailLines = tail.split('\n')
    for (let index = tailLines.length - 1; index >= 0; index -= 1) {
      const text = tailLines[index].trim()
      if (text) return /^(?:`{3,}|~{3,})/.test(text)
    }
    return false
  })()
  if (
    !equivalentLine(sourceLine, previousLine) &&
    escapedFenceLiteral(previousLine) &&
    loneFenceLine(sourceLine) &&
    nextTailStartsFence
  ) {
    const fallbackPrevious = lastVisibleLine(previous, 1)
    const fallbackSource = lastVisibleLine(source, 1)
    if (
      fallbackPrevious &&
      fallbackSource &&
      equivalentLine(fallbackSource.text, fallbackPrevious.text)
    ) {
      previousAnchor = fallbackPrevious
      sourceAnchor = fallbackSource
      previousLine = fallbackPrevious.text
      sourceLine = fallbackSource.text
    }
  }
  if (!equivalentLine(sourceLine, previousLine)) return null
  const previousLineStart = previousAnchor.start
  // The canonical line at the change start continues the pre-edit line
  // (an input rule may fold the typed marker into it: `2` + `1. …` = `21. …`).
  const nextLineStart = next.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const nextLineEnd = next.indexOf('\n', start)
  const nextLineAtStart = nextLineEnd < 0
    ? next.slice(nextLineStart)
    : next.slice(nextLineStart, nextLineEnd)
  const foldCase = start >= previousLineStart &&
    markerNormalized(nextLineAtStart).startsWith(markerNormalized(previousLine)) &&
    nextLineAtStart.length > previousLine.length
  // RS-62: visible-line extraction can skip a punctuation-only raw tail row
  // entirely (`-[ ] `, `-[] `, escaped literals, etc.). When that hidden raw
  // final row is edited in place, the visible anchor remains the predecessor,
  // which otherwise makes the changed row look like a brand-new row appended
  // after the anchor. Prove raw slot identity first: if previous and next have
  // the same prefix up to their final content row and only that row changed,
  // this is an existing-tail-line edit, never a fresh-row append. Dedicated
  // line mappers can then preserve the authored spelling without duplicating
  // the old row plus the edited row.
  const rawTailSlot = (value) => {
    const body = String(value || '').replace(/(?:\r?\n)+$/, '')
    const lineStart = body.lastIndexOf('\n') + 1
    let line = body.slice(lineStart)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    return { prefix: body.slice(0, lineStart), line }
  }
  const previousRawTailSlot = rawTailSlot(previous)
  const nextRawTailSlot = rawTailSlot(next)
  const rawTailEditedInPlace =
    previousRawTailSlot.prefix === nextRawTailSlot.prefix &&
    previousRawTailSlot.line !== nextRawTailSlot.line
  const freshRowCase = !rawTailEditedInPlace &&
    start > previousLineStart + previousLine.length &&
    !nextLineAtStart.startsWith(previousLine)
  // The canonical final line itself was deleted (a trailing list row or a
  // typed paragraph). The authored source must drop its matching final line.
  const previousLineCount = previous.split('\n').filter((line) => line === previousLine).length
  const nextLineCount = next.split('\n').filter((line) => line === previousLine).length
  const nextTailLine = lastVisibleLine(next)?.text
  // After the trailing row is deleted, canonical's new final line is the row
  // that was IMMEDIATELY before it (the predecessor). Verifying that specific
  // predecessor distinguishes a real deletion from a *replacement*: typing
  // `-` + Space replaces a literal `\-` row with a new `* ` bullet item, and
  // the new tail (`* `) can spuriously match an unrelated empty bullet item
  // elsewhere in the document if we accept any equivalent line. Only the
  // immediate predecessor may satisfy the deletion proof.
  const previousPredecessorLine = lastVisibleLine(previous, 1)?.text
  // RS-61: visible-line extraction can intentionally erase punctuation-only
  // rows. For example a literal paragraph `-[ ] ` has no visible text after
  // Markdown syntax stripping, even though the raw canonical row still exists.
  // If the previous spelling was protected (`-\\[ ]`) and the serializer drops
  // that escape on the next Space, visible-only deletion proof would think the
  // predecessor became the new tail and delete the whole paragraph. Inspect the
  // raw final content row too: a real deletion may leave only the predecessor,
  // blank whitespace, or Crepe's editor-owned `<br />`; any other raw row is a
  // replacement/edit and must fall through to the line-region mapper.
  const nextRawTailLine = next.split('\n')
    .reverse()
    .map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
    .find((line) => line.length > 0) || ''
  const rawTailAllowsDeletion =
    nextRawTailLine.trim() === '' ||
    /^\s*<br\s*\/?>\s*$/i.test(nextRawTailLine) ||
    (
      previousPredecessorLine !== undefined &&
      equivalentLine(previousPredecessorLine, nextRawTailLine)
    )
  const deleteCase = !sameTailListSlotBodyEmptied(previous, next) &&
    start >= previousLineStart &&
    nextLineCount < previousLineCount &&
    nextLineCount === 0 &&
    // A deleted trailing row leaves the previous authored row as canonical's
    // new final line. A *replaced* row (`\`` -> `` `f` ``) changes spelling
    // instead, and must go through the fold path, not deletion.
    !!nextTailLine &&
    rawTailAllowsDeletion &&
    (
      nextTailLine.trim() === '' ||
      (
        previousPredecessorLine !== undefined &&
        equivalentLine(previousPredecessorLine, nextTailLine)
      )
    )
  // Fence extension: the user types a fence row inside a tail fenced block, so
  // Crepe re-fences the whole block with a longer run (` ``` ` -> ` ```` `) and
  // the typed row becomes content. previous and next share the opening fence
  // position; only the fence lengths and content rows differ. Replacing the
  // authored tail fence segment with canonical's is byte-safe here because the
  // content rows are proven visible-equal and canonicalFreshTextToSource keeps
  // fence-interior rows verbatim.
  const lastFenceSegment = (value) => {
    const body = String(value || '').replace(/\r?\n$/, '')
    const lines = body.split('\n')
    let fence = null
    let openIndex = -1
    let openStart = -1
    let openLen = 0
    let last = null
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index]
      if (fence) {
        const close = text.match(/^\s*(`{3,}|~{3,})\s*$/)
        if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
          let closeStart = 0
          for (let before = 0; before < index; before += 1) closeStart += lines[before].length + 1
          last = {
            openStart,
            openLen,
            openEnd: openStart + lines[openIndex].length,
            closeStart,
            closeEnd: closeStart + text.length
          }
          fence = null
          openIndex = -1
        }
      } else {
        const open = text.match(/^\s*(`{3,}|~{3,})/)
        if (open) {
          fence = { char: open[1][0], length: open[1].length }
          openIndex = index
          let startOffset = 0
          for (let before = 0; before < index; before += 1) startOffset += lines[before].length + 1
          openStart = startOffset
          openLen = open[1].length
        }
      }
    }
    return last
  }
  const prevSeg = lastFenceSegment(previous)
  const nextSeg = lastFenceSegment(next)
  if (
    prevSeg &&
    nextSeg &&
    start >= prevSeg.openStart &&
    start <= prevSeg.openEnd &&
    nextSeg.openLen > prevSeg.openLen &&
    nextSeg.openStart === prevSeg.openStart
  ) {
    const srcSeg = lastFenceSegment(source)
    if (srcSeg) {
      const prevContent = previous.slice(prevSeg.openEnd, prevSeg.closeStart)
      const srcContent = source.slice(srcSeg.openEnd, srcSeg.closeStart)
      if (sourceVisibleIndex(srcContent).text === sourceVisibleIndex(prevContent).text) {
        const nextSegment = next.slice(nextSeg.openStart, nextSeg.closeEnd)
        return {
          markdown: source.slice(0, srcSeg.openStart) +
            canonicalFreshTextToSource(nextSegment) +
            source.slice(srcSeg.closeEnd),
          preserved: true,
          reason: 'diverged-tail-fence-extend'
        }
      }
    }
  }
  let continuation = ''
  let remaining = ''
  let keepTailBreaks = false
  let fenceBlockCase = false
  if (foldCase) {
    // The canonical row spells leading content spaces as `&#x20;` (one char
    // each) while the authored row keeps them literal, and wraps inline code
    // in backtick spans, so a byte slice at `previousLine.length` can cut
    // through an entity or a span and leak `0;`-style fragments. Split both
    // rows into normalized single-character units (an `&#x20;` entity is one
    // space unit, a backtick span contributes its inner characters) and
    // locate the end of the equivalent prefix by raw offset.
    const normUnits = (line) => {
      const units = []
      let index = 0
      while (index < line.length) {
        if (line.startsWith('&#x20;', index)) {
          units.push({ rawStart: index, rawLen: 6, ch: ' ' })
          index += 6
          continue
        }
        if (line[index] === '`') {
          const span = line.slice(index).match(/^`+([^`]+)`+/)
          if (span) {
            const innerStart = index + span[0].length - span[1].length
            let pos = 0
            for (const ch of span[1]) {
              units.push({ rawStart: innerStart + pos, rawLen: 1, ch })
              pos += 1
            }
            index += span[0].length
            continue
          }
          units.push({ rawStart: index, rawLen: 1, ch: line[index] })
          index += 1
          continue
        }
        units.push({ rawStart: index, rawLen: 1, ch: line[index] })
        index += 1
      }
      return units
    }
    const prevUnits = normUnits(previousLine)
    const nextUnits = normUnits(nextLineAtStart)
    const unitEqual = (left, right) => left === right ||
      (/^[-+*]$/.test(left) && /^[-+*]$/.test(right)) ||
      (/^[.)]$/.test(left) && /^[.)]$/.test(right))
    let matchLen = 0
    while (
      matchLen < prevUnits.length &&
      matchLen < nextUnits.length &&
      unitEqual(prevUnits[matchLen].ch, nextUnits[matchLen].ch)
    ) {
      matchLen += 1
    }
    const continuationStart = matchLen >= prevUnits.length
      ? (nextUnits[prevUnits.length]?.rawStart ?? nextLineAtStart.length)
      : previousLine.length
    continuation = nextLineAtStart.slice(continuationStart)
    if (!continuation || /[\r\n]/.test(continuation)) return null
    remaining = nextLineEnd < 0 ? '' : next.slice(nextLineEnd)
  } else if (freshRowCase) {
    // Typing inside an existing tail fenced block: canonical grows content
    // rows between a paired open/close fence. The last visible line is the
    // CLOSING fence, so anchoring there would drop the new content rows.
    // Anchor on the opening fence (previous second-to-last visible line),
    // reuse the authored open AND close fence lines and insert only the new
    // canonical content rows between them.
    const prevLastLine = lastVisibleLine(previous)
    const prevSecondLastLine = lastVisibleLine(previous, 1)
    // A tail EMPTY fence pair (opening line directly followed by the closing
    // line) is the only safe "typing inside a new tail code block" anchor. A
    // non-empty block whose content happens to end with a fence-like row must
    // not be treated as an empty pair, so validate with a fence state machine
    // instead of pattern-matching the last two visible lines.
    const tailEmptyFencePair = (value) => {
      const body = String(value || '').replace(/\r?\n$/, '')
      const lines = body.split('\n')
      let fence = null
      let openIndex = -1
      let pairOpen = -1
      let pairClose = -1
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index]
        if (fence) {
          const close = text.match(/^\s*(`{3,}|~{3,})\s*$/)
          if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
            if (openIndex === index - 1) {
              pairOpen = openIndex
              pairClose = index
            }
            fence = null
            openIndex = -1
          }
        } else {
          const open = text.match(/^\s*(`{3,}|~{3,})/)
          if (open) {
            fence = { char: open[1][0], length: open[1].length }
            openIndex = index
          }
        }
      }
      return pairOpen >= 0 ? { openIndex: pairOpen, closeIndex: pairClose } : null
    }
    const prevTailPair = tailEmptyFencePair(previous)
    const prevTailIsPairedFence = !!prevTailPair && !!prevLastLine && !!prevSecondLastLine &&
      /^\s*(?:`{3,}|~{3,})\s*$/.test(prevLastLine.text) &&
      /^\s*(?:`{3,}|~{3,})\s*$/.test(prevSecondLastLine.text)
    if (prevTailIsPairedFence) {
      const srcLastLine = lastVisibleLine(source)
      const srcSecondLastLine = lastVisibleLine(source, 1)
      const srcTailPair = tailEmptyFencePair(source)
      if (
        !srcTailPair || !srcLastLine || !srcSecondLastLine ||
        !/^\s*(?:`{3,}|~{3,})\s*$/.test(srcLastLine.text) ||
        !/^\s*(?:`{3,}|~{3,})\s*$/.test(srcSecondLastLine.text)
      ) {
        return null
      }
      const sourceFenceOpenStart = srcSecondLastLine.start
      const sourceFenceOpenText = srcSecondLastLine.text
      // The canonical opening fence shares the previous raw offset (the common
      // prefix includes it; the delta starts after it).
      let fenceOpenEnd = next.indexOf('\n', prevSecondLastLine.start)
      if (fenceOpenEnd < 0) fenceOpenEnd = next.length
      remaining = next.slice(fenceOpenEnd)
      // Keep the authored closing fence; strip canonical's closing fence line
      // and its terminal padding from the appended content rows.
      const parts = remaining.split('\n')
      let lastNonEmpty = -1
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (parts[index].trim()) {
          lastNonEmpty = index
          break
        }
      }
      if (lastNonEmpty < 0) return null
      let closeStart = 0
      for (let before = 0; before < lastNonEmpty; before += 1) {
        closeStart += parts[before].length + 1
      }
      const contentRows = remaining.slice(0, closeStart).replace(/^\n+/, '')
      if (!/\S/.test(String(contentRows).replace(/<br\s*\/?>/gi, ''))) return null
      if (/^\s*<br\s*\/?>\s*$/m.test(contentRows)) return null
      const sourceTail = source.slice(sourceFenceOpenStart + sourceFenceOpenText.length)
      return {
        markdown: source.slice(0, sourceFenceOpenStart) + sourceFenceOpenText +
          '\n' + canonicalFreshTextToSource(contentRows) +
          sourceTail.replace(/^\n/, ''),
        preserved: true,
        reason: 'diverged-tail-fence-content'
      }
    }
    // Everything after the anchor line in canonical (empty items, blanks and
    // the newly typed rows) is appended verbatim after the authored anchor.
    const nextLines = next.split('\n')
    let anchorInNext = -1
    for (let index = nextLines.length - 1; index >= 0; index -= 1) {
      if (equivalentLine(nextLines[index], previousLine)) {
        let offset = 0
        for (let before = 0; before < index; before += 1) offset += nextLines[before].length + 1
        anchorInNext = offset + nextLines[index].length
        break
      }
    }
    if (anchorInNext < 0) return null
    remaining = next.slice(anchorInNext)
    // A hand-typed fenced code block serializes as an opening fence, content
    // rows and a closing fence. Complete paired fences are self-contained tail
    // blocks; the structural guard below must not refuse them. When the
    // authored tail already ends with a lone fence line (a leftover unclosed
    // fence), that line becomes the block's opening fence and canonical's
    // opening line is skipped so the authored file does not gain a duplicate.
    fenceBlockCase = isCompleteFenceBlock(remaining)
    if (fenceBlockCase) {
      const sourceTrailFirstLine = source.slice(sourceAnchor.start + sourceLine.length)
        .split('\n').find((line) => line.trim() !== '')
      if (sourceTrailFirstLine && /^\s*(?:`{3,}|~{3,})/.test(sourceTrailFirstLine)) {
        const parts = remaining.split('\n')
        const firstNonEmpty = parts.findIndex((line) => line.trim() !== '')
        if (firstNonEmpty >= 0 && /^\s*(?:`{3,}|~{3,})/.test(parts[firstNonEmpty])) {
          parts.splice(firstNonEmpty, 1)
          remaining = parts.join('\n')
        }
      }
    }
    // Enter inside an authored list continues the same list. Canonical may
    // serialize the new row with Crepe's default marker and a loose blank
    // line (`* 第二项` after `- 第一项`). On diverged documents the list
    // mappers cannot align the continuation, so this tail mapper restores
    // the authored marker and compact spacing itself. Genuinely new
    // nested/outer blocks (different indentation or list type) keep their
    // canonical spelling.
    const authoredMarker = sourceLine.match(/^(\s*)([-+*]|\d{1,9}[.)])(?=\s)/)
    const firstRemaining = remaining.split('\n').find((line) => line.trim())
    // A brand-new list created after a plain paragraph/heading is normally
    // owned by the input-rule intent mapper (it restores the typed marker,
    // `-` instead of Crepe's `*`). On deeply diverged documents that mapper
    // can fail closed (no source slot hint), and every fallback below glues
    // the new row onto the authored paragraph. Append the canonical block
    // structurally here; the intent mapper still runs afterwards on the flush
    // chain and restores the marker when it can, so this is a safe floor.
    const firstIndent = firstRemaining?.match(/^\s*/)?.[0] || ''
    const firstMarker = firstRemaining?.trim().match(/^(?:[-+*]|\d{1,9}[.)])/)?.[0] || ''
    const sameListType = /^\d/.test(authoredMarker?.[2] || '') === /^\d/.test(firstMarker)
    const sourceTailBreaks = source.slice(sourceAnchor.start + sourceLine.length)
    const sourceTailBreakCount = (sourceTailBreaks.match(/\n/g) || []).length
    const tailEol = lineEndingNear(source, source.length)
    const previousEndsInEmptyParagraph =
      /(?:^|\r?\n)[ \t]*<br\s*\/?>[ \t]*(?:(?:\r?\n)+)?$/i.test(previous)
    const continuedSameList = !!(authoredMarker &&
      firstRemaining &&
      (sourceTailBreakCount < 2 || !previousEndsInEmptyParagraph) &&
      firstIndent === authoredMarker[1] &&
      sameListType &&
      /^[-+*]|\d{1,9}[.)]/.test(firstRemaining.trim()))
    if (continuedSameList) {
      keepTailBreaks = true
      const authoredToken = authoredMarker[2]
      // On diverged documents the list/input-rule mappers cannot align a
      // same-list continuation, so restore the authored marker and compact
      // spacing here. (Clean documents never reach this branch — it only runs
      // inside the diverged visible-stream path.)
      remaining = remaining.replace(/^\n+/, '\n')
      if (/^\d/.test(authoredToken)) {
        remaining = remaining.replace(/^(\s*\d{1,9})[.)](?=\s)/, `$1${authoredToken.slice(-1)}`)
      } else {
        remaining = remaining.replace(/^(\s*)[-+*](?=\s)/, `$1${authoredToken}`)
      }
    } else {
      // The authored final line may carry trailing blank lines (authored
      // spacing between blocks). Preserve them before the appended rows; a
      // Markdown block boundary needs at least two line endings, so top up
      // when the authored tail has fewer (without inventing trailing blank
      // lines after the appended content — the facade caps that separately).
      remaining = sourceTailBreaks +
        tailEol.repeat(Math.max(0, 2 - sourceTailBreakCount)) +
        remaining.replace(/^\n+/, '')
    }
    // A canonical tail that only grew blank lines (Enter inside an empty
    // trailing block) has no authored content to append; the empty-block
    // mappers own that transition and must not be bypassed.
    // A canonical tail that only grew blank lines or `<br />` placeholders
    // (held Space, Enter inside an empty trailing block) has no authored
    // content to append; the empty-block mappers own those transitions.
    // The final empty ProseMirror paragraph is serialized as a standalone
    // `<br />` after the real appended block. It is not part of the authored
    // block and must not make this structural mapper reject the whole change.
    // Strip only a terminal placeholder suffix; an embedded placeholder still
    // belongs to the dedicated empty-block mapper and remains rejected below.
    remaining = remaining.replace(
      /(?:\r?\n)+[ \t]*<br\s*\/?>[ \t]*(?:(?:\r?\n)+)?$/i,
      '\n'
    )
    if (!/\S/.test(String(remaining).replace(/<br\s*\/?>/gi, ''))) return null
    // A `<br />` placeholder embedded in the appended rows (held-space and
    // empty-block transitions) belongs to the dedicated empty/leading-space
    // mappers, which know how to collapse it; never append it verbatim.
    if (/^\s*<br\s*\/?>\s*$/m.test(remaining)) return null
  } else if (deleteCase) {
    const tailBreaks = source.slice(sourceAnchor.start + sourceLine.length)
    // RS-56: a rapid Backspace on a deepest nested list row can remove that
    // row while ProseMirror lifts its empty paragraph into the parent list
    // item. The canonical tail then ends in an indented standalone `<br />` at
    // the deleted row's content column. The raw row deletion below is already
    // strictly proven by deleteCase; classify only this nested-list shape so
    // generated-scratch integrity can ignore exactly the editor-owned trailing
    // paragraph without granting that exception to every tail-line deletion.
    const sourceListMarker = sourceLine.match(/^(\s*)([-+*]|\d{1,9}[.)])(?=\s)/)
    const previousListMarker = previousLine.match(/^(\s*)([-+*]|\d{1,9}[.)])(?=\s)/)
    const trailingPlaceholder = String(next).match(
      /(?:^|\r?\n)([ \t]*)<br\s*\/?>[ \t]*(?:(?:\r?\n)+)?$/i
    )
    const nestedEmptyListItemRemoved = Boolean(
      sourceListMarker &&
      previousListMarker &&
      previousListMarker[1].length > 0 &&
      trailingPlaceholder &&
      trailingPlaceholder[1].length === previousListMarker[1].length
    )
    // Deleting a leading-space paragraph down to its bare whitespace leaves a
    // blank canonical row (` `); the authored row must shrink to that blank
    // rather than keep the deleted content.
    const blankTail = nextTailLine.trim() === '' ? nextTailLine : ''
    return {
      markdown: source.slice(0, sourceAnchor.start) + blankTail + tailBreaks,
      preserved: true,
      reason: nestedEmptyListItemRemoved
        ? 'nested-empty-list-item-removed'
        : 'diverged-tail-line-delete'
    }
  } else {
    return null
  }
  // Remaining canonical rows must stay plain/list rows; headings and quotes
  // change block structure and are refused. Complete paired fenced blocks
  // were structurally validated above and are the only structural exception.
  if (!fenceBlockCase) {
    // A foldCase fence extension (typing `` ` `` after a ` ``` ` closing row
    // re-fences the block: ` ``` ` -> ` ```` `) leaves the remaining rows as a
    // complete paired fence too. Validate the spliced result structurally
    // instead of refusing the fence rows outright.
    const fenceFoldCase = foldCase && continuation &&
      isCompleteFenceBlock(sourceLine + continuation + remaining)
    if (!fenceFoldCase) {
      for (const line of remaining.split('\n')) {
        if (/^\s*(```|~~~|#{1,6}\s|>)/.test(line)) return null
      }
    }
  }
  // Splice the continuation onto the authored final line, then append the
  // remaining canonical rows.
  const prefix = source.slice(0, sourceAnchor.start)
  // Canonical rows are appended verbatim structurally, but serializer escapes
  // (`\~`, `&#x20;`, leading-space entities) must be translated back to the
  // authored spelling through the same context-aware path every other
  // canonical write uses.
  const normalizedRemaining = keepTailBreaks
    ? remaining
    : remaining.replace(
        /(?:\r?\n)+$/,
        /(?:\r?\n)$/.test(source) ? lineEndingNear(source, source.length) : ''
      )
  const localEol = lineEndingNear(source, source.length)
  const localizeAddedLineEndings = (value) => {
    const text = canonicalFreshTextToSource(value)
    // `lastVisibleLine()` includes the `\r` byte of a CRLF anchor but not its
    // `\n`. Keep that first `\n` paired with the already-copied `\r`; only
    // canonical bytes after the anchor are converted to the local convention.
    if (sourceLine.endsWith('\r') && text.startsWith('\n')) {
      return '\n' + text.slice(1).replace(/\r\n|\r|\n/g, localEol)
    }
    return text.replace(/\r\n|\r|\n/g, localEol)
  }
  const localContinuation = localizeAddedLineEndings(continuation)
  const localRemaining = localizeAddedLineEndings(normalizedRemaining)
  return {
    markdown: prefix + sourceLine +
      localContinuation +
      localRemaining,
    preserved: true,
    reason: 'diverged-tail-block-append'
  }
}
