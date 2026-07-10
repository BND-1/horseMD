import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n.jsx'

// Outline panel. The heading list comes from the parent (App), which reads the
// editor's RENDERED h1…h6 elements — so every heading the document shows is
// listed, no matter how its source wrote it (ATX `#`, Setext, or HTML <h1>),
// and the list stays in lockstep with jumpToHeading (same DOM order).

export default function Outline({ headings = [], activeIndex = -1, onJump, loading = false }) {
  const { t } = useI18n()
  const activeRef = useRef(null) // the row matching activeIndex
  const panelRef = useRef(null) // the scroll container (.outline-list)
  const endpadRef = useRef(null) // trailing spacer so the last row can center
  const lastScrolledRef = useRef(-1) // dedupe — only act on a real active change

  // Collapsed set: indices of headings whose children are hidden.
  const [collapsed, setCollapsed] = useState(new Set())

  // Last-seen headings signature, used to detect content changes (not just
  // array-identity re-renders) so the collapsed set can be reset safely.
  const prevSigRef = useRef('')

  // A heading `i` is a parent (has foldable children) if a later heading has a
  // deeper level before an equal-or-shallower level re-appears.
  const hasChildren = (i) => {
    if (i < 0 || i >= headings.length) return false
    const lvl = headings[i].level
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= lvl) break
      return true
    }
    return false
  }

  // A heading is visible if none of its ancestors are collapsed.
  // Walk backwards; when we find a heading with a smaller level it's a direct
  // ancestor — check it, then lower the threshold so only *its* ancestors
  // (even smaller level) are checked next. Siblings at the same or deeper
  // level are skipped.
  const isVisible = (i) => {
    let lvl = headings[i].level
    for (let j = i - 1; j >= 0; j--) {
      if (headings[j].level < lvl) {
        if (collapsed.has(j)) return false
        lvl = headings[j].level
      }
    }
    return true
  }

  // Return the ancestor chain (indices) of heading i, from immediate parent
  // up to the top-level heading.
  const ancestorsOf = (i) => {
    const result = []
    let lvl = headings[i].level
    for (let j = i - 1; j >= 0; j--) {
      if (headings[j].level < lvl) {
        result.push(j)
        lvl = headings[j].level
      }
    }
    return result
  }

  // Prevent collapsing a branch that contains the active heading — the
  // scrollspy highlight must stay visible at all times. Expanding is always
  // allowed.
  const isProtected = (i) =>
    activeIndex >= 0 && ancestorsOf(activeIndex).includes(i)

  const toggle = (i) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(i)) {
        next.delete(i)
      } else {
        if (isProtected(i)) return prev // never hide the active row
        next.add(i)
      }
      return next
    })
  }

  const expandAll = () => setCollapsed(new Set())
  const collapseAll = () => {
    // Collapse every heading that has children, except ancestors of the
    // active heading.
    const next = new Set()
    for (let i = 0; i < headings.length; i++) {
      if (hasChildren(i) && !isProtected(i)) next.add(i)
    }
    setCollapsed(next)
  }

  // Keep the active heading's ancestor chain expanded so the scrollspy
  // highlight is always visible, even inside a folded branch.
  useEffect(() => {
    if (activeIndex < 0 || activeIndex >= headings.length) return
    const ancestors = ancestorsOf(activeIndex)
    if (!ancestors.length) return
    setCollapsed((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const a of ancestors) {
        if (next.has(a)) { next.delete(a); changed = true }
      }
      return changed ? next : prev
    })
  }, [activeIndex, headings])

  // Reset the collapsed set whenever the headings *content* changes (edit,
  // reload). Index-based state is only stable while the heading list itself
  // is unchanged; if a heading at the same index now has different text/level
  // the old collapsed state would apply to the wrong branch. A signature of
  // level+text detects this without false-positive resets on plain re-renders.
  useEffect(() => {
    const sig = headings.map((h) => h.level + ':' + h.text).join('\n')
    if (sig !== prevSigRef.current) {
      prevSigRef.current = sig
      setCollapsed(new Set())
    }
  }, [headings])

  // Soft-center the active heading. As long as it sits in the middle of the
  // panel we leave the scroll alone (no jitter when it's already comfortable);
  // but once it drifts into the top/bottom ~25% we scroll the panel so it lands
  // centered. This replaces scrollIntoView({ block: 'nearest' }), which only
  // nudged the row to the panel's edge — so at the ends of a long doc the
  // highlight got pinned to the very top/bottom instead of sitting mid-panel.
  useEffect(() => {
    const panel = panelRef.current
    const el = activeRef.current
    if (activeIndex < 0 || !panel || !el || lastScrolledRef.current === activeIndex) return
    lastScrolledRef.current = activeIndex
    const ph = panel.clientHeight
    if (!ph) return
    const eRect = el.getBoundingClientRect()
    const relTop = eRect.top - panel.getBoundingClientRect().top
    const margin = ph * 0.25 // comfort zone = the middle 50%
    if (relTop < margin || relTop + eRect.height > ph - margin) {
      // Center the row (clamped; the endpad spacer below lets the last row
      // actually reach center instead of being clamped to the panel bottom).
      const target = panel.scrollTop + relTop + eRect.height / 2 - ph / 2
      panel.scrollTop = Math.max(0, target)
    }
  }, [activeIndex])

  // Size a trailing spacer so the FINAL heading can scroll all the way up to the
  // panel's vertical middle — without it, scrollTop clamps at the content end
  // and the last row is stuck at the bottom. Re-fit when the panel resizes
  // (window / sidebar drag) or the list length changes. The spacer is a child
  // element, so sizing it never changes the panel's own clientHeight (no loop).
  useEffect(() => {
    const panel = panelRef.current
    const pad = endpadRef.current
    if (!panel || !pad) return
    const fit = () => {
      pad.style.height = Math.max(0, Math.round(panel.clientHeight / 2) - 24) + 'px'
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(panel)
    return () => ro.disconnect()
  }, [headings.length])

  const anyExpandable = collapsed.size > 0
  const anyCollapsible = headings.some((_, i) => hasChildren(i) && !collapsed.has(i) && !isProtected(i))

  return (
    <div className="outline">
      <div className="panel-head">
        <span>{t('outline.title')}</span>
        {headings.length > 0 && (
          <span className="outline-head-actions">
            <button
              className="outline-head-btn"
              onClick={expandAll}
              title={t('outline.expandAll')}
              disabled={!anyExpandable}
              aria-label={t('outline.expandAll')}
            >
              <svg width="14" height="14" viewBox="0 0 16 20" fill="none">
                <path d="M4 6L8 2L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 12L8 16L12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              className="outline-head-btn"
              onClick={collapseAll}
              title={t('outline.collapseAll')}
              disabled={!anyCollapsible}
              aria-label={t('outline.collapseAll')}
            >
              <svg width="14" height="14" viewBox="0 0 16 20" fill="none">
                <path d="M4 4L8 8L12 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 16L8 12L12 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </span>
        )}
      </div>
      <div className="outline-list" ref={panelRef}>
        {loading ? (
          // A huge doc is still streaming in (chunked parse) — its heading list
          // isn't complete yet, so show a skeleton instead of a partial/empty list.
          <div className="outline-skeleton" aria-hidden="true">
            <div className="ol-skel-line" style={{ width: '68%' }} />
            <div className="ol-skel-line ind" style={{ width: '88%' }} />
            <div className="ol-skel-line ind" style={{ width: '54%' }} />
            <div className="ol-skel-line" style={{ width: '76%' }} />
            <div className="ol-skel-line ind" style={{ width: '92%' }} />
            <div className="ol-skel-line" style={{ width: '60%' }} />
            <div className="ol-skel-line ind" style={{ width: '72%' }} />
            <div className="ol-skel-line" style={{ width: '84%' }} />
          </div>
        ) : headings.length === 0 ? (
          <div className="outline-empty">{t('outline.empty')}</div>
        ) : (
          <>
            {headings.map((h, i) => {
              if (!isVisible(i)) return null
              const isParent = hasChildren(i)
              const isCollapsed = collapsed.has(i)
              return (
                <div
                  key={i}
                  ref={i === activeIndex ? activeRef : undefined}
                  className={`outline-item lvl-${h.level}${i === activeIndex ? ' active' : ''}`}
                  style={{ paddingLeft: 12 + (h.level - 1) * 12 }}
                  onClick={() => onJump(i)}
                  title={h.text}
                >
                  {isParent ? (
                    <span
                      className="outline-twisty"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggle(i)
                      }}
                      role="button"
                      aria-label={isCollapsed ? t('outline.expand') : t('outline.collapse')}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ transform: isCollapsed ? 'none' : 'rotate(90deg)', transition: 'transform 0.12s ease' }}>
                        <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  ) : (
                    <span className="outline-twisty outline-twisty-leaf" />
                  )}
                  <span className="outline-item-text">{h.text}</span>
                </div>
              )
            })}
            <div className="outline-endpad" ref={endpadRef} aria-hidden="true" />
          </>
        )}
      </div>
    </div>
  )
}
