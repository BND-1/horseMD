import { memo, useEffect, useMemo, useRef } from 'react'
import { useI18n } from '../i18n.jsx'

export function parseHeadings(md) {
  const lines = (md || '').split('\n')
  const out = []
  let inFence = false
  let fence = ''
  lines.forEach((line) => {
    const fm = line.match(/^(\s*)(```+|~~~+)/)
    if (fm) {
      const marker = fm[2][0]
      if (!inFence) {
        inFence = true
        fence = marker
      } else if (marker === fence) {
        inFence = false
      }
      return
    }
    if (inFence) return
    const hm = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (hm) out.push({ level: hm[1].length, text: hm[2].trim() })
  })
  return out
}

function Outline({ content, activeIndex = -1, onJump }) {
  const { t } = useI18n()
  const headings = useMemo(() => parseHeadings(content), [content])
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

export default memo(Outline)
