// Outline panel: heading list + scrollspy + click-to-jump (issue #20).
// Extracted verbatim in behavior from App.jsx (phase-2 refactor, US-3).
//
// The scrollspy is reflow-free: each heading's content-offset is measured ONCE
// (a single layout pass, rebuilt every 2s / on resize), then compared against
// the cheap scrollTop on scroll. No getBoundingClientRect per frame → no main-
// thread freeze / scroll "chase" (#17) on large docs. This MUST stay reflow-free.
//
// richDocVersion is bumped by the Editor's onStructureChange (chunked load
// finish) so the list + scrollspy refresh against the complete DOM. The caller
// supplies the focused tab's loading state so hidden mounted tabs cannot leak in.
//
// Options:
//   getEditorHost / getSourceTextarea — resolve the focused split pane by tab id
//   home / sidebarOpen / sidebarMode / sourceMode / activeId / activeTab — view state
//   isMobile / setSidebarOpen / setHome — drawer affordances for jumpToHeading
import { useCallback, useEffect, useRef, useState } from 'react'
import { parseSourceHeadings, scrollSourceToHeading } from '../scrollAnchor.js'
import { textareaOffsetAtScrollTop } from '../textarea-metrics.js'

// Shared heading selector — used by jumpToHeading, the scrollspy, and the list
// reader. Keeping it in one place ensures they all agree on what counts as a
// heading (ATX, Setext, and HTML <h1>…<h6> rendered by the editor).
const HEADING_SEL = '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6'
const getHeadings = (host) => (host ? [...host.querySelectorAll(HEADING_SEL)] : [])

