import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'
import { copyToClipboard, fireToast } from '../ui.js'
import {
  HISTORY_OPEN_EVENT,
  baseName,
  diffRows,
  errorText,
  formatBytes,
  groupByDay,
  reasonLabel,
  timeLabel,
  whenLabel
} from '../lib/history-ui.js'

// The card both history dialogs use: backdrop, title, note, close (Esc),
// a list on the left and a preview on the right (stacked on narrow windows).
export function HistoryShell({ title, note, onClose, children, kind, empty = false }) {
  const { t } = useI18n()
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus() }, [])
  // Esc closes from anywhere while the dialog is open — focus can leave it
  // (the 还原 button that had it disappears when the last item is restored).
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      closeRef.current?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return (
    <>
      <div className="hm-history-backdrop" onMouseDown={onClose} />
      <div
        ref={ref}
        tabIndex={-1}
        className={`hm-history hm-history-${kind}${empty ? ' empty' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <button className="hm-history-x" onClick={onClose} title={t('history.close')} aria-label={t('history.close')}>
          <Icon name="close" size={14} />
        </button>
        <div className="hm-history-title">{title}</div>
        {note && <p className="hm-history-note">{note}</p>}
        {children}
      </div>
    </>
  )
}

// Up / Down move the selection inside a list of { id }.
export function listKeyNav(items, selectedId, onSelect) {
  return (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const index = items.findIndex((item) => item.id === selectedId)
    const next = items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
    if (next) onSelect(next.id)
  }
}

// Plain-text preview of a stored version, or its line diff against `current`.
export function HistoryPreview({ preview, diff }) {
  const { t } = useI18n()
  if (!preview || preview.loading) return <div className="hm-history-preview-msg">{t('history.loading')}</div>
  if (preview.error) return <div className="hm-history-preview-msg error">{t('history.readFailed')}</div>
  if (preview.binary || preview.content == null) {
    return (
      <div className="hm-history-preview-msg">
        <Icon name="image" size={22} />
        <span>{t('history.binary')}</span>
        {preview.size != null && <span className="hm-history-size">{formatBytes(preview.size)}</span>}
      </div>
    )
  }
  if (diff) {
    if (diff.loading) return <div className="hm-history-preview-msg">{t('history.loading')}</div>
    if (!diff.rows.length) return <div className="hm-history-preview-msg">{t('history.noChanges')}</div>
    return (
      <div className="hm-history-text hm-history-diff">
        {diff.rows.map((row, index) => row.type === 'skip' ? (
          <div key={index} className="hm-history-line skip">{t('history.unchanged', { n: row.count })}</div>
        ) : (
          <div key={index} className={`hm-history-line ${row.type}`}>
            <span className="hm-history-mark">{row.type === 'del' ? '−' : row.type === 'add' ? '+' : ' '}</span>
            <span className="hm-history-code">{row.text || ' '}</span>
          </div>
        ))}
      </div>
    )
  }
  return <pre className="hm-history-text">{preview.content}</pre>
}

// 历史版本 · <file>: the versions main kept of one file (newest first),
// grouped by day; preview / diff against the current content; restore,
// copy, keep forever. Opened through openFileHistory(path).
// getOpenTab(path) → { dirty, read() } of an open tab, so the diff uses
// what the user sees (unsaved edits included).
export default function HistoryDialog({ getOpenTab }) {
  const [path, setPath] = useState(null)
  useEffect(() => {
    const onOpen = (event) => {
      if (event.detail?.kind === 'file' && event.detail.path) setPath(event.detail.path)
    }
    window.addEventListener(HISTORY_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(HISTORY_OPEN_EVENT, onOpen)
  }, [])
  if (!path) return null
  return <FileHistory key={path} path={path} getOpenTab={getOpenTab} onClose={() => setPath(null)} />
}

function FileHistory({ path, getOpenTab, onClose }) {
  const { t, lang } = useI18n()
  const [versions, setVersions] = useState(null)
  const [listError, setListError] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [preview, setPreview] = useState(null)
  const [onlyChanges, setOnlyChanges] = useState(false)
  const [current, setCurrent] = useState(null) // { content } once read
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null) // { text, error }
  const openTab = getOpenTab?.(path)
  const openTabRef = useRef(openTab)
  openTabRef.current = openTab

  useEffect(() => {
    let alive = true
    Promise.resolve(window.api.historyList?.(path))
      .then((res) => {
        if (!alive) return
        const list = res?.versions || []
        setVersions(list)
        setSelectedId(list[0]?.id ?? null)
      })
      .catch(() => alive && (setListError(true), setVersions([])))
    return () => { alive = false }
  }, [path])

  useEffect(() => {
    if (selectedId == null) return undefined
    let alive = true
    setPreview({ loading: true })
    setStatus(null)
    Promise.resolve(window.api.historyRead?.(path, selectedId))
      .then((res) => alive && setPreview({ content: res?.content ?? null, binary: !!res?.binary, size: res?.size }))
      .catch(() => alive && setPreview({ error: true }))
    return () => { alive = false }
  }, [path, selectedId])

  // The current content, read once when 只看改动 is first switched on.
  useEffect(() => {
    if (!onlyChanges || current) return undefined
    let live = null
    try { live = openTabRef.current?.read?.() } catch { live = null }
    if (typeof live === 'string') {
      setCurrent({ content: live })
      return undefined
    }
    let alive = true
    Promise.resolve(window.api.readFile?.(path))
      .then((res) => alive && setCurrent({ content: res?.content ?? '' }))
      .catch(() => alive && setCurrent({ content: '', missing: true }))
    return () => { alive = false }
  }, [onlyChanges, current, path])

  const diff = useMemo(() => {
    if (!onlyChanges || !preview || preview.loading || preview.error || preview.binary) return null
    if (!current) return { loading: true }
    return { rows: diffRows(preview.content ?? '', current.content) }
  }, [onlyChanges, preview, current])

  const groups = useMemo(() => groupByDay(versions || [], t, lang), [versions, t, lang])
  const selected = versions?.find((v) => v.id === selectedId) || null
  const textReady = preview && !preview.loading && !preview.error && !preview.binary && preview.content != null

  const restore = async () => {
    if (!selected || busy) return
    setBusy(true)
    setStatus(null)
    try {
      const res = await window.api.historyRestore(path, selected.id)
      if (res && res.ok === false) throw new Error(res.error || '')
      onClose()
      fireToast(t('history.restored', { time: whenLabel(selected.at, t, lang) }))
    } catch (error) {
      setStatus({ text: t('history.restoreFailed', { msg: errorText(error) }), error: true })
      setBusy(false)
    }
  }
  const copy = async () => {
    if (!textReady) return
    const ok = await copyToClipboard(preview.content)
    setStatus(ok ? { text: t('history.copied') } : { text: t('history.copyFailed'), error: true })
  }
  const togglePin = async () => {
    if (!selected) return
    const pinned = !selected.pinned
    try {
      await window.api.historyPin(path, selected.id, pinned)
      setVersions((list) => list.map((v) => (v.id === selected.id ? { ...v, pinned } : v)))
      setStatus({ text: pinned ? t('history.pinnedDone') : t('history.unpinnedDone') })
    } catch (error) {
      setStatus({ text: errorText(error), error: true })
    }
  }

  const title = t('history.title', { name: baseName(path) })
  if (versions && !versions.length) {
    return (
      <HistoryShell kind="file" empty title={title} onClose={onClose}>
        <div className="hm-history-empty">
          <Icon name="history" size={26} />
          <span>{listError ? t('history.listFailed') : t('history.empty')}</span>
        </div>
      </HistoryShell>
    )
  }

  return (
    <HistoryShell kind="file" title={title} onClose={onClose} note={openTab?.dirty ? t('history.dirtyNote') : null}>
      <div className="hm-history-body">
        <div
          className="hm-history-list"
          role="listbox"
          tabIndex={0}
          aria-label={title}
          onKeyDown={listKeyNav(versions || [], selectedId, setSelectedId)}
        >
          {!versions && <div className="hm-history-preview-msg">{t('history.loading')}</div>}
          {groups.map((group) => (
            <div key={group.label} className="hm-history-group">
              <div className="hm-history-day">{group.label}</div>
              {group.items.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="option"
                  aria-selected={v.id === selectedId}
                  className={`hm-history-row${v.id === selectedId ? ' active' : ''}`}
                  onClick={() => setSelectedId(v.id)}
                >
                  <span className="hm-history-time">{timeLabel(v.at, lang)}</span>
                  <span className="hm-history-reason">{reasonLabel(t, v.reason)}</span>
                  {v.pinned && (
                    <span className="hm-history-pin" title={t('history.pinned')} aria-label={t('history.pinned')}>
                      <Icon name="pin" size={12} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="hm-history-side">
          <div className="hm-history-toolbar">
            <span className="hm-history-meta">
              {selected && `${whenLabel(selected.at, t, lang)} · ${reasonLabel(t, selected.reason)}`}
              {selected?.size != null && <span className="hm-history-size"> · {formatBytes(selected.size)}</span>}
            </span>
            <label className={`hm-history-switch${textReady ? '' : ' disabled'}`}>
              <input
                type="checkbox"
                checked={onlyChanges}
                disabled={!textReady}
                onChange={(event) => setOnlyChanges(event.target.checked)}
              />
              {t('history.onlyChanges')}
            </label>
          </div>
          {diff && !diff.loading && current?.missing && <div className="hm-history-hint">{t('history.currentMissing')}</div>}
          {diff && !diff.loading && !current?.missing && diff.rows.length > 0 && <div className="hm-history-hint">{t('history.diffHint')}</div>}
          <div className="hm-history-preview">
            <HistoryPreview preview={preview} diff={diff} />
          </div>
          <div className="hm-history-actions">
            <span className={`hm-history-status${status?.error ? ' error' : ''}`} role="status">{status?.text}</span>
            <button type="button" className="hm-history-btn" disabled={!selected} onClick={togglePin}>
              {selected?.pinned ? t('history.unpin') : t('history.pin')}
            </button>
            <button type="button" className="hm-history-btn" disabled={!textReady} onClick={copy}>{t('history.copy')}</button>
            <button type="button" className="hm-history-btn primary" disabled={!selected || busy} onClick={restore}>
              {busy ? t('history.restoring') : t('history.restore')}
            </button>
          </div>
        </div>
      </div>
    </HistoryShell>
  )
}
