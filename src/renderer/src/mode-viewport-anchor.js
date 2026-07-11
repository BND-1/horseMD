import { textareaOffsetAtScrollTop, textareaOffsetY } from './textarea-metrics.js'
import {
  nearestIndexOf,
  richPosFromVisibleIndex,
  sourceVisiblePositionAtRaw,
  stripMdForSnippet
} from './mode-visible-map.js'
const VIEWPORT_LEN = 24

// --------------------------------- #28 viewport ---------------------------------
// Capture/restore the SCROLL position via the visible text at the top of the
// viewport. Independent of the caret: when the user scrolled away to read, the
// caret sits elsewhere and we must NOT yank the viewport to it. The snippet is
// the reading landmark; restore scrolls it back to the top. Falls back to a
// scrollTop ratio when no snippet matches.

// The rich viewport anchor is PURE DOM (no ProseMirror dependency): it reads
// the text node at the top of the scroller and, on restore, finds that text in
// the DOM and scrolls it back to the top. This is deliberately NOT routed
// through view.posAtDOM / view.state.doc.textBetween / posAtText, because on a
// large, image-dense doc (hundreds of remote <img>s, 100k+ chars) the PM doc ↔
// DOM mapping can land on the wrong spot or drift as heights settle — whereas
// the DOM text itself is stable and exactly what the user sees. The caret
// anchor still uses PM (it needs precise selection math); the viewport anchor
// only needs "show the same screenful of text", which DOM does best.

// The .ProseMirror content element inside the scroller. All viewport text
// walking is scoped to it (NOT the whole scroller, NOT caretPositionFromPoint's
// arbitrary hit) so capture and restore see the SAME node set — otherwise the
// captured snippet could come from an overlay/adjacent surface and never appear
// in the restore buffer.
const pmContent = (scroller) => (scroller && scroller.querySelector('.ProseMirror')) || null

// The topmost visible text node + char offset, scoped to .ProseMirror. Prefers
// caretPositionFromPoint (char-precise) but ONLY accepts it when the node is
// inside .ProseMirror; otherwise a TreeWalker over .ProseMirror finds the first
// text node whose bottom crosses the top edge (the first visible line).
const topTextNode = (pm, sr) => {
  const doc = pm.ownerDocument
  const cp = doc.caretPositionFromPoint ? doc.caretPositionFromPoint(sr.left + sr.width / 2, sr.top + 6) : null
  // Reject whitespace-only hits (list/block indentation at the viewport top):
  // a whitespace snippet never matches on restore -> ratio fallback -> jump.
  // Fall through to the TreeWalker, which skips whitespace-only nodes.
  if (cp && cp.offsetNode && cp.offsetNode.nodeType === 3 && pm.contains(cp.offsetNode) && cp.offsetNode.nodeValue.replace(/\s/g, '')) {
    return { node: cp.offsetNode, off: cp.offset }
  }
  const w = doc.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
  while (w.nextNode()) {
    const tn = w.currentNode
    if (!tn.nodeValue.replace(/\s/g, '')) continue
    const rr = doc.createRange(); rr.selectNodeContents(tn)
    if (rr.getBoundingClientRect().bottom > sr.top + 1) return { node: tn, off: 0 }
  }
  return null
}

// `len` RAW chars starting at (node, off), reaching into FOLLOWING text nodes of
// `pm` when the start node is shorter. Crossing nodes is required because
// viewport-top text is often split by inline marks (code, links): "。以 " |
// "skills" | " 为例…" — a single-node slice would be the tiny "。以 ", which
// isn't unique. Restore mirrors this with a concatenated buffer over the same
// `pm`, so a cross-node snippet still matches. RAW (no normalization) so capture
// and restore are byte-identical.
const forwardDomText = (pm, node, off, len) => {
  let s = node.nodeValue.slice(off)
  if (s.length < len) {
    const w = pm.ownerDocument.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
    w.currentNode = node
    while (s.length < len && w.nextNode()) s += w.currentNode.nodeValue
  }
  return s.slice(0, len)
}

