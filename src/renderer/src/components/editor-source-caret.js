import { syncTextareaMirrorStyle } from '../textarea-metrics.js'

// A thicker, taller caret for the source-mode textarea.
//
// Native textarea carets can't be thickened via CSS (`caret-color` only sets
// color), so we hide the native caret (caret-color: transparent on .source-editor
// while this is active) and draw our own: a 3px-wide blinking bar positioned at
// the caret's pixel coordinates.
//
// Position is computed with the classic "mirror div" technique: an invisible
// clone of the textarea (same font/padding/client width/wrapping) contains one
// text node. A collapsed DOM Range measures the exact character position.
//
// Robustness: any sync error hides the bar for that frame (the user briefly sees
// no caret, never a misplaced one). On detach the native caret is restored.
const CARET_WIDTH = 3 // px (native is ~1px)

export function attachSourceCaret(textarea) {
  if (!textarea) return () => {}
  const doc = textarea.ownerDocument

  const bar = doc.createElement('div')
  bar.className = 'hm-source-caret'
  bar.style.display = 'none'
  doc.body.appendChild(bar)

  const mirror = doc.createElement('div')
  mirror.className = 'hm-source-caret-mirror'
  const mirrorText = doc.createTextNode('\u200b')
  mirror.appendChild(mirrorText)
  doc.body.appendChild(mirror)
  const range = doc.createRange()

  let mirroredValue = null

  const syncMirrorText = () => {
    const val = textarea.value
    if (val !== mirroredValue) {
      mirrorText.data = val + '\u200b'
      mirroredValue = val
    }
    return val
  }

  let raf = 0
  let fallbackTimer = 0
  const hide = () => { bar.style.display = 'none' }

  const sync = () => {
    if (fallbackTimer) doc.defaultView.clearTimeout(fallbackTimer)
    fallbackTimer = 0
    raf = 0
    try {
      if (doc.activeElement !== textarea) return hide()
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      // Only show for a collapsed caret (a selection range has no blinking caret).
      if (start !== end) return hide()
      const cs = syncTextareaMirrorStyle(textarea, mirror)
      const val = syncMirrorText()
      const offset = Math.max(0, Math.min(start, val.length))
      const lineStart = val.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
      // Chromium reports the collapsed Range at the *right* edge of the first
      // glyph after a newline. At a logical line start measure the first glyph
      // itself and use its left edge; this is both the correct visual caret
      // boundary and avoids a `## heading` caret appearing after the first #.
      if (offset === lineStart && offset < val.length && val[offset] !== '\n') {
        range.setStart(mirrorText, offset)
        range.setEnd(mirrorText, offset + 1)
      } else {
        range.setStart(mirrorText, offset)
        range.collapse(true)
      }
      const mRect = range.getBoundingClientRect()
      const baseRect = mirror.getBoundingClientRect()
      const taRect = textarea.getBoundingClientRect()
      // caret position within textarea content = marker offset within mirror.
      const xInMirror = mRect.left - baseRect.left
      const yInMirror = mRect.top - baseRect.top
      // Translate to screen, accounting for the textarea's own scroll + borders.
      const screenX = taRect.left + xInMirror - textarea.scrollLeft
      const screenY = taRect.top + yInMirror - textarea.scrollTop
      const fontPx = parseFloat(cs.fontSize) || 14
      const linePx = parseFloat(cs.lineHeight) || fontPx * 1.75
      const halfLead = Math.max(0, (linePx - fontPx) / 2)
      const caretHeight = linePx + 4
      const caretTop = screenY - halfLead - 2
      const inset = 2
      if (screenX < taRect.left + inset || screenX > taRect.right - inset ||
          caretTop + caretHeight < taRect.top + inset || caretTop > taRect.bottom - inset) {
        return hide()
      }
      // A wide custom caret must sit wholly *before* the character boundary.
      // Centering a 3px bar on the boundary paints over the first glyph (most
      // noticeable at the beginning of a non-empty line) and makes a real
      // offset-0 selection look as though it is after the first character.
      bar.style.left = Math.round(screenX - CARET_WIDTH) + 'px'
      bar.style.top = Math.round(caretTop) + 'px'
      bar.style.width = `${CARET_WIDTH}px`
      bar.style.height = Math.round(caretHeight) + 'px'
      bar.style.display = ''
    } catch {
      hide()
    }
  }

  const schedule = () => {
    if (!raf) raf = doc.defaultView.requestAnimationFrame(sync)
    // Electron throttles rAF when a test/background window is occluded. Do not
    // let a pending frame permanently block later click/scroll synchronization.
    if (!fallbackTimer) {
      fallbackTimer = doc.defaultView.setTimeout(() => {
        fallbackTimer = 0
        if (raf) doc.defaultView.cancelAnimationFrame(raf)
        raf = 0
        sync()
      }, 80)
    }
  }

  // Chromium can resolve a click on the leading edge of a visible glyph to the
  // position *after* that glyph, especially for Markdown punctuation such as
  // the first `#` in a heading. That is an unusable hit target in a source
  // editor: users need to be able to place the caret before the first marker.
  // Keep native textarea editing everywhere else, but snap only a collapsed
  // click that Chromium placed immediately after a non-empty logical line's
  // first character and whose pointer was inside that character's leading hit
  // area. The mirror gives the same wrapping/font geometry as the textarea.
  const snapLeadingCharacterClick = (event) => {
    if (event.button !== 0 || textarea.selectionStart !== textarea.selectionEnd) return
    try {
      const selected = textarea.selectionStart
      const val = syncMirrorText()
      const lineStart = val.lastIndexOf('\n', Math.max(0, selected - 1)) + 1
      if (selected <= lineStart || selected > lineStart + 1 || lineStart >= val.length || val[lineStart] === '\n') return

      const cs = syncTextareaMirrorStyle(textarea, mirror)
      range.setStart(mirrorText, lineStart)
      range.setEnd(mirrorText, lineStart + 1)
      const glyph = range.getBoundingClientRect()
      const base = mirror.getBoundingClientRect()
      const bounds = textarea.getBoundingClientRect()
      const glyphLeft = bounds.left + glyph.left - base.left - textarea.scrollLeft
      const glyphTop = bounds.top + glyph.top - base.top - textarea.scrollTop
      const glyphWidth = Math.max(glyph.width, parseFloat(cs.fontSize) * 0.65)
      const inLeadingHitArea =
        event.clientX >= glyphLeft - 3 &&
        event.clientX <= glyphLeft + glyphWidth &&
        event.clientY >= glyphTop - 3 &&
        event.clientY <= glyphTop + Math.max(glyph.height, parseFloat(cs.lineHeight) || 0) + 3
      if (!inLeadingHitArea) return

      textarea.setSelectionRange(lineStart, lineStart)
      schedule()
    } catch {
      // Native textarea placement remains the safe fallback if measurement is
      // temporarily unavailable during a layout transition.
    }
  }

  const events = ['input', 'click', 'keydown', 'keyup', 'select', 'scroll', 'focus', 'blur']
  events.forEach((e) => textarea.addEventListener(e, schedule, { passive: true }))
  textarea.addEventListener('mouseup', snapLeadingCharacterClick)
  doc.defaultView.addEventListener('resize', schedule)
  const resizeObserver = new doc.defaultView.ResizeObserver(schedule)
  resizeObserver.observe(textarea)
  // Also re-sync on any selectionchange (covers arrow-key moves without a dedicated event).
  doc.addEventListener('selectionchange', schedule)

  // Hide the native caret while we're drawing ours.
  textarea.classList.add('hm-source-caret-on')
  schedule()
  // The vertical scrollbar can claim width after the textarea's first layout.
  // Re-measure across settling frames so a restored caret is correct before the
  // user clicks or types.
  const settleTimers = [0, 100, 400].map((delay) => doc.defaultView.setTimeout(schedule, delay))

  return () => {
    if (raf) doc.defaultView.cancelAnimationFrame(raf)
    if (fallbackTimer) doc.defaultView.clearTimeout(fallbackTimer)
    settleTimers.forEach((timer) => doc.defaultView.clearTimeout(timer))
    events.forEach((e) => textarea.removeEventListener(e, schedule))
    textarea.removeEventListener('mouseup', snapLeadingCharacterClick)
    doc.defaultView.removeEventListener('resize', schedule)
    resizeObserver.disconnect()
    doc.removeEventListener('selectionchange', schedule)
    textarea.classList.remove('hm-source-caret-on')
    bar.remove()
    mirror.remove()
  }
}
