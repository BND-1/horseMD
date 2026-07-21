import { useMemo } from 'react'
import { useI18n } from '../i18n.jsx'

const DOT_LIMIT = 8

const sampledIndexes = (count, activeIndex) => {
  if (count <= DOT_LIMIT) return Array.from({ length: count }, (_, index) => index)
  const indexes = []
  for (let index = 0; index < DOT_LIMIT; index++) {
    indexes.push(Math.round(index * (count - 1) / (DOT_LIMIT - 1)))
  }
  if (activeIndex >= 0 && activeIndex < count && !indexes.includes(activeIndex)) {
    let nearest = 0
    for (let index = 1; index < indexes.length; index++) {
      if (Math.abs(indexes[index] - activeIndex) < Math.abs(indexes[nearest] - activeIndex)) nearest = index
    }
    indexes[nearest] = activeIndex
  }
  return indexes.sort((a, b) => a - b)
}

const headingLabel = (heading, index) => heading?.text?.trim() || `#${index + 1}`

// Compact reading navigation. All document discovery, scrollspy state and
// jump/stabilize behavior stay in useOutline; this component only renders it.
export default function FloatingOutline({ headings = [], activeIndex = -1, onJump, style }) {
  const { t } = useI18n()
  const dots = useMemo(() => sampledIndexes(headings.length, activeIndex), [headings.length, activeIndex])

  if (!headings.length) return null

  return (
    <nav className="floating-outline" aria-label={t('outline.title')} style={style}>
      <div className="floating-outline-dots">
        {dots.map((index) => (
          <button
            key={index}
            type="button"
            className={`floating-outline-dot${index === activeIndex ? ' active' : ''}`}
            title={headingLabel(headings[index], index)}
            aria-label={headingLabel(headings[index], index)}
            aria-current={index === activeIndex ? 'location' : undefined}
            onClick={() => onJump(index)}
          >
            <span aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="floating-outline-panel">
        <div className="floating-outline-list">
          {headings.map((heading, index) => {
            const label = headingLabel(heading, index)
            const active = index === activeIndex
            const depth = Math.max(0, Math.min(4, (heading.level || 1) - 1))
            return (
              <button
                key={`${index}:${heading.level}:${label}`}
                type="button"
                className={`floating-outline-item${active ? ' active' : ''}`}
                style={{ '--floating-outline-depth': depth }}
                title={label}
                aria-label={label}
                aria-current={active ? 'location' : undefined}
                onClick={() => onJump(index)}
              >
                <span className="floating-outline-item-dot" aria-hidden="true" />
                <span className="floating-outline-item-text">{label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
