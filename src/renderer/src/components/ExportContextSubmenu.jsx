import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './icons.jsx'

const PANDOC_FORMATS = [
  ['docx', 'export.formatDocx'],
  ['epub', 'export.formatEpub'],
  ['latex', 'export.formatLatex'],
  ['odt', 'export.formatOdt'],
  ['rtf', 'export.formatRtf'],
  ['txt', 'export.formatTxt']
]

export default function ExportContextSubmenu({
  t,
  itemClassName = '',
  onExportPdf,
  onExportHtml,
  onExportPandoc,
  onClose
}) {
  const triggerRef = useRef(null)
  const submenuRef = useRef(null)
  const closeTimerRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const submenuId = useId()
  const pdfEnabled = window.api.capabilities?.pdfExport !== false && !!onExportPdf
  const htmlEnabled = window.api.capabilities?.htmlExport !== false && !!onExportHtml
  const pandocEnabled = window.api.capabilities?.pandocExport !== false && !!onExportPandoc

  const cancelClose = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }
  const show = () => {
    cancelClose()
    setOpen(true)
  }
  const hideSoon = () => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => setOpen(false), 120)
  }

  useLayoutEffect(() => () => cancelClose(), [])

  useLayoutEffect(() => {
    if (!open) return undefined
    const place = () => {
      const trigger = triggerRef.current
      const submenu = submenuRef.current
      if (!trigger || !submenu) return
      const rect = trigger.getBoundingClientRect()
      const gap = 4
      const inset = 8
      const width = submenu.offsetWidth
      const height = submenu.offsetHeight
      const left = rect.right + gap + width <= window.innerWidth - inset
        ? rect.right + gap
        : Math.max(inset, rect.left - gap - width)
      const top = Math.min(
        Math.max(inset, rect.top - 6),
        Math.max(inset, window.innerHeight - inset - height)
      )
      setPosition({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  if (!pdfEnabled && !htmlEnabled && !pandocEnabled) return null

  const focusItem = (direction) => {
    const items = [...(submenuRef.current?.querySelectorAll('button:not(:disabled)') || [])]
    if (!items.length) return
    const current = items.indexOf(document.activeElement)
    const next = current < 0
      ? (direction > 0 ? 0 : items.length - 1)
      : (current + direction + items.length) % items.length
    items[next].focus()
  }
  const openAndFocus = () => {
    show()
    requestAnimationFrame(() => focusItem(1))
  }
  const run = (action) => async () => {
    setOpen(false)
    onClose?.()
    await action?.()
  }

  const submenu = open && createPortal(
    <div
      ref={submenuRef}
      id={submenuId}
      className="context-submenu"
      role="menu"
      style={position}
      onMouseEnter={cancelClose}
      onMouseLeave={hideSoon}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          focusItem(event.key === 'ArrowDown' ? 1 : -1)
        } else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
          event.preventDefault()
          setOpen(false)
          triggerRef.current?.focus()
        }
      }}
    >
      {pdfEnabled && <button type="button" role="menuitem" onClick={run(onExportPdf)}>{t('export.formatPdf')}</button>}
      {htmlEnabled && <button type="button" role="menuitem" onClick={run(onExportHtml)}>{t('export.formatHtml')}</button>}
      {pandocEnabled && (pdfEnabled || htmlEnabled) && <div className="context-submenu-sep" />}
      {pandocEnabled && PANDOC_FORMATS.map(([format, label]) => (
        <button key={format} type="button" role="menuitem" onClick={run(() => onExportPandoc(format))}>
          {t(label)}
        </button>
      ))}
    </div>,
    document.body
  )

  return (
    <div
      className={`context-submenu-parent${open ? ' is-open' : ''}`}
      onMouseEnter={show}
      onMouseLeave={hideSoon}
    >
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        className={`${itemClassName} context-submenu-trigger`.trim()}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? submenuId : undefined}
        onFocus={show}
        onClick={(event) => {
          event.stopPropagation()
          openAndFocus()
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openAndFocus()
          } else if (event.key === 'ArrowDown' && open) {
            event.preventDefault()
            focusItem(1)
          }
        }}
      >
        <span>{t('side.export')}</span>
        <Icon name="chevron-right" size={14} aria-hidden="true" />
      </button>
      {submenu}
    </div>
  )
}
