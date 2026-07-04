// Heading-based scroll anchor for preserving reading position across rich↔source
// mode switches (#28). The scroll-RATIO approach is imprecise because rich
// (code/images render tall) and source (compact text) have non-linearly
// corresponding heights — the same ratio lands on different sections. Heading
// TEXT is content-stable across modes, so we anchor on it instead (ratio is the
// fallback when no heading is near the viewport top).
//
// Shared with the outline (getHeadings) for DRY.

const HEADING_SEL = '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6'

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
// using char-position ratio (robust against line wrapping).
export function headingAtSourceTop(textarea, md) {
  if (!textarea || !md) return null
  const denom = textarea.scrollHeight - textarea.clientHeight
  if (denom <= 0) return null
  const approxChar = Math.round((textarea.scrollTop / denom) * md.length)
  const re = /^#{1,6}\s+(.+)$/gm
  let best = null
  let m
  while ((m = re.exec(md)) !== null) {
    if (m.index <= approxChar) best = m[1].trim()
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
