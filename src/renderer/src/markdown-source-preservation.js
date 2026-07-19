import {
  sourceRawFromVisibleIndex,
  sourceVisibleIndex,
  sourceVisiblePositionAtRaw
} from './mode-visible-map.js'

const commonChange = (previous, next) => {
  let start = 0
  const min = Math.min(previous.length, next.length)
  while (start < min && previous[start] === next[start]) start++

  let previousEnd = previous.length
  let nextEnd = next.length
  while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) {
    previousEnd--
    nextEnd--
  }
  return { start, previousEnd, nextEnd }
}

const rawOffsetAtVisible = (markdown, position) =>
  sourceRawFromVisibleIndex(markdown, position.visibleIndex, position.visibleAffinity)

// Milkdown serializes the complete document after every rich-text transaction.
// Preserve the user's untouched source spelling by applying the serializer's
// actual delta to the original Markdown, provided both snapshots still expose
// the same visible text stream. Structural-only edits fall back to serialization
// until they have dedicated block-level handling.
export function preserveRichMarkdownSource(source, previousCanonical, nextCanonical) {
  const sourceMarkdown = String(source || '')
  const previous = String(previousCanonical || '')
  const next = String(nextCanonical || '')
  if (previous === next) return { markdown: sourceMarkdown, preserved: true, reason: 'unchanged' }
  if (!sourceMarkdown || !previous) return { markdown: next, preserved: false, reason: 'missing-baseline' }

  const sourceVisible = sourceVisibleIndex(sourceMarkdown)
  const previousVisible = sourceVisibleIndex(previous)
  if (sourceVisible.text !== previousVisible.text) {
    return { markdown: next, preserved: false, reason: 'visible-stream-mismatch' }
  }

  const { start, previousEnd, nextEnd } = commonChange(previous, next)
  const startVisible = sourceVisiblePositionAtRaw(previous, start)
  const endVisible = sourceVisiblePositionAtRaw(previous, previousEnd)
  const replacement = next.slice(start, nextEnd)
  const replacementVisible = sourceVisibleIndex(replacement).text

  // A heading level, a list marker, or blank structure has no visible-text
  // span. Patching it by character position risks inserting syntax inside the
  // wrong raw construct, so retain the canonical result for now.
  if (startVisible.visibleIndex === endVisible.visibleIndex && !replacementVisible) {
    return { markdown: next, preserved: false, reason: 'structural-change' }
  }

  const rawStart = rawOffsetAtVisible(sourceMarkdown, startVisible)
  const rawEnd = rawOffsetAtVisible(sourceMarkdown, endVisible)
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart > rawEnd) {
    return { markdown: next, preserved: false, reason: 'unmapped-change' }
  }

  return {
    markdown: sourceMarkdown.slice(0, rawStart) + replacement + sourceMarkdown.slice(rawEnd),
    preserved: true,
    reason: 'localized-change'
  }
}
