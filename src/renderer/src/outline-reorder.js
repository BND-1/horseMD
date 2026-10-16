import { parseSourceHeadings } from './scrollAnchor.js'

const sectionRange = (markdown, headings, index) => {
  const heading = headings[index]
  if (!heading || !Number.isFinite(heading.charOffset)) return null
  let end = markdown.length
  for (let next = index + 1; next < headings.length; next += 1) {
    if (headings[next].level <= heading.level) {
      end = headings[next].charOffset
      break
    }
  }
  return { start: heading.charOffset, end }
}

const withLineBoundaries = (before, section, after) => {
  let next = section
  if (before && !before.endsWith('\n')) next = '\n' + next
  if (after && !next.endsWith('\n')) next += '\n'
  return next
}

const parentHeadingIndex = (headings, index) => {
  const level = headings[index]?.level
  if (!level || level === 1) return -1
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (headings[cursor].level < level) return cursor
  }
  return -1
}

export const haveSameHeadingParent = (headings, fromIndex, targetIndex) => {
  if (headings[fromIndex]?.level !== headings[targetIndex]?.level) return false
  return parentHeadingIndex(headings, fromIndex) === parentHeadingIndex(headings, targetIndex)
}

// Move one outline heading and its complete descendant section without changing
// Markdown syntax. Only sibling headings are accepted: that keeps the hierarchy
// stable and prevents an accidental drag from reparenting a subsection.
export function moveHeadingSection(markdown, fromIndex, targetIndex, placement = 'before') {
  const source = String(markdown || '')
  const headings = parseSourceHeadings(source)
  const from = headings[fromIndex]
  const target = headings[targetIndex]
  if (!from || !target || fromIndex === targetIndex || !haveSameHeadingParent(headings, fromIndex, targetIndex)) return null

  const movedRange = sectionRange(source, headings, fromIndex)
  const targetRange = sectionRange(source, headings, targetIndex)
  if (!movedRange || !targetRange) return null

  const insertion = placement === 'after' ? targetRange.end : targetRange.start
  if (insertion >= movedRange.start && insertion <= movedRange.end) return null

  const moved = source.slice(movedRange.start, movedRange.end)
  const withoutMoved = source.slice(0, movedRange.start) + source.slice(movedRange.end)
  const adjustedInsertion = insertion > movedRange.start
    ? insertion - (movedRange.end - movedRange.start)
    : insertion
  const before = withoutMoved.slice(0, adjustedInsertion)
  const after = withoutMoved.slice(adjustedInsertion)
  const next = before + withLineBoundaries(before, moved, after) + after
  return next === source ? null : next
}
