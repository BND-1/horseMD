import {
  adaptCanonicalRegionToSource,
  lineIndexAt,
  markdownLines
} from './core.js'

// A YAML frontmatter block is an atom in ProseMirror, so changing its attrs
// has no visible-text delta for the generic source-preservation path. Locate
// the exact fenced block by its mapped raw offset and replace only that block.
// This keeps every unrelated paragraph/list spelling intact.
const frontmatterBlockAt = (markdown, offset) => {
  const lines = markdownLines(markdown)
  const index = lineIndexAt(lines, offset)
  if (index < 0) return null
  for (let startIndex = 0; startIndex < lines.length; startIndex++) {
    if (lines[startIndex].text.trim() !== '---') continue
    for (let endIndex = startIndex + 1; endIndex < lines.length; endIndex++) {
      if (lines[endIndex].text.trim() !== '---') continue
      if (index >= startIndex && index <= endIndex) {
        return { start: lines[startIndex].start, end: lines[endIndex].end }
      }
      break
    }
  }
  return null
}

export function replaceMarkdownFrontmatterBlock({ source, next, sourceOffset, nextOffset }) {
  const rawSource = String(source || '')
  const rawNext = String(next || '')
  const sourceBlock = frontmatterBlockAt(rawSource, sourceOffset)
  const nextBlock = frontmatterBlockAt(rawNext, nextOffset)
  if (!sourceBlock || !nextBlock) return null
  const replacement = adaptCanonicalRegionToSource(
    rawNext.slice(nextBlock.start, nextBlock.end),
    rawSource,
    sourceBlock
  )
  return rawSource.slice(0, sourceBlock.start) + replacement + rawSource.slice(sourceBlock.end)
}