export function useOutline({ getEditorHost, getSourceTextarea, home, sidebarOpen, sidebarMode, sourceMode, activeId, activeTab, richLoading = false, isMobile, setSidebarOpen, setHome, floating = false }) {
  const [activeHeading, setActiveHeading] = useState(-1)
  // Bumped when a chunked-loaded rich doc finishes streaming in (Editor's
  // onStructureChange) so the outline list + scrollspy refresh against the now-
  // complete DOM — during load onChange is suppressed, so they can't track the
  // growing doc via content alone. richLoading drives the outline skeleton.
  const [richDocVersion, setRichDocVersion] = useState(0)
  const [outlineHeadings, setOutlineHeadings] = useState([])
  // Bumped on source-mode textarea input so the heading list refreshes as the
  // user types a new heading (rich mode re-reads the DOM on structure change;
  // source mode has no such hook, so we listen to the textarea ourselves).
  const [sourceOutlineVersion, setSourceOutlineVersion] = useState(0)
  // Focus/mode changes must replace the visible outline immediately. Content
  // edits in the same document remain debounced to avoid scanning a large DOM
  // on every keystroke.
  const outlineTargetRef = useRef(null)
  // A jump requested while the editor was still loading (chunked parse). Held
  // here and executed once loading finishes — heading offsets aren't stable
  // mid-load, so jumping immediately would land wrong + fight the content stream.
  const pendingJumpRef = useRef(null)
  // Timer for restoring overflow-anchor after a jump (see jumpAndStabilize).
  const anchorTimerRef = useRef(0)
  // After a jump, force the scrollspy to highlight the clicked heading (the
  // tops cache may be stale mid-content-settle → wrong active heading). Set by
  // jumpAndStabilize; the scrollspy's compute() honors it until cleared.
  const forcedActiveRef = useRef(null)

  // Scroll to a heading, then poll until the position stabilizes. Async content
  // (images/mermaid/KaTeX/CV estimate→real) keeps shifting scrollTop after the
  // jump — re-scroll until 2 consecutive checks agree. overflow-anchor is
  // disabled during the poll (it fights programmatic scroll) + restored once
  // stable. Instant (not smooth) — smooth's duration is unpredictable on large
  // docs + competes with anchoring during the animation.
  const jumpAndStabilize = (host, el) => {
    if (!host || !el) return false
    forcedActiveRef.current = getHeadings(host).indexOf(el)
    host.style.overflowAnchor = 'none'
    clearTimeout(anchorTimerRef.current)

    // Target scrollTop: heading at the top of the scroller.
    const targetTop = el.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop

    // Phase 2: poll-and-stabilize (corrects drift from async content settling).
    let lastST = -1
    let stable = 0
    const poll = () => {
      el.scrollIntoView({ block: 'start' })
      const st = host.scrollTop
      if (Math.abs(st - lastST) < 3) {
        if (++stable >= 2) { host.style.overflowAnchor = ''; forcedActiveRef.current = null; return }
      } else stable = 0
      lastST = st
      anchorTimerRef.current = setTimeout(poll, 200)
    }

    // Phase 1: custom ease-out scroll (NOT behavior:'smooth' — that's unpredictable
    // on large docs + fights overflow-anchor). Duration proportional to distance
    // (short hops ~200ms, big jumps up to 500ms), capped. Feels designed, stays
    // precise. If already there (<5px), skip straight to the poll.
    const distance = Math.abs(targetTop - host.scrollTop)
    if (distance < 5) { lastST = -1; stable = 0; poll(); return true }
    const duration = Math.min(500, Math.max(200, distance / 8))
    const startTop = host.scrollTop
    const t0 = performance.now()
    const ease = (t) => 1 - Math.pow(1 - t, 3) // ease-out cubic: snappy start, smooth settle
    const animate = () => {
      const t = Math.min(1, (performance.now() - t0) / duration)
      host.scrollTop = startTop + (targetTop - startTop) * ease(t)
      if (t < 1) requestAnimationFrame(animate)
      else { lastST = -1; stable = 0; poll() }
    }
    requestAnimationFrame(animate)
    return true
  }

  // --------------------------- outline jump ------------------------
  const jumpToHeading = useCallback((index) => {
    setHome(false)
    if (isMobile) setSidebarOpen(false)
    // Source mode: scroll the textarea to the heading by text (#40). No chunked
    // load / async settle here, so no queue — just scroll + set active at once.
    if (sourceMode) {
      const ta = getSourceTextarea()
      if (ta) {
        const hs = parseSourceHeadings(ta.value || '')
        const heading = hs[index]
        if (heading) scrollSourceToHeading(ta, ta.value || '', heading)
      }
      setActiveHeading(index)
      return
    }
    if (richLoading) {
      pendingJumpRef.current = index
      return
    }
    const doJump = () => {
      const host = getEditorHost()
      if (!host) return false
      const el = getHeadings(host)[index]
      if (!el) return false
      return jumpAndStabilize(host, el)
    }
    if (doJump()) return
    requestAnimationFrame(() => {
      if (!doJump()) requestAnimationFrame(doJump)
    })
  }, [setHome, isMobile, setSidebarOpen, richLoading, sourceMode, getEditorHost, getSourceTextarea])

  // Drain a queued jump once the editor finishes loading. Uses the same
  // poll-and-stabilize logic as jumpToHeading (async content may still settle
  // after the chunked parse completes).
  useEffect(() => {
    if (richLoading || pendingJumpRef.current == null) return
    const index = pendingJumpRef.current
    pendingJumpRef.current = null
    const host = getEditorHost()
    if (host) jumpAndStabilize(host, getHeadings(host)[index])
  }, [richLoading, richDocVersion])

  // Outline scrollspy: highlight the heading you're currently viewing (the last
  // one scrolled past the top), mirroring how the file tree marks the open file.
  // Rich editor: reflow-free offset cache against the live DOM. Source mode
  // (#40): no DOM headings, so map scrollTop→char and find the nearest heading
  // via parseSourceHeadings (scrollTop→char ratio, nearest-heading match).
  useEffect(() => {
    const isTracking = (sidebarOpen && sidebarMode === 'outline') || floating
    if (home || !isTracking) {
      setActiveHeading(-1)
      return
    }
    // ----- source-mode spy -----
    if (sourceMode) {
      const ta = getSourceTextarea()
      if (!ta) return
      let timer = 0
      let lastIdx = -1
      const compute = () => {
        timer = 0
        const md = ta.value || ''
        const hs = parseSourceHeadings(md)
        if (!hs.length) { if (lastIdx !== -1) { lastIdx = -1; setActiveHeading(-1) } return }
        let approxChar = 0
        try {
          approxChar = textareaOffsetAtScrollTop(ta)
        } catch {
          const denom = ta.scrollHeight - ta.clientHeight
          approxChar = denom > 0 ? Math.round((ta.scrollTop / denom) * md.length) : 0
        }
        let idx = 0
        for (let i = 0; i < hs.length; i++) {
          if (hs[i].charOffset <= approxChar) idx = i
          else break
        }
        if (idx !== lastIdx) { lastIdx = idx; setActiveHeading(idx) }
      }
      const schedule = () => {
        clearTimeout(timer)
        timer = setTimeout(compute, 80)
      }
      compute()
      ta.addEventListener('scroll', schedule, { passive: true })
      return () => {
        clearTimeout(timer)
        ta.removeEventListener('scroll', schedule)
      }
    }
    // ----- rich-mode spy -----
    const scroller = getEditorHost()
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
      // A jump (jumpAndStabilize) overrides this with the clicked heading's index
      // until the content settles — the tops cache may be stale mid-settle.
      let idx
      if (forcedActiveRef.current != null) {
        idx = forcedActiveRef.current
      } else {
        const limit = scroller.scrollTop + 90
        idx = 0
        for (let i = 0; i < tops.length; i++) {
          if (tops[i] <= limit) idx = i
          else break
        }
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
  }, [home, sidebarOpen, sidebarMode, floating, sourceMode, activeId, richDocVersion, getEditorHost, getSourceTextarea])

  // Outline heading list. Rich mode: taken from the RENDERED document (the
  // editor's actual h1…h6) — matches how jumpToHeading finds them, recognizes
  // ATX/Setext/HTML headings. Source mode (#40): regex-parsed from the textarea
  // via parseSourceHeadings. Both produce { level, text } so Outline.jsx renders
  // either identically.
  useEffect(() => {
    if (home || !activeTab) {
      setOutlineHeadings([])
      return
    }
    // During chunked load the DOM has only partial headings — wait for
    // richDocVersion bump (load finish) before reading, so the outline shows
    // the COMPLETE list (the loading skeleton covers the wait via richLoading).
    // Source mode is a plain textarea (no chunking) — skip this gate there.
    if (!sourceMode && richLoading) return
    // Debounce only repeated structure/content changes within the same target.
    // A split-pane focus or source/rich change must replace stale headings now.
    let timer = 0
    let emptyReads = 0
    const read = () => {
      timer = 0
      // Source mode: parse the textarea. sourceOutlineVersion bumps on input so
      // a newly-typed heading refreshes the list (rich mode gets this free via
      // richDocVersion; source mode has no structure-change hook).
      if (sourceMode) {
        const hs = parseSourceHeadings(getSourceTextarea()?.value || '')
        setOutlineHeadings(hs.map((h) => ({ level: h.level, text: h.text })))
        return
      }
      const els = getHeadings(getEditorHost())
      // No editor mounted (e.g. just closed the file) → clear instead of
      // leaving the previous document's outline hanging (issue #20). The
      // active editor's ref can arrive one React commit after opening the
      // Outline panel, so retry briefly before treating it as an empty file.
      if (!els.length) {
        if (((sidebarOpen && sidebarMode === 'outline') || floating) && emptyReads++ < 12) {
          timer = setTimeout(read, 100)
          return
        }
        setOutlineHeadings([])
        return
      }
      setOutlineHeadings(
        els.map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent || '').trim() }))
      )
    }
    const targetKey = `${activeId}:${sourceMode ? 'source' : 'rich'}:${sidebarOpen && sidebarMode === 'outline' ? 'outline' : floating ? 'floating' : 'background'}`
    const targetChanged = outlineTargetRef.current !== targetKey
    outlineTargetRef.current = targetKey
    if (targetChanged) read()
    else timer = setTimeout(read, 500)
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [home, sidebarOpen, sidebarMode, floating, activeId, activeTab, sourceMode, richDocVersion, richLoading, sourceOutlineVersion, getEditorHost, getSourceTextarea])

  // Source-mode live refresh (#40): bump sourceOutlineVersion on textarea input
  // (debounced) so the list re-parses when the user adds/edits a heading. Rich
  // mode needs no listener (richDocVersion covers it).
  useEffect(() => {
    if (!sourceMode) return
    const ta = getSourceTextarea()
    if (!ta) return
    let t = 0
    const onInput = () => {
      clearTimeout(t)
      t = setTimeout(() => setSourceOutlineVersion((v) => v + 1), 500)
    }
    ta.addEventListener('input', onInput)
    return () => { ta.removeEventListener('input', onInput); clearTimeout(t) }
  }, [sourceMode, getSourceTextarea, activeId])

  return {
    activeHeading,
    outlineHeadings,
    richDocVersion,
    setRichDocVersion,
    refreshOutline: () => setRichDocVersion((version) => version + 1),
    jumpToHeading
  }
}
