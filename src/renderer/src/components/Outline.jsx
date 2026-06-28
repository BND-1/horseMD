import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n.jsx'

// Outline panel. The heading list comes from the parent (App), which reads the
// editor's RENDERED h1…h6 elements — so every heading the document shows is
// listed, no matter how its source wrote it (ATX `#`, Setext, or HTML <h1>),
// and the list stays in lockstep with jumpToHeading (same DOM order).

export default function Outline({ headings = [], activeIndex = -1, onJump }) {
  const { t } = useI18n()
  const activeRef = useRef(null) // the row matching activeIndex
  const panelRef = useRef(null) // the scroll container (.outline-list)
  const endpadRef = useRef(null) // trailing spacer so the last row can center
  const lastScrolledRef = useRef(-1) // dedupe — only act on a real active change

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

  return (
    <div className="outline">
      <div className="panel-head">{t('outline.title')}</div>
      <div className="outline-list" ref={panelRef}>
        {headings.length === 0 ? (
          <div className="outline-empty">{t('outline.empty')}</div>
        ) : (
          <>
            {headings.map((h, i) => (
              <div
                key={i}
                ref={i === activeIndex ? activeRef : undefined}
                className={`outline-item lvl-${h.level}${i === activeIndex ? ' active' : ''}`}
                style={{ paddingLeft: 12 + (h.level - 1) * 12 }}
                onClick={() => onJump(i)}
                title={h.text}
              >
                {h.text}
              </div>
            ))}
            <div className="outline-endpad" ref={endpadRef} aria-hidden="true" />
          </>
        )}
      </div>
    </div>
  )
}
