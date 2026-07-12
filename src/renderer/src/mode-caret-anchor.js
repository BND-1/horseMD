import { TextSelection } from '@milkdown/prose/state'
import { parseSourceHeadings } from './mode-source-headings.js'
import {
  nearestIndexOf,
  posAtText,
  richDomVisiblePositionAtSelection,
  richPointerVisiblePosition,
  richPosFromVisibleIndex,
  richVisiblePositionAtPos,
  sourceRawFromVisibleIndex,
  sourceVisiblePositionAtRaw,
  stripMdForSnippet,
  visibleSourcePosition
} from './mode-visible-map.js'
const SNIPPET_LEN = 24

// ---------------------------------- #41 caret ----------------------------------
// Capture/restore the CARET across rich↔source. Two strategies, picked by whether
// the rich caret is visible or the source interaction state says the user moved
// the caret without scrolling afterward:
//   - caret visible (user was editing): restore the caret AND follow it —
//     scrollIntoView + focus (rich) / focus-scroll (source). The viewport goes to
//     the caret; the caret stays where the user was typing.
//   - caret off-screen (user was reading): restore the caret selection WITHOUT
//     scrolling/focusing; the viewport anchor owns scroll. (A focus here would
//     async-scroll to the off-screen caret and drift on large docs.)
// Anchor order on restore: visible-char index → context/snippet fallback →
// heading → ratio.

// Is the rich caret inside the scroller's visible viewport? (PM coordsAtPos.)
// This is the "was the user editing or reading" signal: a visible caret means
// the user just placed it to type; an off-screen caret means they scrolled away
// to read.
export function isRichCaretVisible(view, scroller) {
  if (!view || !scroller) return false
  const sr = scroller.getBoundingClientRect()
  try {
    const c = view.coordsAtPos(view.state.selection.head)
    if (c.bottom > sr.top + 4 && c.top < sr.bottom - 4) return true
  } catch {
    /* fall through to DOM fallback */
  }
  try {
    const at = view.domAtPos(view.state.selection.head)
    const base = at.node.nodeType === 1 ? at.node : at.node.parentElement
    const el = base?.closest?.('p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,pre')
    if (el && view.dom.contains(el)) {
      const er = el.getBoundingClientRect()
      if (er.bottom > sr.top + 4 && er.top < sr.bottom - 4) return true
    }
  } catch {
    /* fall through to DOM selection fallback */
  }
  try {
    const sel = scroller.ownerDocument.getSelection()
    if (!sel || !sel.rangeCount || !view.dom.contains(sel.anchorNode)) return false
    const range = sel.getRangeAt(0)
    const rects = Array.from(range.getClientRects())
    const rect = rects.find((r) => r.height > 0 && r.width >= 0)
    if (rect && rect.bottom > sr.top + 4 && rect.top < sr.bottom - 4) return true
    const el = (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest?.('p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,pre')
    if (!el || !view.dom.contains(el)) return false
    const er = el.getBoundingClientRect()
    return er.bottom > sr.top + 4 && er.top < sr.bottom - 4
  } catch { return false }
}

// Build a { snippet, snipOff } caret anchor for the current textblock, where
// snipOff = the caret's visible-char offset from the snippet START.
//   - Short block (≤ SNIPPET_LEN, e.g. a table cell "九十五" or a heading):
//     snippet = the FULL block text — unique enough to pick the right cell, so a
//     short snippet like "九" no longer collides with the "九" in "九十分".
//   - Long block (a paragraph): snippet = the ≤ SNIPPET_LEN chars immediately
//     before the caret within the block; snipOff = snippet.length (caret lands
//     right after it). Within one block the visible text is identical in both
//     modes, so it matches verbatim even past a URL link / code span.
const richBlockAnchor = (doc, $head) => {
  const start = $head.start() // deepest textblock content start (a cell's <p>, a paragraph, a heading)
  // $head.parent is the innermost node holding the caret — the textblock itself
  // (a cell's paragraph, a normal paragraph, a heading). Its textContent is the
  // block's visible text. We CANNOT use $head.end() for the block end: for a
  // table cell it can resolve to the whole table, making blockText the entire
  // table and collapsing every cell into one long snippet whose pipes/spaces
  // never match the source — so the caret always fell back to ratio and drifted.
  const blockText = ($head.parent && $head.parent.textContent) || ''
  const offsetInBlock = headOffset($head) // visible chars from block start → caret
  const ctxBefore = blockText.slice(Math.max(0, offsetInBlock - SNIPPET_LEN), offsetInBlock)
  const ctxAfter = blockText.slice(offsetInBlock, offsetInBlock + SNIPPET_LEN)
  const context = ctxBefore + ctxAfter
  const contextOff = ctxBefore.length
  if (blockText.length <= SNIPPET_LEN) return { snippet: blockText, snipOff: offsetInBlock, context, contextOff }
  const snip = blockText.slice(Math.max(0, offsetInBlock - SNIPPET_LEN), offsetInBlock)
  if (!snip.replace(/\s/g, '')) {
    const after = blockText.slice(offsetInBlock, offsetInBlock + SNIPPET_LEN)
    if (after.replace(/\s/g, '')) return { snippet: after, snipOff: 0, context, contextOff }
  }
  return { snippet: snip, snipOff: snip.length, context, contextOff }
}

// Visible-char offset of the caret from its textblock start. PM positions map
// 1:1 to visible chars inside a textblock (marks consume no positions), so
// head - start is the char count — UNLESS a hard-break / inline node sits in
// between, in which case it's off by one (acceptable for a caret anchor).
const headOffset = ($head) => $head.pos - $head.start()

const domCaretAnchor = (view) => {
  try {
    const sel = view.dom.ownerDocument.getSelection()
    if (!sel || !sel.rangeCount) return null
    const range = sel.getRangeAt(0)
    if (!range.collapsed || !view.dom.contains(range.startContainer)) return null
    const node = range.startContainer
    if (node.nodeType !== 3) return null
    const text = node.nodeValue || ''
    const offset = range.startOffset || 0
    let before = text.slice(Math.max(0, offset - SNIPPET_LEN), offset)
    let after = text.slice(offset, offset + SNIPPET_LEN)
    const doc = view.dom.ownerDocument
    if (before.length < SNIPPET_LEN) {
      const w = doc.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT)
      let prev = null
      while (w.nextNode()) {
        if (w.currentNode === node) break
        if ((w.currentNode.nodeValue || '').replace(/\s/g, '')) prev = w.currentNode
      }
      if (prev) before = (prev.nodeValue || '').slice(-(SNIPPET_LEN - before.length)) + before
    }
    if (after.length < SNIPPET_LEN) {
      const w = doc.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT)
      w.currentNode = node
      const next = w.nextNode()
      if (next) after += (next.nodeValue || '').slice(0, SNIPPET_LEN - after.length)
    }
    const context = before + after
    if (!context.replace(/\s/g, '')) return null
    if (before.replace(/\s/g, '')) return { snippet: before, snipOff: before.length, context, contextOff: before.length }
    return { snippet: after, snipOff: 0, context, contextOff: 0 }
  } catch { return null }
}

