// Heading-based scroll anchor for preserving reading position across rich↔source
// mode switches (#28). The scroll-RATIO approach is imprecise because rich
// (code/images render tall) and source (compact text) have non-linearly
// corresponding heights — the same ratio lands on different sections. Heading
// TEXT is content-stable across modes, so we anchor on it instead (ratio is the
// fallback when no heading is near the viewport top).
//
// #41 extends this to the CARET: capture the caret's nearest heading + its text
// offset from that heading (or a doc-length ratio when there's no heading), then
// restore the caret to the same place in the new mode after the scroll settles.
import { TextSelection } from '@milkdown/prose/state'
//
// Uses the same heading selector as useOutline.js (duplicated to avoid a cross-
// module import for a single CSS-selector constant; the two modules are
// independent and may diverge if one needs a different selector).

const HEADING_SEL = '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6'

// ATX headings in raw markdown: `^#{1,6}\s+text$` at line start. Shared by the
// source-mode outline (#40) and the source heading anchors below. (Source-mode
// regex can't see inside fenced code blocks, so a `#` comment in a code block is
// a false positive — acceptable, same limit the source anchor always had; rich
// mode uses the DOM and is unaffected.)
const SOURCE_HEADING_RE = /^(#{1,6})[ \t]+(.+)$/gm

// Parse ATX headings from raw markdown → [{ level, text, charOffset }].
// charOffset is the heading's index in the markdown string (for scrollTop→char
// mapping in the source outline scrollspy + caret anchoring #41).
export function parseSourceHeadings(md) {
  if (!md) return []
  const out = []
  let m
  while ((m = SOURCE_HEADING_RE.exec(md)) !== null) {
    out.push({ level: m[1].length, text: m[2].trim(), charOffset: m.index })
  }
  SOURCE_HEADING_RE.lastIndex = 0
  return out
}

// Find the text of the heading nearest the viewport top in the RICH editor.
// One synchronous layout pass (getBoundingClientRect on each heading).
export function headingAtRichTop(host, offset = 80) {
  if (!host) return null
  const hs = host.querySelectorAll(HEADING_SEL)
  if (!hs.length) return null
  const base = host.getBoundingClientRect().top
  let best = null
  for (const h of hs) {
    if (h.getBoundingClientRect().top - base <= offset) best = (h.textContent || '').trim()
    else break
  }
  return best
}

// Find the text of the heading nearest the viewport top in the SOURCE textarea,
// using char-position ratio (robust against line wrapping). Reuses
// parseSourceHeadings so the regex lives in one place.
export function headingAtSourceTop(textarea, md) {
  if (!textarea || !md) return null
  const denom = textarea.scrollHeight - textarea.clientHeight
  if (denom <= 0) return null
  const approxChar = Math.round((textarea.scrollTop / denom) * md.length)
  let best = null
  for (const h of parseSourceHeadings(md)) {
    if (h.charOffset <= approxChar) best = h.text
    else break
  }
  return best
}

// Scroll the RICH editor to a heading by text. Returns true if found.
export function scrollRichToHeading(host, text) {
  if (!host || !text) return false
  const hs = host.querySelectorAll(HEADING_SEL)
  for (const h of hs) {
    if ((h.textContent || '').trim() === text) {
      h.scrollIntoView({ block: 'start' })
      return true
    }
  }
  return false
}

// Scroll the SOURCE textarea to a heading by text (via char-ratio). Returns true.
export function scrollSourceToHeading(textarea, md, text) {
  if (!textarea || !md || !text) return false
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^#{1,6}\\s+${escaped}$`, 'm')
  const m = re.exec(md)
  if (!m) return false
  const denom = textarea.scrollHeight - textarea.clientHeight
  if (denom > 0) textarea.scrollTop = (m.index / md.length) * denom
  return true
}

// ---------------------------------- #41 caret ----------------------------------
// Capture/restore the CARET across rich↔source switches. The caret is anchored
// to its NEAREST PRECEDING heading + text offset from that heading (heading text
// is content-stable across modes, same property #28's scroll relies on). When
// there's no heading before the caret (untitled / headingless docs), fall back to
// a doc-length ratio so the caret at least lands in the same region. Returns null
// when there's nothing to anchor (caller skips caret restore and keeps #28's
// scroll-only behavior).

// Rich → ? : capture from the ProseMirror view. head = selection head; nearest
// heading before it (document order); offset = text chars between heading + head.
export function captureRichCaret(view) {
  if (!view) return null
  try {
    // ProseMirror Selection exposes .head directly (unlike CodeMirror's
    // selection.main.head — ProseMirror has no .main).
    const head = view.state.selection.head
    const heads = []
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') { heads.push({ pos, text: node.textContent }); return false }
      return true
    })
    let pick = null
    for (const h of heads) { if (h.pos <= head) pick = h; else break }
    if (pick) {
      const offset = view.state.doc.textBetween(pick.pos, head, '\n').length
      return { heading: pick.text, offset }
    }
    const size = view.state.doc.content.size
    return size > 0 ? { ratio: head / size } : null
  } catch { return null }
}

// Source → ? : capture from the textarea. nearest heading via parseSourceHeadings.
export function captureSourceCaret(textarea) {
  if (!textarea) return null
  const md = textarea.value || ''
  const start = textarea.selectionStart || 0
  let pick = null
  for (const h of parseSourceHeadings(md)) {
    if (h.charOffset <= start) pick = h
    else break
  }
  if (pick) return { heading: pick.text, offset: start - pick.charOffset }
  return md ? { ratio: start / md.length } : null
}

// ? → Source: set the textarea caret at heading.charOffset + offset (clamped),
// or the ratio point. Returns true on success.
export function restoreSourceCaret(textarea, anchor) {
  if (!textarea || !anchor) return false
  try {
    const md = textarea.value || ''
    let target
    if (anchor.heading) {
      const h = parseSourceHeadings(md).find((x) => x.text === anchor.heading)
      if (!h) return false
      target = Math.min(h.charOffset + (anchor.offset || 0), md.length)
    } else {
      target = Math.round((anchor.ratio || 0) * md.length)
    }
    textarea.setSelectionRange(target, target)
    textarea.focus()
    return true
  } catch { return false }
}

// ? → Rich: set the ProseMirror selection near (headingPos + offset) or the ratio
// point. TextSelection.near snaps to the closest valid text position, so a rough
// offset still lands in-section. Returns true on success.
export function restoreRichCaret(view, anchor) {
  if (!view || !anchor) return false
  try {
    const size = view.state.doc.content.size
    let target
    if (anchor.heading) {
      let hpos = -1
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading' && node.textContent === anchor.heading) { hpos = pos; return false }
        return true
      })
      if (hpos < 0) return false
      target = Math.min(hpos + (anchor.offset || 0), size)
    } else {
      target = Math.round((anchor.ratio || 0) * size)
    }
    const $pos = view.state.doc.resolve(Math.max(1, Math.min(target, size)))
    view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
    view.focus()
    return true
  } catch { return false }
}
