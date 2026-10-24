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

// Keep the first `tiers` actual outline tiers visible (Settings › Editor ›
// outline default level, #122; 2 by default, 0 = everything expanded). With
// tiers = 2 a document with H1 > H2 > H3 opens at H1/H2, while a flat document
// made only of H1 headings remains fully visible. Using hierarchy depth instead
// of level numbers also handles documents that begin at H2 or skip a level.
export const defaultCollapsedHeadings = (headings, tiers = 2) => {
  const collapsed = new Set()
  const limit = Number(tiers)
  if (!Number.isFinite(limit) || limit <= 0) return collapsed
  const depths = headingDepths(headings)
  headings.forEach((_, index) => {
    if (depths[index] >= limit - 1 && headingHasChildren(headings, index)) collapsed.add(index)
  })
  return collapsed
}

// Structural path per heading ("1", "1.2", "1.2.1" …) by hierarchy depth.
// Text edits keep paths stable, so fold choices survive renames (#70).
export const outlineStructure = (headings) => {
  const depths = headingDepths(headings)
  const counters = []
  return headings.map((heading, index) => {
    const depth = depths[index]
    counters.length = depth + 1
    counters[depth] = (counters[depth] || 0) + 1
    for (let i = depth + 1; i < counters.length; i++) counters[i] = 0
    return {
      level: heading.level,
      depth,
      path: counters.slice(0, depth + 1).join('.')
    }
  })
}

// Per-document fold memory entry (#122):
//   { collapsed: Set<path>, known: Set<path>, rest: null | 'expanded' | 'collapsed' }
// `known` paths take their recorded state; any other foldable heading (a
// branch added later, or a document never folded by hand) uses `rest` when an
// "expand all / collapse all" set it, else the default tier rule.
export const resolveCollapsedHeadings = (headings, entry, tiers = 2) => {
  const structure = outlineStructure(headings)
  const defaults = entry?.rest ? null : defaultCollapsedHeadings(headings, tiers)
  const collapsed = new Set()
  headings.forEach((_, index) => {
    if (!headingHasChildren(headings, index)) return
    const path = structure[index].path
    if (entry?.known?.has(path)) {
      if (entry.collapsed.has(path)) collapsed.add(index)
    } else if (entry?.rest === 'collapsed') {
      collapsed.add(index)
    } else if (entry?.rest === 'expanded') {
      // stays open
    } else if (defaults.has(index)) {
      collapsed.add(index)
    }
  })
  return collapsed
}

// Record the fold state the user now sees: every current foldable heading
// becomes known with its state; `rest` from an earlier expand/collapse-all is
// kept for branches that appear later.
export const recordFoldEntry = (headings, collapsedIndices, previous = null) => {
  const structure = outlineStructure(headings)
  const known = new Set(previous?.known || [])
  const collapsed = new Set(previous?.collapsed || [])
  headings.forEach((_, index) => {
    if (!headingHasChildren(headings, index)) return
    const path = structure[index].path
    known.add(path)
    if (collapsedIndices.has(index)) collapsed.add(path)
    else collapsed.delete(path)
  })
  return { collapsed, known, rest: previous?.rest || null }
}

export const expandAllEntry = () => ({ collapsed: new Set(), known: new Set(), rest: 'expanded' })
export const collapseAllEntry = () => ({ collapsed: new Set(), known: new Set(), rest: 'collapsed' })
