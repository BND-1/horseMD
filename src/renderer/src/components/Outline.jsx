import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n.jsx'

// Outline panel. The heading list comes from the parent (App), which reads the
// editor's RENDERED h1…h6 elements — so every heading the document shows is
// listed, no matter how its source wrote it (ATX `#`, Setext, or HTML <h1>),
// and the list stays in lockstep with jumpToHeading (same DOM order).

export default function Outline({ headings = [], activeIndex = -1, onJump }) {
  const { t } = useI18n()
  // The currently-viewed heading's row, kept scrolled into view (like the file
  // tree reveals the open file). Guarded so we only scroll on a real change.
  const activeRef = useRef(null)
  const lastScrolledRef = useRef(-1)
  useEffect(() => {
    if (activeIndex >= 0 && activeRef.current && lastScrolledRef.current !== activeIndex) {
      activeRef.current.scrollIntoView({ block: 'nearest' })
      lastScrolledRef.current = activeIndex
    }
  }, [activeIndex])
  return (
    <div className="outline">
      <div className="panel-head">{t('outline.title')}</div>
      <div className="outline-list">
        {headings.length === 0 ? (
          <div className="outline-empty">{t('outline.empty')}</div>
        ) : (
          headings.map((h, i) => (
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
          ))
        )}
      </div>
    </div>
  )
}
