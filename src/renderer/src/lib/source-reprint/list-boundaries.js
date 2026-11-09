// Two lists of the same kind that sit directly next to each other in the
// editor (no empty paragraph between) are two lists, but written with the
// same marker they read back as one: the lower list's items join the upper
// one (`1.` … `1.`: its item 1 becomes item 5). The editor document is the
// truth (docs/reprint-root-cause-plan.md: what reads back must equal the
// projection, and the serializer writes them apart), so the lower list's
// marker switches — `.`↔`)`, `-`↔`*` — the way mdast-util-to-markdown
// alternates them; an ordered list's first number is its start.
//
// Lists that only become adjacent through an edit are joined in the editor
// (editor-list-join.js, Typora parity: a typed `1. ` after a list continues
// it), so this is left for lists that were next to each other already —
// written apart in the file — and were reprinted with one marker.
// Lists separated by an editor-only empty paragraph read back as one, like
// the projection (RS-86). Where the editor document and the source cannot be
// lined up, nothing is changed and nothing is reported (the verifier stands).

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

const mdContainerKids = (node) => (node.children || []).filter((child) => child.type !== 'definition')

export function listBoundaryPlan(body, mdRoot, editorDoc, { merged = null } = {}) {
  const fixes = [] // { items: [mdast listItem], before: the mdast item before, list: the PM list }
  let unresolved = 0
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
        if (listIndex > 0 && entry.direct && !mdItems[offset].first) {
          merged?.add(entry.node)
          fixes.push({ items: mdItems.slice(offset, offset + size).filter((x) => x.listIndex === mdItems[offset].listIndex).map((x) => x.item), before: mdItems[offset - 1].item, list: entry.node })
        }
        entry.node.forEach((pmItem, _offset, index) => {
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
    const ordered = fix.list.type.name === 'ordered_list'
    const markerOf = (item) => (ordered ? /^(\d{1,9})([.)])/ : /^()([-+*])/).exec(body.slice(item.position?.start?.offset ?? -1))
    const previous = markerOf(fix.before)
    if (!previous) { unresolved += 1; continue }
    const other = ordered ? (previous[2] === '.' ? ')' : '.') : (previous[2] === '-' ? '*' : '-')
    fix.items.forEach((item, index) => {
      if (!fix.edits) return
      const marker = markerOf(item)
      const start = item.position?.start?.offset
      if (!marker || !Number.isInteger(start)) { fix.edits = null; return }
      // The first number of the list is its start (the editor's `order`).
      if (ordered && index === 0) fix.edits.push([start, start + marker[0].length, `${fix.list.attrs.order ?? 1}${other}`])
      else fix.edits.push([start + marker[1].length, start + marker[0].length, other])
    })
    if (!fix.edits) unresolved += 1
  }
  return { fixes: fixes.filter((fix) => fix.edits?.length), unresolved }
}

// → { markdown, changed, unresolved }
export function separateAdjacentLists(markdown, editorDoc, remark) {
  const text = String(markdown ?? '')
  const unchanged = { markdown: text, changed: false, unresolved: 0 }
  if (!remark || typeof remark.parse !== 'function' || typeof remark.runSync !== 'function') return unchanged
  // Only documents that hold two directly adjacent lists of one kind.
  let candidate = false
  const scan = (node) => {
    let previous = null
    node.forEach((child) => {
      if (isList(child) && previous?.type === child.type) candidate = true
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
      plan = listBoundaryPlan(body, remark.runSync(remark.parse(body), body), editorDoc)
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

// The lower lists of the editor's directly adjacent same-kind pairs that
// `markdown` reads as one list with the list above (same marker): a Set of
// PM list nodes. What the file says decides (editor-list-join.js): `- a` +
// `* b` are two lists, `1. a` + `1. b` one.
export function listsReadAsOne(markdown, editorDoc, remark) {
  const merged = new Set()
  try {
    const text = String(markdown ?? '').replace(/^\uFEFF/, '')
    listBoundaryPlan(text, remark.runSync(remark.parse(text), text), editorDoc, { merged })
  } catch {
    return new Set()
  }
  return merged
}
