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
    const maxScroll = Math.max(0, textarea.scrollHeight - textarea.clientHeight)
    // Keep the active hit unmistakably visible. Minimal edge scrolling put the
    // hit near the status bar and looked like no navigation on tall windows.
    textarea.scrollTop = Math.max(0, Math.min(maxScroll, y - (textarea.clientHeight - linePx) / 2))
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
    let fallbackTimer = 0
    const schedule = () => {
      if (!raf) {
        raf = doc.defaultView.requestAnimationFrame(() => {
          raf = 0
          renderSourceFindHighlight(textarea)
        })
      }
      // Electron can throttle rAF for an occluded/background window. Mirror
      // the source-caret fallback so a pending frame cannot hide the find hit.
      if (!fallbackTimer) {
        fallbackTimer = doc.defaultView.setTimeout(() => {
          fallbackTimer = 0
          if (raf) doc.defaultView.cancelAnimationFrame(raf)
          raf = 0
          renderSourceFindHighlight(textarea)
        }, 80)
      }
    }
    const events = ['scroll', 'input']
    events.forEach((event) => textarea.addEventListener(event, schedule, { passive: true }))
    doc.defaultView.addEventListener('resize', schedule)
    textarea.__horsemdSourceFindCleanup = () => {
      if (raf) doc.defaultView.cancelAnimationFrame(raf)
      if (fallbackTimer) doc.defaultView.clearTimeout(fallbackTimer)
      events.forEach((event) => textarea.removeEventListener(event, schedule))
      doc.defaultView.removeEventListener('resize', schedule)
      delete textarea.__horsemdSourceFindCleanup
      delete textarea.__horsemdSourceFindRange
      clearSourceFindMarks(doc)
    }
  }
  renderSourceFindHighlight(textarea)
}

export function revealSourceFindMatch(textarea, start, end) {
  if (!textarea || !Number.isInteger(start) || !Number.isInteger(end)) return false
  textarea.setSelectionRange(start, end)
  scrollTextareaOffsetIntoView(textarea, start)
  paintSourceFindHighlight(textarea, start, end)
  return true
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

// ---------------------------------------------------------------------------
// Match options (VSCode-style find toggles):
//   matchCase — case-sensitive matching (default: case-insensitive)
//   wholeWord — match only at non-word boundaries (Unicode-aware)
//   regex     — treat the query as a regular expression
// Multiline is inherent: plain queries may contain \n and regexes compile with
// the `m` flag so ^/$ anchor per line. Empty matches are always skipped.
const WORD_CHAR = /[\p{L}\p{N}_]/u
const MAX_FIND_MATCHES = 50000

const isWordCharAt = (text, index) => {
  const ch = text[index]
  return ch !== undefined && WORD_CHAR.test(ch)
}

const isWordBounded = (text, start, end) =>
  !isWordCharAt(text, start - 1) && !isWordCharAt(text, end)

export function compileFindMatcher(query, { matchCase = false, wholeWord = false, regex = false } = {}) {
  if (!query) return { error: 'empty-query' }
  if (regex) {
    let re
    try {
      re = new RegExp(query, `gm${matchCase ? '' : 'i'}`)
    } catch {
      return { error: 'invalid-regex' }
    }
    return {
      findIn(text) {
        const out = []
        let m
        re.lastIndex = 0
        while ((m = re.exec(text)) && out.length < MAX_FIND_MATCHES) {
          if (m[0] && (!wholeWord || isWordBounded(text, m.index, m.index + m[0].length))) {
            out.push({ start: m.index, end: m.index + m[0].length })
          }
          if (re.lastIndex === m.index) re.lastIndex += 1
        }
        return out
      }
    }
  }
  const needle = matchCase ? query : query.toLowerCase()
  return {
    findIn(text) {
      const out = []
      if (!text) return out
      const hay = matchCase ? text : text.toLowerCase()
      let idx = hay.indexOf(needle)
      while (idx !== -1 && out.length < MAX_FIND_MATCHES) {
        const end = idx + query.length
        if (!wholeWord || isWordBounded(text, idx, end)) out.push({ start: idx, end })
        idx = hay.indexOf(needle, idx + query.length)
      }
      return out
    }
  }
}

// Replacement text for one match. Plain mode inserts the string verbatim;
// regex mode applies it as a replacement template ($1…$9, $&, $$) against the
// matched text itself, exactly like String.replace with capture groups.
export function expandReplacement(matchedText, replacement, query, { matchCase = false, regex = false } = {}) {
  if (!regex) return replacement
  try {
    return matchedText.replace(new RegExp(query, `m${matchCase ? '' : 'i'}`), replacement)
  } catch {
    return replacement
  }
}

// Rich-editor scan: build one concatenated string over the root's text nodes
// (with a \n separator between block-level runs so queries can match across
// inline formatting boundaries but not accidentally across paragraphs), run the
// unified matcher on it, then map each hit back to a DOM Range. `clampRange`
// restricts the scan to a selection Range (find-in-selection); boundary text
// nodes contribute only their selected part.
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DD', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TD', 'TH', 'TR', 'UL'
])

