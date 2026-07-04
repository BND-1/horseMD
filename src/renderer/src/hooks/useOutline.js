// Outline panel: heading list + scrollspy + click-to-jump (issue #20).
// Extracted verbatim in behavior from App.jsx (phase-2 refactor, US-3).
//
// The scrollspy is reflow-free: each heading's content-offset is measured ONCE
// (a single layout pass, rebuilt every 2s / on resize), then compared against
// the cheap scrollTop on scroll. No getBoundingClientRect per frame → no main-
// thread freeze / scroll "chase" (#17) on large docs. This MUST stay reflow-free.
//
// richDocVersion is bumped by the Editor's onStructureChange (chunked load
// finish) so the list + scrollspy refresh against the complete DOM; richLoading
// drives the outline skeleton. Both setters are returned for the Editor JSX.
//
// Options:
//   editorHostRef — ref to the active rich editor's scroll container
//   home / sidebarOpen / sidebarMode / sourceMode / activeId / activeTab — view state
//   isMobile / setSidebarOpen / setHome — drawer affordances for jumpToHeading
import { useCallback, useEffect, useRef, useState } from 'react'

// Shared heading selector — used by jumpToHeading, the scrollspy, and the list
// reader. Keeping it in one place ensures they all agree on what counts as a
// heading (ATX, Setext, and HTML <h1>…<h6> rendered by the editor).
const HEADING_SEL = '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6'
const getHeadings = (host) => (host ? [...host.querySelectorAll(HEADING_SEL)] : [])