// Advance (node, off) past leading whitespace — within the node, then into the
// following text nodes — so the snippet starts on real text. The viewport top of
// a list / indented block is often indentation whitespace; a whitespace snippet
// matches the first whitespace run in the doc (near the top) and yanks the
// restore there.
const skipLeadingWs = (pm, node, off) => {
  const doc = pm.ownerDocument
  while (node) {
    const v = node.nodeValue
    while (off < v.length && /\s/.test(v[off])) off++
    if (off < v.length) return { node, off } // found a non-ws char
    const w = doc.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
    w.currentNode = node
    node = w.nextNode()
    off = 0
  }
  return null
}

export function captureRichViewport(scroller, _view) {
  if (!scroller) return null
  const denom = scroller.scrollHeight - scroller.clientHeight
  const ratio = denom > 0 ? scroller.scrollTop / denom : 0
  const pm = pmContent(scroller)
  if (!pm) return { snippet: null, ratio }
  const top = topTextNode(pm, scroller.getBoundingClientRect())
  const real = top ? skipLeadingWs(pm, top.node, top.off) : null
  if (!real) return { snippet: null, ratio }
  const snippet = forwardDomText(pm, real.node, real.off, VIEWPORT_LEN) || null
  return { snippet, ratio }
}

// ----- textarea char ↔ pixel -----
// A textarea exposes no native char↔pixel API and wrapped lines make a plain
// character ratio inaccurate. textarea-metrics mirrors the textarea's computed
// typography and width only when an anchor is captured/restored, yielding an
// exact raw offset without adding full-document layout reads to normal scroll.

export function captureSourceViewport(textarea) {
  if (!textarea) return null
  const md = textarea.value || ''
  const denom = textarea.scrollHeight - textarea.clientHeight
  const ratio = denom > 0 ? textarea.scrollTop / denom : 0
  // Approx the char at the viewport top (linear ratio). Skip past image/URL
  // syntax so we anchor on prose that exists in the rich rendering — a viewport
  // top landing on `![alt](url)` would otherwise capture the URL, which has no
  // rich counterpart and never matches.
  let pos
  try {
    pos = textareaOffsetAtScrollTop(textarea)
  } catch {
    pos = denom > 0 ? Math.round(ratio * md.length) : 0
  }
  const ahead = md.slice(pos, pos + 120)
  const imgRel = ahead.search(/!\[[^\]]*\]\([^)]*\)/)
  if (imgRel >= 0 && imgRel < 30) pos += imgRel + ahead.slice(imgRel).match(/!\[[^\]]*\]\([^)]*\)/)[0].length
  const snippet = stripMdForSnippet(md.slice(pos, pos + 80)).replace(/\s+/g, ' ').trim().slice(0, VIEWPORT_LEN) || null
  const { visibleIndex, visibleAffinity } = sourceVisiblePositionAtRaw(md, pos)
  return { origin: 'source', snippet, ratio, rawOffset: pos, visibleIndex, visibleAffinity }
}

