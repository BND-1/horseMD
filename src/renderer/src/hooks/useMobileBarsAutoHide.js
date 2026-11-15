import { useEffect, useState } from 'react'

// Phones: the top bar and the floating status bar slide away while the
// reader scrolls down — full screen without a button (user request
// 2026-11-15; Safari / Chrome mobile / Feishu) — and come back on any scroll
// up, at the top / end of the document and on a tab switch. The status bar
// also stays away while the keyboard is up (it would cover the line being
// typed); the top bar does not (its tabs stay reachable). Scroll events do not bubble: one capture
// listener on document sees the rich editor's .editor-scroll and the source
// textarea alike.
export function useMobileBarsAutoHide(isMobile, tabId) {
  const [scrollHidden, setScrollHidden] = useState(false)
  const [keyboardUp, setKeyboardUp] = useState(false)
  useEffect(() => { setScrollHidden(false) }, [tabId])
  useEffect(() => {
    if (!isMobile) return undefined
    const last = new WeakMap()
    const onScroll = (event) => {
      const el = event.target
      if (!(el instanceof Element) || !el.closest('.pane-center')) return
      const top = el.scrollTop
      const prev = last.has(el) ? last.get(el) : top
      last.set(el, top)
      const atEnd = top + el.clientHeight >= el.scrollHeight - 4
      if (top <= 8 || atEnd) { setScrollHidden(false); return }
      const delta = top - prev
      if (Math.abs(delta) < 6) return
      setScrollHidden(delta > 0)
    }
    document.addEventListener('scroll', onScroll, true)
    // Keyboard: the WebView shrinks (Android adjustResize / iOS visual
    // viewport) by far more than any toolbar does.
    const vv = window.visualViewport
    let tallest = vv ? vv.height : window.innerHeight
    const onResize = () => {
      const h = vv ? vv.height : window.innerHeight
      tallest = Math.max(tallest, h)
      setKeyboardUp(h < tallest - 150)
    }
    ;(vv || window).addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      ;(vv || window).removeEventListener('resize', onResize)
    }
  }, [isMobile])
  return { scrollHidden: isMobile && scrollHidden, keyboardUp: isMobile && keyboardUp }
}

