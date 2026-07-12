import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n.jsx'
import { Icon } from './icons.jsx'
import { defaultCollapsedHeadings, headingHasChildren } from './outline-model.js'

// Outline panel. The heading list comes from the parent (App), which reads the
// editor's RENDERED h1…h6 elements — so every heading the document shows is
// listed, no matter how its source wrote it (ATX `#`, Setext, or HTML <h1>),
// and the list stays in lockstep with jumpToHeading (same DOM order).

export default function Outline({ headings = [], activeIndex = -1, onJump, loading = false }) {
  const { t } = useI18n()
  const activeRef = useRef(null) // the visible row that represents activeIndex
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
    return headingHasChildren(headings, i)
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

  // If the active heading is hidden inside a collapsed branch, highlight the
  // visible collapsed ancestor instead. The outermost collapsed ancestor is the
  // row the user can actually see.
  const collapsedAncestorOf = (i) => {
    if (i < 0 || i >= headings.length) return -1
    let result = -1
    let lvl = headings[i].level
    for (let j = i - 1; j >= 0; j--) {
      if (headings[j].level < lvl) {
        if (collapsed.has(j)) result = j
        lvl = headings[j].level
      }
    }
    return result
  }

  const toggle = (i) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(i)) {
        next.delete(i)
      } else {
        next.add(i)
      }
      return next
    })
  }

  const expandAll = () => setCollapsed(new Set())
  const collapseAll = () => setCollapsed(defaultCollapsedHeadings(headings))

  // Reset the collapsed set whenever the headings *content* changes (edit,
  // reload). Index-based state is only stable while the heading list itself
  // is unchanged; if a heading at the same index now has different text/level
  // the old collapsed state would apply to the wrong branch. A signature of
  // level+text detects this without false-positive resets on plain re-renders.
  useLayoutEffect(() => {
    const sig = headings.map((h) => h.level + ':' + h.text).join('\n')
    if (sig !== prevSigRef.current) {
      prevSigRef.current = sig
      setCollapsed(defaultCollapsedHeadings(headings))
    }
  }, [headings])

  const activeDisplayIndex =
    activeIndex >= 0 && activeIndex < headings.length
      ? (isVisible(activeIndex) ? activeIndex : collapsedAncestorOf(activeIndex))
      : -1

  // Soft-center the visible active row. As long as it sits in the middle of the
  // panel we leave the scroll alone (no jitter when it's already comfortable);
  // but once it drifts into the top/bottom ~25% we scroll the panel so it lands
  // centered. This replaces scrollIntoView({ block: 'nearest' }), which only
  // nudged the row to the panel's edge — so at the ends of a long doc the
  // highlight got pinned to the very top/bottom instead of sitting mid-panel.
  useEffect(() => {
    const panel = panelRef.current
    const el = activeRef.current
    if (activeDisplayIndex < 0 || !panel || !el || lastScrolledRef.current === activeDisplayIndex) return
    lastScrolledRef.current = activeDisplayIndex
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
  }, [activeDisplayIndex])

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

  const foldable = headings.map((_, i) => i).filter(hasChildren)
  const compact = defaultCollapsedHeadings(headings)
  const hasCompactState = compact.size > 0
  const isCollapsed = hasCompactState && [...compact].every((i) => collapsed.has(i))
  const toggleAll = isCollapsed ? expandAll : collapseAll

  return (
    <div className="outline">
      <div className="panel-head">
        <span>{t('outline.title')}</span>
        {headings.length > 0 && (
          <span className="outline-head-actions">
            <button
              className="outline-head-btn"
              onClick={toggleAll}
              title={isCollapsed ? t('outline.expandAll') : t('outline.collapseAll')}
              disabled={foldable.length === 0 || !hasCompactState}
              aria-label={isCollapsed ? t('outline.expandAll') : t('outline.collapseAll')}
            >
              <Icon name={isCollapsed ? 'expand' : 'collapse'} size={15} />
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
              const isActive = i === activeDisplayIndex
              const containsActive = isActive && i !== activeIndex
              return (
                <div
                  key={i}
                  ref={isActive ? activeRef : undefined}
                  className={`outline-item lvl-${h.level}${isActive ? ' active' : ''}${containsActive ? ' contained-active' : ''}`}
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