export function captureRichCaret(view) {
  if (!view) return null
  try {
    const doc = view.state.doc
    let head = view.state.selection.head // ProseMirror: .head directly (no .main)
    try {
      const sel = view.dom.ownerDocument.getSelection()
      if (sel && sel.rangeCount && sel.isCollapsed && view.dom.contains(sel.anchorNode)) {
        head = view.posAtDOM(sel.anchorNode, sel.anchorOffset)
      }
    } catch {
      /* use PM selection */
    }
    const $head = doc.resolve(head)
    const blockAnchor = richBlockAnchor(doc, $head)
    const { snippet, snipOff, context, contextOff } = blockAnchor
    const pointerVisible = richPointerVisiblePosition(view)
    const domVisible = richDomVisiblePositionAtSelection(view)
    const { visibleIndex, visibleAffinity } = pointerVisible || domVisible || richVisiblePositionAtPos(doc, head)
    const heads = []
    doc.descendants((node, pos) => {
      if (node.type.name === 'heading') { heads.push({ pos, text: node.textContent }); return false }
      return true
    })
    let pick = null
    for (const h of heads) { if (h.pos <= head) pick = h; else break }
    const size = doc.content.size
    const ratio = size > 0 ? head / size : 0
    if (pick) {
      const offset = doc.textBetween(pick.pos, head, '\n').length
      return { origin: 'rich', heading: pick.text, offset, ratio, snippet, snipOff, context, contextOff, pmPos: head, visibleIndex, visibleAffinity }
    }
    return size > 0 ? { origin: 'rich', ratio: head / size, snippet, snipOff, context, contextOff, pmPos: head, visibleIndex, visibleAffinity } : null
  } catch { return null }
}

