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

// ATX headings in raw markdown: `^#{1,6}\s+text$` at line start. Used by the
// source-mode outline (#40), the source heading anchors, and the caret anchors
// (#41). (Source-mode regex can't see inside fenced code blocks, so a `#`
// comment in a code block is a false positive — acceptable, same limit the
// source anchor always had; rich mode uses the DOM and is unaffected.)
//
// Constructed fresh inside parseSourceHeadings (not a module-level `g`-flag
// regex) so a stateful `lastIndex` can never leak between calls.
export function parseSourceHeadings(md) {
  if (!md) return []
  const out = []
  const re = /^(#{1,6})[ \t]+(.+)$/gm
  let m
  while ((m = re.exec(md)) !== null) {
    out.push({ level: m[1].length, text: m[2].trim(), charOffset: m.index })
  }
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
// Capture/restore the CARET across rich↔source switches. Anchor order on
// restore: SNIPPET (primary) → heading → ratio. The snippet is ~24 chars of
// VISIBLE text before the caret within the current textblock — content-stable
// across modes (only markdown syntax differs), so it lands on the same text in
// the other mode even when a URL link / code fence / list marker makes char
// offsets diverge. Heading + ratio are fallbacks (caret at a block start with no
// preceding text / snippet not found). Returns null when there's nothing to
// anchor (caller skips caret restore and keeps #28's scroll-only behavior).

const SNIPPET_LEN = 24

// Strip markdown syntax so a SOURCE-side caret snippet matches the rich doc's
// visible text (which has no link/emphasis/code/heading syntax). The visible
// prose is identical across modes; only the syntax differs — so a snippet of
// visible text is a stable cross-mode landmark even when a URL link makes char
// offsets diverge. ORDER MATTERS: strip structural markers (heading/blockquote/
// list) BEFORE emphasis — otherwise the emphasis `\*` eats a bullet-list `*`
// first and leaves the trailing space, so the snippet no longer matches.
const stripMdForSnippet = (s) => s
  .replace(/^\s{0,3}#{1,6}\s*/gm, '')         // heading markers
  .replace(/^\s{0,3}>\s?/gm, '')              // blockquote markers
  .replace(/^\s{0,3}[-*+]\s+/gm, '')          // bullet list markers
  .replace(/^\s{0,3}\d+\.\s+/gm, '')          // ordered list markers
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image ![alt](url) → alt
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // link [text](url) → text
  .replace(/```[\s\S]*?```/g, '')            // fenced code blocks
  .replace(/[`]+/g, '')                       // inline code backticks
  .replace(/\*\*|__|~~|\*|_/g, '')            // emphasis (after markers, so it
                                              // can't swallow a bullet `*`)

// Find the ProseMirror position right AFTER the last occurrence of `snippet` in
// the doc's visible text (so the caret can land there). -1 if not found. Used
// instead of a doc-wide ratio when there's no heading — far more precise because
// it lands on the same visible text, not on a proportional offset that diverges
// when markdown syntax (links, code) adds chars to one mode but not the other.
const posAfterText = (doc, snippet) => {
  if (!snippet) return -1
  let chars = ''
  const poses = [] // poses[i] = PM position right after visible char i
  doc.descendants((node, pos) => {
    if (node.isText) {
      const t = node.text
      for (let i = 0; i < t.length; i++) { chars += t[i]; poses.push(pos + i + 1) }
      return false
    }
    return true
  })
  const idx = chars.lastIndexOf(snippet)
  return idx >= 0 ? poses[idx + snippet.length - 1] : -1
}

export function captureRichCaret(view) {
  if (!view) return null
  try {
    // ProseMirror Selection exposes .head directly (unlike CodeMirror's
    // selection.main.head — ProseMirror has no .main).
    const head = view.state.selection.head
    const doc = view.state.doc
    const $head = doc.resolve(head)
    // Snippet = visible text before the caret WITHIN THE CURRENT TEXTBLOCK only
    // (not from doc start). Cross-block snippets broke: textBetween joins blocks
    // with '\n' but source has '\n\n' (blank lines), so the snippet never matched
    // and it fell back to the (drifting) ratio. Within one block the visible text
    // is identical in both modes (no markdown markers in rich) → matches verbatim.
    const snippet = doc.textBetween($head.start(), head).slice(-SNIPPET_LEN)
    const heads = []
    doc.descendants((node, pos) => {
      if (node.type.name === 'heading') { heads.push({ pos, text: node.textContent }); return false }
      return true
    })
    let pick = null
    for (const h of heads) { if (h.pos <= head) pick = h; else break }
    if (pick) {
      const offset = doc.textBetween(pick.pos, head, '\n').length
      return { heading: pick.text, offset, snippet }
    }
    const size = doc.content.size
    return size > 0 ? { ratio: head / size, snippet } : null
  } catch { return null }
}

// Source → ? : capture from the textarea. nearest heading via parseSourceHeadings.
export function captureSourceCaret(textarea) {
  if (!textarea) return null
  const md = textarea.value || ''
  const start = textarea.selectionStart || 0
  // Snippet = visible text before the caret WITHIN THE CURRENT LINE only, markers
  // stripped (so it matches the rich doc's marker-free visible text for that same
  // block). See captureRichCaret for why within-block matters.
  const lineStart = md.lastIndexOf('\n', start - 1) + 1
  const snippet = stripMdForSnippet(md.slice(lineStart, start)).slice(-SNIPPET_LEN)
  let pick = null
  for (const h of parseSourceHeadings(md)) {
    if (h.charOffset <= start) pick = h
    else break
  }
  if (pick) return { heading: pick.text, offset: start - pick.charOffset, snippet }
  return md ? { ratio: start / md.length, snippet } : null
}

// ? → Source: caret at heading start+offset, else after the snippet's last
// occurrence, else the ratio point. Returns true on success.
export function restoreSourceCaret(textarea, anchor) {
  if (!textarea || !anchor) return false
  try {
    const md = textarea.value || ''
    let target
    // Snippet first (most robust — within-block visible text matches verbatim).
    if (anchor.snippet) {
      const idx = md.lastIndexOf(anchor.snippet)
      if (idx >= 0) target = Math.min(idx + anchor.snippet.length, md.length)
    }
    if (target == null && anchor.heading) {
      const h = parseSourceHeadings(md).find((x) => x.text === anchor.heading)
      if (h) {
        // Heading text starts AFTER the "# " marker — charOffset points at the
        // line start (with the marker), so skip it. (Without this the caret landed
        // mid-heading, e.g. "# 一级|标题".)
        const m = md.slice(h.charOffset).match(/^#{1,6}[ \t]+/)
        const textOff = h.charOffset + (m ? m[0].length : 0)
        target = Math.min(textOff + (anchor.offset || 0), md.length)
      }
    }
    if (target == null) target = Math.round((anchor.ratio || 0) * md.length)
    textarea.setSelectionRange(target, target)
    textarea.focus()
    return true
  } catch { return false }
}

// ? → Rich: caret at heading pos+offset, else after the snippet in visible text,
// else the ratio point. TextSelection.near snaps to the closest valid text
// position. Returns true on success.
export function restoreRichCaret(view, anchor) {
  if (!view || !anchor) return false
  try {
    const doc = view.state.doc
    const size = doc.content.size
    let target
    // Snippet first (most robust).
    if (anchor.snippet) {
      const p = posAfterText(doc, anchor.snippet)
      if (p > 0) target = Math.min(p, size)
    }
    if (target == null && anchor.heading) {
      let hpos = -1
      doc.descendants((node, pos) => {
        if (node.type.name === 'heading' && node.textContent === anchor.heading) { hpos = pos; return false }
        return true
      })
      // +1 to skip the heading node's open token (descendants gives the position
      // before the node; content starts at +1). Without it the caret landed one
      // char short inside the heading.
      if (hpos >= 0) target = Math.min(hpos + 1 + (anchor.offset || 0), size)
    }
    if (target == null) target = Math.round((anchor.ratio || 0) * size)
    const $pos = doc.resolve(Math.max(1, Math.min(target, size)))
    view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
    view.focus()
    return true
  } catch { return false }
}
