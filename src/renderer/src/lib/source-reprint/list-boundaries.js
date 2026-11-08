// Two ordered lists that sit directly next to each other in the editor (no
// empty paragraph between) are two lists, but `1. a` … `1. b` reads back as
// one: the lower list's numbering continues (its item 1 becomes item 5).
// The reprint keeps authored bytes, so when an edit (a Backspace merge, a
// block move) makes an authored ordered list directly adjacent to another,
// the lower list's delimiter switches (`.`↔`)`; Milkdown's serializer and the
// older writers do the same).
//
// Only that case. Kept as written (Typora: what you type is what is saved):
// - a list the user just typed (`1. ` after a list): its node is new, not in
//   the editor document paired with the source (`test-repeated-ordered-list-
//   middle-ui`, from a user report: `1.` must not become `1)`);
// - a list that was already directly after the other one (the merge was
//   accepted when it was made; later edits leave it alone);
// - bullet lists: merged on reopen, nothing visible changes
//   (`test-isolated-empty-ordered-backspace-lift-ui`);
// - lists separated by an editor-only empty paragraph (RS-86).
// Without the paired document nothing is changed. Where the editor document
// and the source cannot be lined up, nothing is changed and nothing is
// reported (the other checks stand).

const isList = (node) => node?.type?.name === 'bullet_list' || node?.type?.name === 'ordered_list'
const isBlankParagraph = (node) => {
  if (node?.type?.name !== 'paragraph') return false
  // Same rule as reprint.js: only line breaks (no text) is blank too.
  let blank = true
  let hardBreak = false
  let other = false
  node.forEach((child) => {
    if (/^hard_?break$/.test(child.type.name) && child.attrs?.isInline === true) return
    if (/^hard_?break$/.test(child.type.name)) { hardBreak = true; return }
    other = true
    if (!child.isText || /[^ \t]/.test(child.text) || child.marks.some((mark) => mark.type.name === 'inlineCode')) blank = false
  })
  return blank && !(hardBreak && other)
}
const mdIsList = (node, pmList) => node?.type === 'list' && Boolean(node.ordered) === (pmList.type.name === 'ordered_list')

// PM container children → runs: { lists: [{ node, direct }] } for adjacent
// same-kind lists (direct = no empty paragraph before it in the run), or
// { node } for anything else. Empty paragraphs (no Markdown) are skipped.
function runsOf(container) {
  const runs = []
  let blankSince = false
  container.forEach((child) => {
    if (isBlankParagraph(child)) { blankSince = true; return }
    const last = runs[runs.length - 1]
    if (isList(child) && last?.lists && last.lists[0].node.type === child.type) last.lists.push({ node: child, direct: !blankSince })
    else runs.push(isList(child) ? { lists: [{ node: child, direct: true }] } : { node: child })
    blankSince = false
  })
  return runs
}

// Every ordered list of `doc` → whether it sits directly after another
// ordered list (the same rule as `runsOf`).
function directlyAfterOrdered(doc) {
  const map = new Map()
  const visit = (container) => {
    let previous = null
    container.forEach((child) => {
      if (isBlankParagraph(child)) { previous = null; return }
      if (child.type.name === 'ordered_list') map.set(child, previous?.type.name === 'ordered_list')
      previous = child
    })
  }
  visit(doc)
  doc.descendants((node) => {
    if (!node.isTextblock && node.childCount) visit(node)
    return !node.isTextblock
  })
  return map
}

const mdContainerKids = (node) => (node.children || []).filter((child) => child.type !== 'definition')