// Source → ? : capture from the textarea. In a GFM table row the cell text is
// the right anchor (a row-prefix snippet "| 张三 | 数学 | 九" has pipes/spaces
// that don't exist in the rich rendering, so it never matches); elsewhere the
// current line is the block. Nearest heading via parseSourceHeadings as a fallback.
export function captureSourceCaret(textarea) {
  if (!textarea) return null
  const md = textarea.value || ''
  const start = textarea.selectionStart || 0
  const lineStart = md.lastIndexOf('\n', start - 1) + 1
  const lineEndRel = md.indexOf('\n', start)
  const lineEnd = lineEndRel < 0 ? md.length : lineEndRel
  const fullLine = md.slice(lineStart, lineEnd)
  let snippet, snipOff
  let context, contextOff
  if (/^\|.*\|\s*$/.test(fullLine)) {
    // Table row: anchor on the CURRENT cell only.
    const col = start - lineStart
    const cellStart = fullLine.lastIndexOf('|', col - 1) + 1
    const cellEndRel = fullLine.indexOf('|', col)
    const cellEnd = cellEndRel < 0 ? fullLine.length : cellEndRel
    const cell = fullLine.slice(cellStart, cellEnd)
    snippet = stripMdForSnippet(cell).trim()
    snipOff = stripMdForSnippet(fullLine.slice(cellStart, col)).trim().length
    const before = stripMdForSnippet(cell.slice(0, col - cellStart)).trim().slice(-SNIPPET_LEN)
    const after = stripMdForSnippet(cell.slice(col - cellStart)).trim().slice(0, SNIPPET_LEN)
    context = before + after
    contextOff = before.length
  } else {
    const stripped = stripMdForSnippet(md.slice(lineStart, start))
    const strippedAfter = stripMdForSnippet(md.slice(start, Math.min(md.length, lineEnd)))
    const before = stripped.slice(-SNIPPET_LEN)
    const after = strippedAfter.slice(0, SNIPPET_LEN)
    context = before + after
    contextOff = before.length
    snippet = stripped.length <= SNIPPET_LEN ? stripped : stripped.slice(-SNIPPET_LEN)
    snipOff = snippet.length
    if (!snippet.replace(/\s/g, '')) {
      const after = stripMdForSnippet(md.slice(start, Math.min(md.length, start + SNIPPET_LEN * 4))).replace(/^\s+/, '')
      if (after) {
        snippet = after.slice(0, SNIPPET_LEN)
        snipOff = 0
      }
    }
  }
  let pick = null
  for (const h of parseSourceHeadings(md)) {
    if (h.charOffset <= start) pick = h
    else break
  }
  const ratio = md ? start / md.length : 0
  const { visibleIndex, visibleAffinity } = sourceVisiblePositionAtRaw(md, start)
  if (pick) return { origin: 'source', heading: pick.text, offset: start - pick.charOffset, ratio, snippet, snipOff, context, contextOff, visibleIndex, visibleAffinity, rawOffset: start }
  return md ? { origin: 'source', ratio, snippet, snipOff, context, contextOff, visibleIndex, visibleAffinity, rawOffset: start } : null
}

