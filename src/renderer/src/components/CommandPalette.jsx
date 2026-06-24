import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'

function score(query, text) {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const idx = t.indexOf(q)
  if (idx === 0) return 3
  if (idx > 0) return 2
  // subsequence
  let qi = 0
  for (let i = 0; i < t.length && qi < q.length; i++) if (t[i] === q[qi]) qi++
  return qi === q.length ? 1 : 0
}

export default function CommandPalette({ open, onClose, commands, files, onOpenFile }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setSel(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  const items = useMemo(() => {
    const cmdItems = commands.map((c) => ({ kind: 'cmd', ...c }))
    const fileItems = files.map((f) => ({
      kind: 'file',
      id: 'file:' + f.path,
      title: f.name,
      hint: f.rel,
      run: () => onOpenFile(f.path)
    }))
    const all = [...cmdItems, ...fileItems]
    if (!query) return all.slice(0, 50)
    return all
      .map((it) => ({ it, s: Math.max(score(query, it.title), score(query, it.hint || '') * 0.6) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.it)
  }, [query, commands, files, onOpenFile])

  useEffect(() => {
    if (sel >= items.length) setSel(Math.max(0, items.length - 1))
  }, [items, sel])

  if (!open) return null

  const choose = (it) => {
    onClose()
    it?.run?.()
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder={t('palette.placeholder')}
            onChange={(e) => {
              setQuery(e.target.value)
              setSel(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(items.length - 1, s + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(0, s - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(items[sel])
              } else if (e.key === 'Escape') {
                onClose()
              }
            }}
          />
        </div>
        <div className="palette-list">
          {items.length === 0 && <div className="palette-empty">{t('palette.empty')}</div>}
          {items.map((it, i) => (
            <div
              key={it.id}
              className={`palette-item${i === sel ? ' sel' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(it)}
            >
              <Icon name={it.kind === 'file' ? 'file' : it.icon || 'command'} size={15} />
              <span className="pi-title">{it.title}</span>
              {it.hint && <span className="pi-hint">{it.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