const innermostBlockOf = (node, root) => {
  let el = node.parentElement
  let block = null
  while (el && el !== root) {
    if (BLOCK_TAGS.has(el.tagName) || el.classList?.contains('cm-line')) block = el
    el = el.parentElement
  }
  return block
}

function textNodeIntervalInRange(node, range) {
  const len = node.nodeValue.length
  // comparePoint: -1 = point before the range, 0 = inside, 1 = after the end.
  if (range.comparePoint(node, 0) > 0) return null // node starts after the range
  if (range.comparePoint(node, len) < 0) return null // node ends before the range
  const from = range.startContainer === node ? range.startOffset : 0
  const to = range.endContainer === node ? range.endOffset : len
  return [Math.min(from, to), Math.max(from, to)]
}

function buildTextIndex(root, clampRange) {
  const spans = []
  let text = ''
  let lastBlock
  let started = false
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    let from = 0
    let to = node.nodeValue ? node.nodeValue.length : 0
    if (to <= from) continue
    if (clampRange) {
      const interval = textNodeIntervalInRange(node, clampRange)
      if (!interval) continue
      ;[from, to] = interval
      if (to <= from) continue
    }
    const block = innermostBlockOf(node, root)
    if (started && block !== lastBlock) text += '\n'
    lastBlock = block
    started = true
    spans.push({ node, from, start: text.length, end: text.length + (to - from) })
    text += node.nodeValue.slice(from, to)
  }
  return { text, spans }
}

function locatePoint(spans, idx) {
  if (!spans.length) return null
  for (const span of spans) {
    if (span.start <= idx && idx <= span.end) {
      return { node: span.node, offset: span.from + Math.min(idx - span.start, span.end - span.start) }
    }
  }
  const last = spans[spans.length - 1]
  return { node: last.node, offset: last.from + (last.end - last.start) }
}

// Returns { ranges, matchTexts }: DOM Ranges for highlight/navigate/replace,
// plus each match's source text as it appeared in the concatenated scan (regex
// replacement templates must replay against text that keeps block separators).
export function findRangesInEl(root, query, opts = {}, clampRange = null) {
  const ranges = []
  const matchTexts = []
  if (!root || !query) return { ranges, matchTexts }
  const matcher = compileFindMatcher(query, opts)
  if (matcher.error) return { ranges, matchTexts }
  const { text, spans } = buildTextIndex(root, clampRange)
  for (const { start, end } of matcher.findIn(text)) {
    if (end <= start) continue
    const s = locatePoint(spans, start)
    const e = locatePoint(spans, end)
    if (!s || !e) continue
    try {
      const r = document.createRange()
      r.setStart(s.node, s.offset)
      r.setEnd(e.node, e.offset)
      if (!r.collapsed) {
        ranges.push(r)
        matchTexts.push(text.slice(start, end))
      }
    } catch {
      // Boundary resolution can theoretically land on an invalid container;
      // skip that hit rather than break the whole search.
    }
  }
  return { ranges, matchTexts }
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
// Character-offset matches in a plain string (source textarea). Returns
// [{ start, end }] so regex matches of variable length carry their own extent.
export function matchIndices(text, query, opts = {}) {
  if (!text || !query) return []
  const matcher = compileFindMatcher(query, opts)
  return matcher.error ? [] : matcher.findIn(text)
}