// Rich → Source: use the markdown source offset while both views share the
// same normalized snapshot. Global visible-char index and text context are
// fallbacks for structures that cannot provide an exact source position.
// `follow` = true (user was editing): focus scrolls the textarea
// to the caret (viewport follows). `follow` = false (user was reading):
// preventScroll — the viewport anchor owns scroll.
export function restoreSourceCaret(textarea, anchor, follow = false) {
  if (!textarea || !anchor) return false
  try {
    const md = textarea.value || ''
    const hint = anchor.ratio != null ? anchor.ratio * md.length : -1
    let target
    if (Number.isFinite(anchor.rawOffset)) {
      target = Math.max(0, Math.min(anchor.rawOffset, md.length))
    }
    if (target == null && Number.isFinite(anchor.visibleIndex)) {
      target = sourceRawFromVisibleIndex(md, anchor.visibleIndex, anchor.visibleAffinity)
    }
    if (target == null && anchor.context) {
      const idx = nearestIndexOf(md, anchor.context, hint)
      if (idx >= 0) {
        const off = anchor.contextOff != null ? anchor.contextOff : 0
        target = Math.min(idx + off, md.length)
      }
      if (target == null) {
        const off = anchor.contextOff != null ? anchor.contextOff : 0
        const visibleTarget = visibleSourcePosition(md, anchor.context, off, hint)
        if (visibleTarget >= 0) target = Math.min(visibleTarget, md.length)
      }
    }
    if (target == null && anchor.snippet) {
      const idx = nearestIndexOf(md, anchor.snippet, hint)
      if (idx >= 0) {
        const off = anchor.snipOff != null ? anchor.snipOff : anchor.snippet.length
        target = Math.min(idx + off, md.length)
      }
      if (target == null) {
        const off = anchor.snipOff != null ? anchor.snipOff : anchor.snippet.length
        const visibleTarget = visibleSourcePosition(md, anchor.snippet, off, hint)
        if (visibleTarget >= 0) target = Math.min(visibleTarget, md.length)
      }
    }
    if (target == null && anchor.heading) {
      const h = parseSourceHeadings(md).find((x) => x.text === anchor.heading)
      if (h) {
        // Heading text starts AFTER the "# " marker — charOffset points at the
        // line start (with the marker), so skip it.
        const m = md.slice(h.charOffset).match(/^#{1,6}[ \t]+/)
        const textOff = h.charOffset + (m ? m[0].length : 0)
        target = Math.min(textOff + (anchor.offset || 0), md.length)
      }
    }
    if (target == null) target = Math.round((anchor.ratio || 0) * md.length)
    textarea.setSelectionRange(target, target)
    textarea.focus({ preventScroll: !follow })
    return true
  } catch { return false }
}

// ? → Rich: caret at global visible-char index first, then snippet fallback,
// heading, ratio. TextSelection.near snaps to the closest valid text
// position. `follow` selects the strategy:
//   - true  (user was editing — caret was visible): scrollIntoView + focus so the
//     viewport FOLLOWS the caret (caret stays visible, ready to type). The caret
//     is in-viewport here, so focusing can't yank the viewport elsewhere.
//   - false (user was reading — caret was off-screen): set the selection only,
//     NO scrollIntoView / NO focus. The viewport anchor owns scroll; a focus here
//     would async-scroll to the off-screen caret and drift on large docs.
export function restoreRichCaret(view, anchor, follow = false) {
  if (!view || !anchor) return false
  try {
    const doc = view.state.doc
    const size = doc.content.size
    const hint = anchor.ratio != null ? anchor.ratio * size : -1
    let target
    if (Number.isFinite(anchor.pmPos) && anchor.pmPos > 0 && anchor.pmPos <= size) {
      target = anchor.pmPos
    }
    if (target == null && Number.isFinite(anchor.visibleIndex)) {
      target = richPosFromVisibleIndex(doc, anchor.visibleIndex, anchor.visibleAffinity)
    }
    if (target == null && anchor.context) {
      const s = posAtText(doc, anchor.context, hint)
      if (s >= 0) {
        const off = anchor.contextOff != null ? anchor.contextOff : 0
        target = Math.min(s + off, size)
      }
    }
    if (target == null && anchor.snippet) {
      const s = posAtText(doc, anchor.snippet, hint)
      if (s >= 0) {
        const off = anchor.snipOff != null ? anchor.snipOff : anchor.snippet.length
        target = Math.min(s + off, size)
      }
    }
    if (target == null && anchor.heading) {
      let hpos = -1
      doc.descendants((node, pos) => {
        if (node.type.name === 'heading' && node.textContent === anchor.heading) { hpos = pos; return false }
        return true
      })
      // +1 skips the heading node's open token (descendants gives the position
      // before the node; content starts at +1).
      if (hpos >= 0) target = Math.min(hpos + 1 + (anchor.offset || 0), size)
    }
    if (target == null) target = Math.round((anchor.ratio || 0) * size)
    const $pos = doc.resolve(Math.max(1, Math.min(target, size)))
    const tr = view.state.tr.setSelection(TextSelection.near($pos))
    if (follow) tr.scrollIntoView()
    // CodeMirror code-block node views only receive their setSelection call
    // when the outer ProseMirror owns focus during dispatch. Focusing PM after
    // dispatch steals focus back from CodeMirror and leaves its caret offscreen.
    if (follow) view.focus()
    view.dispatch(tr)
    const inCodeBlock = /code/i.test($pos.parent.type.name)
    if (follow && inCodeBlock) {
      try {
        const scroller = view.dom.closest('.editor-scroll')
        const sr = scroller?.getBoundingClientRect()
        const domSelection = view.dom.ownerDocument.getSelection()
        const domRange = domSelection?.rangeCount ? domSelection.getRangeAt(0) : null
        const coords = domRange?.getBoundingClientRect()
        if (scroller && sr && coords && (coords.top < sr.top + 12 || coords.bottom > sr.bottom - 12)) {
          scroller.scrollTop += (coords.top + coords.bottom) / 2 - (sr.top + sr.bottom) / 2
        }
      } catch {
        // The selection is still correct; a later restore pass can retry once
        // the CodeMirror node view has finished its DOM update.
      }
    } else if (follow) {
      view.focus()
    }
    return true
  } catch { return false }
}
