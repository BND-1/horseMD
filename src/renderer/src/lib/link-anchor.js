// Links inside documents (Typora parity): `[x](#标题)` jumps to a heading of
// the same document, `[x](other.md#标题)` opens other.md in HorseMD and jumps
// there. Anchors match a heading's id or its GitHub/Typora-style slug
// (lower case, punctuation removed, spaces → "-", repeats get "-1", "-2"…).
import { revealFoldedContent } from '../find.js'

// App-level request to open a Markdown document from a link: { path, anchor }.
export const HM_OPEN_DOCUMENT_EVENT = 'hm:open-document'

export function headingSlug(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

// `other.md#a%20b` → { path: 'other.md', anchor: 'a b' }.
export function splitLinkHash(href) {
  const text = String(href || '')
  const i = text.indexOf('#')
  if (i < 0) return { path: text, anchor: '' }
  let anchor = text.slice(i + 1)
  try { anchor = decodeURIComponent(anchor) } catch { /* keep as written */ }
  return { path: text.slice(0, i), anchor }
}

export function findHeadingByAnchor(root, anchor) {
  const key = String(anchor || '').replace(/^#/, '').trim()
  if (!root || !key) return null
  const headings = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')]
  const byId = headings.find((h) => h.id === key)
  if (byId) return byId
  const target = headingSlug(key)
  if (!target) return null
  const seen = new Map()
  for (const heading of headings) {
    const base = headingSlug(heading.textContent)
    const count = seen.get(base) || 0
    seen.set(base, count + 1)
    if (base === target || (count > 0 && `${base}-${count}` === target)) return heading
  }
  return null
}

// Scroll a heading to the top, then again while images / diagrams above it
// settle (like the outline's jump). The user's own scrolling, click or key
// ends it at once.
let stopRunning = null
export function scrollHeadingIntoView(el) {
  if (!el) return
  stopRunning?.()
  revealFoldedContent(el)
  const userEvents = ['wheel', 'mousedown', 'keydown', 'touchstart']
  let timer = 0
  const stop = () => {
    clearTimeout(timer)
    userEvents.forEach((type) => window.removeEventListener(type, stop, true))
    if (stopRunning === stop) stopRunning = null
  }
  stopRunning = stop
  userEvents.forEach((type) => window.addEventListener(type, stop, true))
  let last = null
  let stable = 0
  let tries = 0
  const step = () => {
    if (!el.isConnected) return stop()
    el.scrollIntoView({ block: 'start' })
    const top = Math.round(el.getBoundingClientRect().top)
    stable = top === last ? stable + 1 : 0
    last = top
    if (stable < 2 && ++tries < 15) timer = setTimeout(step, 150)
    else stop()
  }
  step()
}