export function listBoundaryPlan(body, mdRoot, editorDoc, previousDoc) {
  const fixes = [] // { items: [mdast listItem], before: the mdast item before }
  let unresolved = 0
  const before = directlyAfterOrdered(previousDoc)
  // A list the edit made directly adjacent: it existed (same node) and was
  // not directly after an ordered list then.
  const newlyAdjacent = (node) => before.has(node) && before.get(node) === false
  const walk = (pm, md) => {
    const runs = runsOf(pm)
    const kids = mdContainerKids(md)
    let at = 0
    for (const run of runs) {
      if (!run.lists) {
        const kid = kids[at++]
        if (!kid) return
        const name = run.node.type.name
        if (name === 'blockquote' && kid.type === 'blockquote') walk(run.node, kid)
        continue
      }
      // Consume source lists of this kind until the item counts line up.
      const total = run.lists.reduce((sum, entry) => sum + entry.node.childCount, 0)
      const mdLists = []
      let count = 0
      while (count < total && mdIsList(kids[at], run.lists[0].node)) {
        mdLists.push(kids[at])
        count += kids[at].children.length
        at += 1
      }
      if (count !== total) return
      // Flat item streams on both sides.
      const mdItems = []
      mdLists.forEach((list, listIndex) => list.children.forEach((item, index) => mdItems.push({ item, list, listIndex, first: index === 0 })))
      let offset = 0
      run.lists.forEach((entry, listIndex) => {
        const size = entry.node.childCount
        if (listIndex > 0 && entry.direct && entry.node.type.name === 'ordered_list' && !mdItems[offset].first && newlyAdjacent(entry.node)) {
          fixes.push({ items: mdItems.slice(offset, offset + size).filter((x) => x.listIndex === mdItems[offset].listIndex).map((x) => x.item), before: mdItems[offset - 1].item })
        }
        entry.node.forEach((pmItem, index) => {
          const mdItem = mdItems[offset + index]?.item
          if (mdItem?.type === 'listItem') walk(pmItem, mdItem)
        })
        offset += size
      })
    }
  }
  try {
    walk(editorDoc, mdRoot)
  } catch {
    return { fixes: [], unresolved: 0 }
  }
  for (const fix of fixes) {
    fix.edits = []
    const markerOf = (item) => /^(\d{1,9})([.)])/.exec(body.slice(item.position?.start?.offset ?? -1))
    const previous = markerOf(fix.before)
    if (!previous) { unresolved += 1; continue }
    const delimiter = previous[2] === '.' ? ')' : '.'
    for (const item of fix.items) {
      const marker = markerOf(item)
      const start = item.position?.start?.offset
      if (!marker || !Number.isInteger(start)) { fix.edits = null; break }
      fix.edits.push([start + marker[1].length, start + marker[0].length, delimiter])
    }
    if (!fix.edits) unresolved += 1
  }
  return { fixes: fixes.filter((fix) => fix.edits?.length), unresolved }
}

// → { markdown, changed, unresolved }
export function separateAdjacentLists(markdown, editorDoc, previousDoc, remark) {
  const text = String(markdown ?? '')
  const unchanged = { markdown: text, changed: false, unresolved: 0 }
  if (!previousDoc || !remark || typeof remark.parse !== 'function' || typeof remark.runSync !== 'function') return unchanged
  // Only documents that hold two directly adjacent ordered lists.
  let candidate = false
  const scan = (node) => {
    let previous = null
    node.forEach((child) => {
      if (child.type.name === 'ordered_list' && previous?.type.name === 'ordered_list') candidate = true
      previous = child
    })
  }
  // `descendants` leaves out the document itself.
  scan(editorDoc)
  editorDoc.descendants((node) => {
    if (candidate) return false
    scan(node)
    return true
  })
  if (!candidate) return unchanged
  const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : ''
  let body = bom ? text.slice(1) : text
  // A run of three lists rewrites the third against the second's new
  // delimiter: plan again on the rewritten text (a few rounds at most).
  for (let round = 0; round < 4; round += 1) {
    let plan
    try {
      plan = listBoundaryPlan(body, remark.runSync(remark.parse(body), body), editorDoc, previousDoc)
    } catch {
      return unchanged
    }
    if (plan.unresolved) return { markdown: text, changed: false, unresolved: plan.unresolved }
    if (!plan.fixes.length) return round ? { markdown: bom + body, changed: true, unresolved: 0 } : unchanged
    // One fix per round: the first in the document (later ones may change
    // once it is applied).
    const first = plan.fixes.reduce((best, fix) => (!best || fix.edits[0][0] < best.edits[0][0] ? fix : best), null)
    for (const [from, to, value] of [...first.edits].sort((a, b) => b[0] - a[0])) body = body.slice(0, from) + value + body.slice(to)
  }
  return { markdown: text, changed: false, unresolved: 1 }
}