// Scroll the rich editor so the viewport-top snippet is back at the top. Builds
// a RAW concatenated buffer of every text node + an offsets table, so a snippet
// that SPANS mark/node boundaries (prose with inline code/links) — which no
// single text node contains — still matches. Among all matches it picks the one
// whose absolute top is nearest the expected (ratio) position, then aligns it to
// the scroller's top edge. Pure DOM — robust on large/image-dense docs. Ratio
// fallback when the snippet isn't found.
export function restoreRichViewport(scroller, view, anchor) {
  if (!scroller || !anchor) return false
  if (anchor.origin === 'source' && view && Number.isFinite(anchor.visibleIndex)) {
    try {
      const pos = richPosFromVisibleIndex(view.state.doc, anchor.visibleIndex, anchor.visibleAffinity)
      const coords = view.coordsAtPos(Math.max(1, Math.min(pos, view.state.doc.content.size)))
      scroller.scrollTop += coords.top - scroller.getBoundingClientRect().top
      return true
    } catch {
      // Fall through to the DOM snippet/ratio recovery path.
    }
  }
  const pm = pmContent(scroller)
  if (!pm) {
    const denom0 = scroller.scrollHeight - scroller.clientHeight
    if (denom0 > 0) scroller.scrollTop = (anchor.ratio || 0) * denom0
    return true
  }
  try {
    const doc = pm.ownerDocument
    const sr = scroller.getBoundingClientRect()
    const denom = scroller.scrollHeight - scroller.clientHeight
    if (!anchor.snippet) {
      if (denom > 0) scroller.scrollTop = (anchor.ratio || 0) * denom
      return true
    }
    const snip = anchor.snippet
    // Concatenate .ProseMirror text-node values into one buffer (same scope as
    // capture, so the snippet is guaranteed findable); remember each node's
    // [start, len) so a buffer index maps back to (node, char offset).
    const w = doc.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
    let buf = ''
    const segs = [] // { node, start, len }
    while (w.nextNode()) {
      const tn = w.currentNode
      const nv = tn.nodeValue
      if (!nv) continue
      segs.push({ node: tn, start: buf.length, len: nv.length })
      buf += nv
    }
    // binary-search segs for the segment containing a buffer index
    const nodeAt = (bi) => {
      let lo = 0
      let hi = segs.length - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const s = segs[mid]
        if (bi < s.start) hi = mid - 1
        else if (bi >= s.start + s.len) lo = mid + 1
        else return { node: s.node, off: bi - s.start }
      }
      return null
    }
    const expected = anchor.ratio != null && denom > 0 ? anchor.ratio * scroller.scrollHeight : -1
    // Find the buffer occurrence nearest the expected position. Try the full
    // snippet first; if it isn't present (a re-render split a mark differently,
    // shifting the snippet's tail), fall back to shorter prefixes — the head is
    // stable and still unique enough with the position hint.
    let bestBi = -1
    let bd = Infinity
    const findNearest = (needle) => {
      if (!needle) return
      let from = 0
      let idx
      while ((idx = buf.indexOf(needle, from)) >= 0) {
        const at = nodeAt(idx)
        if (at) {
          const r = doc.createRange(); r.setStart(at.node, at.off)
          const absTop = r.getBoundingClientRect().top + scroller.scrollTop
          const d = expected > 0 ? Math.abs(absTop - expected) : 0
          if (bestBi < 0 || d < bd) { bd = d; bestBi = idx }
        }
        from = idx + 1
      }
    }
    findNearest(snip)
    if (bestBi < 0) findNearest(snip.slice(0, Math.ceil(snip.length / 2)))
    if (bestBi >= 0) {
      const at = nodeAt(bestBi)
      const r = doc.createRange(); r.setStart(at.node, at.off)
      scroller.scrollTop = scroller.scrollTop + (r.getBoundingClientRect().top - sr.top)
      return true
    }
    if (denom > 0) scroller.scrollTop = (anchor.ratio || 0) * denom
    return true
  } catch { return false }
}

// Scroll the source textarea so the viewport-top snippet is back at the top.
// Finds the snippet's char (nearest expected), then scrollTop = char-ratio * denom.
export function restoreSourceViewport(textarea, anchor) {
  if (!textarea || !anchor) return false
  try {
    const md = textarea.value || ''
    const hint = anchor.ratio != null ? anchor.ratio * md.length : -1
    let charPos = Number.isFinite(anchor.rawOffset)
      ? Math.max(0, Math.min(anchor.rawOffset, md.length))
      : -1
    if (charPos < 0) charPos = anchor.snippet ? nearestIndexOf(md, anchor.snippet, hint) : -1
    if (charPos < 0) charPos = Math.round((anchor.ratio || 0) * md.length)
    try {
      textarea.scrollTop = textareaOffsetY(textarea, charPos)
    } catch {
      const denom = textarea.scrollHeight - textarea.clientHeight
      textarea.scrollTop = denom > 0 ? (charPos / md.length) * denom : 0
    }
    return true
  } catch { return false }
}
