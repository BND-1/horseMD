import { useEffect, useRef, useState } from 'react'

export default function FontPicker({ label, value, sample, placeholder, fonts, onLoadFonts, onChange, onHover, footer, t }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const rootRef = useRef(null)
  const searchRef = useRef(null)

  useEffect(() => {
    if (!open) {
      onHover?.(null)
      return
    }
    onLoadFonts()
    setQ('')
    requestAnimationFrame(() => searchRef.current?.focus())
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onHover, onLoadFonts])

  const query = q.trim().toLowerCase()
  const list = (fonts || []).filter((f) => !query || f.toLowerCase().includes(query))
  const shown = list.slice(0, 200)
  const pick = (v) => {
    onChange(v)
    setOpen(false)
    onHover?.(null)
  }

  return (
    <div className="settings-font-row" ref={rootRef}>
      <span className="settings-font-label">{label}</span>
      <button
        type="button"
        className={`settings-font-field${open ? ' open' : ''}${value ? ' has-value' : ''}`}
        onClick={() => setOpen(!open)}
      >
        <span className="settings-font-now" style={{ fontFamily: value ? `'${value}'` : 'inherit' }}>
          {value || placeholder}
        </span>
        <span className={`settings-font-caret${open ? ' up' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="settings-font-menu" onMouseLeave={() => onHover?.(null)}>
          <input
            ref={searchRef}
            className="settings-font-search"
            type="text"
            spellCheck={false}
            placeholder={t('settings.fontSearch')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="settings-font-list">
            <button
              type="button"
              className={`settings-font-option${value ? '' : ' active'}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onHover?.('')}
              onClick={() => pick('')}
            >
              <span className="settings-font-sample">{sample}</span>
              <span className="settings-font-name">{t('settings.fontDefault')}</span>
            </button>
            {shown.map((f) => (
              <button
                type="button"
                key={f}
                className={`settings-font-option${f === value ? ' active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => onHover?.(f)}
                onClick={() => pick(f)}
              >
                <span className="settings-font-sample" style={{ fontFamily: `'${f}'` }}>{sample}</span>
                <span className="settings-font-name">{f}</span>
              </button>
            ))}
            {list.length > shown.length && (
              <div className="settings-font-more">{t('settings.fontMore', { n: list.length - shown.length })}</div>
            )}
            {!list.length && <div className="settings-font-empty">{t('settings.fontEmpty')}</div>}
          </div>
          {footer && <div className="settings-font-footer">{footer}</div>}
        </div>
      )}
    </div>
  )
}