export function useOutline({ editorHostRef, home, sidebarOpen, sidebarMode, sourceMode, activeId, activeTab, isMobile, setSidebarOpen, setHome }) {
  const [activeHeading, setActiveHeading] = useState(-1)
  // Bumped when a chunked-loaded rich doc finishes streaming in (Editor's
  // onStructureChange) so the outline list + scrollspy refresh against the now-
  // complete DOM — during load onChange is suppressed, so they can't track the
  // growing doc via content alone. richLoading drives the outline skeleton.
  const [richDocVersion, setRichDocVersion] = useState(0)
  const [richLoading, setRichLoading] = useState(false)
  const [outlineHeadings, setOutlineHeadings] = useState([])
  // A jump requested while the editor was still loading (chunked parse). Held
  // here and executed once loading finishes — heading offsets aren't stable
  // mid-load, so jumping immediately would land wrong + fight the content stream.
  const pendingJumpRef = useRef(null)

  // --------------------------- outline jump ------------------------
  const jumpToHeading = useCallback((index) => {
    // Make sure the document (not the Home page) is showing — otherwise the
    // active editor is hidden and editorHostRef isn't attached, so the jump
    // would silently do nothing. setHome(false) is a no-op when already not home.
    setHome(false)
    // On mobile the outline lives in the drawer; close it so the jumped-to
    // content is actually visible instead of hidden behind the drawer.
    if (isMobile) setSidebarOpen(false)
    // If the rich editor is still loading (chunked parse on a large doc), queue
    // the jump — heading offsets shift as content streams in, so scrolling now
    // would be imprecise + janky. Drained by the effect below on load finish.
    if (richLoading) {
      pendingJumpRef.current = index
      return
    }
    const doJump = () => {
      const hs = getHeadings(editorHostRef.current)
      const el = hs[index]
      if (!el) return false
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return true
    }
    // Works synchronously in the normal case; if we just left Home, the editor
    // needs a frame to re-render and re-attach the ref before we can scroll it.
    if (doJump()) return
    requestAnimationFrame(() => {
      if (!doJump()) requestAnimationFrame(doJump)
    })
  }, [setHome, isMobile, setSidebarOpen, richLoading])

  // Drain a queued jump once the editor finishes loading (richLoading false +
  // richDocVersion bumped). Use 'auto' (instant) — the doc just finished
  // rendering, smooth would animate on top of the settle.
  useEffect(() => {
    if (richLoading || pendingJumpRef.current == null) return
    const index = pendingJumpRef.current
    pendingJumpRef.current = null
    const el = getHeadings(editorHostRef.current)[index]
    if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' })
  }, [richLoading, richDocVersion])

  // Outline scrollspy: highlight the heading you're currently viewing (the last
  // one scrolled past the top), mirroring how the file tree marks the open file.
  // Rich editor only — editorHostRef is the active pane's .editor-scroll; in
  // source mode it isn't attached, so the outline shows no active item there.
  useEffect(() => {
    if (home || !sidebarOpen || sidebarMode !== 'outline' || sourceMode) {
      setActiveHeading(-1)
      return
    }
    const scroller = editorHostRef.current
    if (!scroller) return

    // Reflow-free scrollspy. The previous version re-queried and called
    // getBoundingClientRect() on EVERY heading on every throttle tick. On a
    // large doc each call forces a full-document layout recalc, which
    // (a) froze the main thread during scroll (#17 "chase" lag) and (b) used a
    // leading-edge-only throttle with no trailing update — so when scrolling
    // stopped the last compute was up to 300ms stale and the outline landed on
    // the WRONG heading. Fix: measure each heading's content-offset ONCE (a
    // single layout pass, rebuilt every 2s / on resize), then compare against
    // the cheap scrollTop on scroll. No layout read per frame, so it can update
    // every frame and always reflects the exact current position.
    let tops = null // heading content-offsets (px from content top); stable across scroll
    let builtAt = 0
    let raf = 0
    let lastIdx = -1
    let tries = 0

    const build = () => {
      const els = getHeadings(scroller)
      if (!els.length) {
        tops = null
        return
      }
      // Read every rect in one synchronous block = ONE reflow, not N. Convert
      // each to a content-offset (Y = rect.top − scroller.top + scrollTop); Y is
      // invariant under scrolling, so the cache stays valid while scrolling.
      const base = scroller.getBoundingClientRect().top
      const top0 = scroller.scrollTop
      tops = new Array(els.length)
      for (let i = 0; i < els.length; i++) tops[i] = els[i].getBoundingClientRect().top - base + top0
      builtAt = Date.now()
    }
    const compute = () => {
      raf = 0
      const now = Date.now()
      if (!tops || now - builtAt > 2000) {
        build()
        if (!tops) {
          // Editor still mounting (no headings yet) — retry briefly.
          if (tries++ < 30) raf = requestAnimationFrame(compute)
          return
        }
        tries = 0
      }
      // scrollTop is a cheap scroll-offset read — no layout, no reflow — so this
      // can run every frame without freezing and lands on the exact heading.
      const limit = scroller.scrollTop + 90
      let idx = 0
      for (let i = 0; i < tops.length; i++) {
        if (tops[i] <= limit) idx = i
        else break
      }
      if (idx !== lastIdx) {
        lastIdx = idx
        setActiveHeading(idx) // only re-render the outline when the active row actually changes
      }
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute) // coalesce to ≤ once per frame
    }
    compute()
    scroller.addEventListener('scroll', schedule, { passive: true })
    // Resize (and the layout-settings popover) reflow heading offsets → rebuild.
    const invalidate = () => {
      tops = null
      schedule()
    }
    window.addEventListener('resize', invalidate, { passive: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', invalidate)
    }
  }, [home, sidebarOpen, sidebarMode, sourceMode, activeId, richDocVersion, editorHostRef])

  // Outline heading list, taken from the RENDERED document (the editor's actual
  // h1…h6 elements) — not regex'd from the markdown string. This matches how
  // jumpToHeading finds them, so the two stay in sync, and it recognizes every
  // heading the editor renders (ATX `#`, Setext, and HTML <h1>) regardless of
  // how the source wrote it.
  useEffect(() => {
    if (home || !activeTab) {
      setOutlineHeadings([])
      return
    }
    // During chunked load the DOM has only partial headings — wait for
    // richDocVersion bump (load finish) before reading, so the outline shows
    // the COMPLETE list (the loading skeleton covers the wait via richLoading).
    if (richLoading) return
    // Debounce: the effect re-runs on every content change (every keystroke).
    // On large docs the querySelectorAll scan is expensive. Wait 500ms after the
    // last edit before scanning — headings don't change mid-word.
    let timer = 0
    const read = () => {
      timer = 0
      const els = getHeadings(editorHostRef.current)
      // No editor mounted (e.g. just closed the file) → clear instead of
      // leaving the previous document's outline hanging (issue #20).
      if (!els.length) {
        setOutlineHeadings([])
        return
      }
      setOutlineHeadings(
        els.map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent || '').trim() }))
      )
    }
    timer = setTimeout(read, 500)
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [home, activeId, activeTab, sourceMode, richDocVersion, richLoading, editorHostRef])

  return {
    activeHeading,
    outlineHeadings,
    richDocVersion,
    richLoading,
    setRichDocVersion,
    setRichLoading,
    jumpToHeading
  }
}
