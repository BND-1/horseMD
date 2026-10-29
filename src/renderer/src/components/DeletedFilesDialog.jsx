import { useEffect, useState } from 'react'
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'
import { fireToast } from '../ui.js'
import { HistoryPreview, HistoryShell, listKeyNav } from './HistoryDialog.jsx'
import {
  HISTORY_OPEN_EVENT,
  baseName,
  displayFolder,
  errorText,
  formatBytes,
  reasonLabel,
  whenLabel
} from '../lib/history-ui.js'

// 最近删除: files deleted in the sidebar or by sync, kept by main's history
// store. Preview + 还原 (to the old place, or a free name next to it).
// Opened through openDeletedFiles().
export default function DeletedFilesDialog({ folderRoots, retentionDays }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onOpen = (event) => {
      if (event.detail?.kind === 'deleted') setOpen(true)
    }
    window.addEventListener(HISTORY_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(HISTORY_OPEN_EVENT, onOpen)
  }, [])
  if (!open) return null
  return <DeletedFiles folderRoots={folderRoots} retentionDays={retentionDays} onClose={() => setOpen(false)} />
}

function DeletedFiles({ folderRoots = [], retentionDays = 30, onClose }) {
  const { t, lang } = useI18n()
  const [items, setItems] = useState(null)
  const [listError, setListError] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    let alive = true
    Promise.resolve(window.api.historyDeleted?.())
      .then((res) => {
        if (!alive) return
        const list = res?.items || []
        setItems(list)
        setSelectedId((id) => (list.some((item) => item.id === id) ? id : list[0]?.id ?? null))
      })
      .catch(() => alive && (setListError(true), setItems([])))
    return () => { alive = false }
  }, [reloadNonce])

  useEffect(() => {
    if (selectedId == null) {
      setPreview(null)
      return undefined
    }
    let alive = true
    setPreview({ loading: true })
    Promise.resolve(window.api.historyReadDeleted?.(selectedId))
      .then((res) => alive && setPreview({ content: res?.content ?? null, binary: !!res?.binary, size: res?.size }))
      .catch(() => alive && setPreview({ error: true }))
    return () => { alive = false }
  }, [selectedId])

  const selected = items?.find((item) => item.id === selectedId) || null
  const restore = async () => {
    if (!selected || busy) return
    setBusy(true)
    setStatus(null)
    try {
      const res = await window.api.historyRestoreDeleted(selected.id)
      if (res && res.ok === false) throw new Error(res.error || '')
      fireToast(t('deleted.restored', { path: res?.path || selected.path }))
      setReloadNonce((n) => n + 1)
    } catch (error) {
      setStatus({ text: t('history.restoreFailed', { msg: errorText(error) }), error: true })
    } finally {
      setBusy(false)
    }
  }

  const title = t('deleted.title')
  const note = t('deleted.note', { n: retentionDays })
  if (items && !items.length) {
    return (
      <HistoryShell kind="deleted" empty title={title} note={note} onClose={onClose}>
        <div className="hm-history-empty">
          <Icon name="trash" size={26} />
          <span>{listError ? t('history.listFailed') : t('deleted.empty')}</span>
        </div>
      </HistoryShell>
    )
  }

  return (
    <HistoryShell kind="deleted" title={title} note={note} onClose={onClose}>
      <div className="hm-history-body">
        <div
          className="hm-history-list"
          role="listbox"
          tabIndex={0}
          aria-label={title}
          onKeyDown={listKeyNav(items || [], selectedId, setSelectedId)}
        >
          {!items && <div className="hm-history-preview-msg">{t('history.loading')}</div>}
          {(items || []).map((item) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={item.id === selectedId}
              className={`hm-history-row deleted${item.id === selectedId ? ' active' : ''}`}
              onClick={() => setSelectedId(item.id)}
              title={item.path}
            >
              <span className="hm-history-file">{baseName(item.path)}</span>
              <span className="hm-history-folder">{displayFolder(item.path, folderRoots)}</span>
              <span className="hm-history-sub">{whenLabel(item.at, t, lang)} · {reasonLabel(t, item.reason)}</span>
            </button>
          ))}
        </div>
        <div className="hm-history-side">
          <div className="hm-history-toolbar">
            <span className="hm-history-meta" title={selected?.path}>
              {selected && [displayFolder(selected.path, folderRoots), baseName(selected.path)].filter(Boolean).join('/')}
              {selected?.size != null && <span className="hm-history-size"> · {formatBytes(selected.size)}</span>}
            </span>
          </div>
          <div className="hm-history-preview">
            <HistoryPreview preview={preview} />
          </div>
          <div className="hm-history-actions">
            <span className={`hm-history-status${status?.error ? ' error' : ''}`} role="status">{status?.text}</span>
            <button type="button" className="hm-history-btn primary" disabled={!selected || busy} onClick={restore}>
              {busy ? t('history.restoring') : t('deleted.restore')}
            </button>
          </div>
        </div>
      </div>
    </HistoryShell>
  )
}
