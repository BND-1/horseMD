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
      const val = textarea.value
      if (val !== mirroredValue) {
        mirrorText.data = val + '\u200b'
        mirroredValue = val
      }
      range.setStart(mirrorText, Math.max(0, Math.min(start, val.length)))
      range.collapse(true)
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
      bar.style.left = Math.round(screenX - (CARET_WIDTH - 1) / 2) + 'px'
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

  const events = ['input', 'click', 'keydown', 'keyup', 'select', 'scroll', 'focus', 'blur']
  events.forEach((e) => textarea.addEventListener(e, schedule, { passive: true }))
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
    doc.defaultView.removeEventListener('resize', schedule)
    resizeObserver.disconnect()
    doc.removeEventListener('selectionchange', schedule)
    textarea.classList.remove('hm-source-caret-on')
    bar.remove()
    mirror.remove()
  }
}
