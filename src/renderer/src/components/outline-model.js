export const headingHasChildren = (headings, index) => {
  if (index < 0 || index >= headings.length) return false
  const level = headings[index].level
  return index + 1 < headings.length && headings[index + 1].level > level
}

export const headingDepths = (headings) => {
  const stack = []
  return headings.map((heading) => {
    while (stack.length && stack[stack.length - 1] >= heading.level) stack.pop()
    const depth = stack.length
    stack.push(heading.level)
    return depth
  })
}

// Keep the first two actual outline tiers visible. A document with H1 > H2 >
// H3 therefore opens at H1/H2, while a flat document made only of H1 headings
// remains fully visible. Using hierarchy depth instead of level numbers also
// handles documents that begin at H2 or skip a heading level.
export const defaultCollapsedHeadings = (headings) => {
  const depths = headingDepths(headings)
  const collapsed = new Set()
  headings.forEach((_, index) => {
    if (depths[index] >= 1 && headingHasChildren(headings, index)) collapsed.add(index)
  })
  return collapsed
}
