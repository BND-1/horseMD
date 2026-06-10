// find-in-document helpers
// Search is scoped to the editor content only (the rich .ProseMirror element or
// the source <textarea>), never the find bar or other UI — so the text typed in
// the find box is never itself matched. Highlighting uses the CSS Custom
// Highlight API, which paints ranges without touching the DOM.
const FIND_HL = 'hm-find'
const FIND_HL_CUR = 'hm-find-current'
const findHighlightSupported =
  typeof window !== 'undefined' && !!window.CSS?.highlights && typeof window.Highlight === 'function'

export function clearFindHighlights() {
  if (!findHighlightSupported) return
  CSS.highlights.delete(FIND_HL)
  CSS.highlights.delete(FIND_HL_CUR)
}
export function findRangesInEl(root, query) {
  const ranges = []
  if (!root || !query) return ranges
  const q = query.toLowerCase()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    const val = node.nodeValue
    if (!val) continue
    const lower = val.toLowerCase()
    let idx = lower.indexOf(q)
    while (idx !== -1) {
      const r = document.createRange()
      r.setStart(node, idx)
      r.setEnd(node, idx + query.length)
      ranges.push(r)
      idx = lower.indexOf(q, idx + query.length)
    }
  }
  return ranges
}
export function paintFindHighlights(ranges, activeIdx) {
  if (!findHighlightSupported) return
  CSS.highlights.delete(FIND_HL)
  CSS.highlights.delete(FIND_HL_CUR)
  if (!ranges.length) return
  CSS.highlights.set(FIND_HL, new Highlight(...ranges))
  if (ranges[activeIdx]) {
    const cur = new Highlight(ranges[activeIdx])
    cur.priority = 1
    CSS.highlights.set(FIND_HL_CUR, cur)
  }
}
export function scrollRangeIntoView(range, scroller) {
  if (!range || !scroller) return
  const rect = range.getBoundingClientRect()
  const sr = scroller.getBoundingClientRect()
  if (!rect.height && !rect.width) return
  if (rect.top < sr.top + 12 || rect.bottom > sr.bottom - 12) {
    scroller.scrollTop += (rect.top + rect.bottom) / 2 - (sr.top + sr.bottom) / 2
  }
}
export function matchIndices(text, query) {
  const out = []
  if (!text || !query) return out
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let idx = lower.indexOf(q)
  while (idx !== -1) {
    out.push(idx)
    idx = lower.indexOf(q, idx + query.length)
  }
  return out
}
