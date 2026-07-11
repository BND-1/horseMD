// find-in-document helpers
// Search is scoped to the editor content only (the rich .ProseMirror element or
// the source <textarea>), never the find bar or other UI — so the text typed in
// the find box is never itself matched. Highlighting uses the CSS Custom
// Highlight API, which paints ranges without touching the DOM.
import { syncTextareaMirrorStyle, textareaOffsetY } from './textarea-metrics.js'

const FIND_HL = 'hm-find'
const FIND_HL_CUR = 'hm-find-current'
const SOURCE_FIND_MARK = 'hm-source-find-current'
const findHighlightSupported =
  typeof window !== 'undefined' && !!window.CSS?.highlights && typeof window.Highlight === 'function'

export function clearFindHighlights() {
  if (!findHighlightSupported) return
  CSS.highlights.delete(FIND_HL)
  CSS.highlights.delete(FIND_HL_CUR)
}

function clearSourceFindMarks(doc) {
  doc.querySelectorAll(`.${SOURCE_FIND_MARK}`).forEach((node) => node.remove())
}

function sourceRangeRects(textarea, start, end) {
  const doc = textarea.ownerDocument
  const mirror = doc.createElement('div')
  syncTextareaMirrorStyle(textarea, mirror)
  mirror.appendChild(doc.createTextNode((textarea.value || '').slice(0, start)))
  const span = doc.createElement('span')
  span.textContent = (textarea.value || '').slice(start, end) || '​'
  mirror.appendChild(span)
  doc.body.appendChild(mirror)
  try {
    const base = mirror.getBoundingClientRect()
    return Array.from(span.getClientRects()).map((rect) => ({
      left: rect.left - base.left,
      top: rect.top - base.top,
      width: rect.width,
      height: rect.height
    }))
  } finally {
    mirror.remove()
  }
}

export function scrollTextareaOffsetIntoView(textarea, offset) {
  if (!textarea) return
  try {
    const cs = textarea.ownerDocument.defaultView.getComputedStyle(textarea)
    const fontPx = parseFloat(cs.fontSize) || 14
    const linePx = parseFloat(cs.lineHeight) || fontPx * 1.75
    const y = textareaOffsetY(textarea, offset)
    const margin = Math.max(linePx * 3, 48)
    const viewTop = textarea.scrollTop
    const viewBottom = viewTop + textarea.clientHeight
    if (y < viewTop + margin) {
      textarea.scrollTop = Math.max(0, y - margin)
    } else if (y + linePx > viewBottom - margin) {
      textarea.scrollTop = Math.max(0, y + linePx - textarea.clientHeight + margin)
    }
  } catch {
    // Selection still lands even if mirror measurement fails.
  }
}

function renderSourceFindHighlight(textarea) {
  if (!textarea?.isConnected || !textarea.__horsemdSourceFindRange) return
  const doc = textarea.ownerDocument
  clearSourceFindMarks(doc)
  const { start, end } = textarea.__horsemdSourceFindRange
  if (end <= start) return
  let rects = []
  try {
    rects = sourceRangeRects(textarea, start, end)
  } catch {
    return
  }
  const taRect = textarea.getBoundingClientRect()
  for (const rect of rects) {
    const left = taRect.left + rect.left - textarea.scrollLeft
    const top = taRect.top + rect.top - textarea.scrollTop
    const right = left + rect.width
    const bottom = top + rect.height
    const clippedLeft = Math.max(left, taRect.left)
    const clippedTop = Math.max(top, taRect.top)
    const clippedRight = Math.min(right, taRect.right)
    const clippedBottom = Math.min(bottom, taRect.bottom)
    if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) continue
    const mark = doc.createElement('div')
    mark.className = SOURCE_FIND_MARK
    mark.style.left = `${clippedLeft}px`
    mark.style.top = `${clippedTop}px`
    mark.style.width = `${clippedRight - clippedLeft}px`
    mark.style.height = `${clippedBottom - clippedTop}px`
    doc.body.appendChild(mark)
  }
}

export function paintSourceFindHighlight(textarea, start, end) {
  if (!textarea) return
  const doc = textarea.ownerDocument
  textarea.__horsemdSourceFindRange = { start, end }
  if (!textarea.__horsemdSourceFindCleanup) {
    let raf = 0
    const schedule = () => {
      if (raf) return
      raf = doc.defaultView.requestAnimationFrame(() => {
        raf = 0
        renderSourceFindHighlight(textarea)
      })
    }
    const events = ['scroll', 'input']
    events.forEach((event) => textarea.addEventListener(event, schedule, { passive: true }))
    doc.defaultView.addEventListener('resize', schedule)
    textarea.__horsemdSourceFindCleanup = () => {
      if (raf) doc.defaultView.cancelAnimationFrame(raf)
      events.forEach((event) => textarea.removeEventListener(event, schedule))
      doc.defaultView.removeEventListener('resize', schedule)
      delete textarea.__horsemdSourceFindCleanup
      delete textarea.__horsemdSourceFindRange
      clearSourceFindMarks(doc)
    }
  }
  renderSourceFindHighlight(textarea)
}

export function clearSourceFindHighlight(textarea) {
  if (textarea?.__horsemdSourceFindCleanup) {
    textarea.__horsemdSourceFindCleanup()
    return
  }
  if (textarea?.ownerDocument) {
    delete textarea.__horsemdSourceFindRange
    clearSourceFindMarks(textarea.ownerDocument)
    return
  }
  if (typeof document !== 'undefined') clearSourceFindMarks(document)
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
