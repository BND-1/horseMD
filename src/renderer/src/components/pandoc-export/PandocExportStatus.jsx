import { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import './pandoc-export.css'

const splitPath = (path) => {
  const value = String(path || '')
  const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  return cut < 0 ? { name: value, dir: '' } : { name: value.slice(cut + 1), dir: value.slice(0, cut) || value.slice(0, 1) }
}

export default function PandocExportStatus({ state, onDismiss, onInstall, t }) {
  const [openError, setOpenError] = useState('')
  const [opening, setOpening] = useState(false)
  const primaryRef = useRef(null)
  const status = state?.status

  useEffect(() => { setOpenError('') }, [state])
  useEffect(() => {
    if (status === 'success') primaryRef.current?.focus()
  }, [status])
  useEffect(() => {
    if (!status || status === 'running') return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onDismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [status, onDismiss])

  if (!state) return null

  // Only the file main just exported can be opened (main keeps the path).
  const open = async (kind) => {
    if (opening) return
    setOpening(true)
    setOpenError('')
    try {
      const result = await window.api.openPandocResult(kind)
      if (result?.ok) onDismiss()
      else setOpenError(result?.code === 'missing' ? t('pandoc.openMissing') : t('pandoc.openFailed', { msg: result?.error || '' }))
    } catch (error) {
      setOpenError(t('pandoc.openFailed', { msg: error?.message || String(error || '') }))
    } finally {
      setOpening(false)
    }
  }

  if (status === 'success') {
    const { name, dir } = splitPath(state.path)
    return (
      <div className="hm-pandoc-status" role="dialog" aria-modal="true" aria-labelledby="hm-pandoc-title">
        <div className="hm-pandoc-status-dialog success">
          <div className="hm-pandoc-status-icon success"><Icon name="check" size={20} /></div>
          <div className="hm-pandoc-status-copy">
            <h2 id="hm-pandoc-title">{t('pandoc.status.success')}</h2>
            <p className="hm-pandoc-file" title={state.path}>{name}</p>
            {dir && <p className="hm-pandoc-dir" title={dir}>{t('pandoc.savedIn', { dir })}</p>}
            {state.mathUnsupported && <p className="warning">{t('pandoc.oldMath', { version: state.version || '—' })}</p>}
            {state.warning && <p className="warning">{t('pandoc.successWarning', { msg: state.warning })}</p>}
            {openError && <p className="error" role="alert">{openError}</p>}
          </div>
          <div className="hm-pandoc-status-actions">
            <button type="button" onClick={onDismiss}>{t('find.close')}</button>
            <button type="button" onClick={() => open('folder')} disabled={opening}>{t('pandoc.showInFolder')}</button>
            <button type="button" className="primary" ref={primaryRef} onClick={() => open('file')} disabled={opening}>{t('pandoc.openFile')}</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="hm-pandoc-status" role="dialog" aria-modal="true" aria-labelledby="hm-pandoc-title">
      <div className="hm-pandoc-status-dialog">
        <div className={`hm-pandoc-status-icon ${status}`}><Icon name={status === 'error' ? 'info' : 'refresh'} size={20} /></div>
        <div className="hm-pandoc-status-copy">
          <h2 id="hm-pandoc-title">{t(`pandoc.status.${status}`)}</h2>
          <p>{status === 'running' ? t('pandoc.runningHelp') : state.error}</p>
        </div>
        {status === 'error' && state.code === 'not-installed' && <button type="button" onClick={onInstall}>{t('pandoc.install')}</button>}
        {status !== 'running' && <button type="button" onClick={onDismiss}>{t('find.close')}</button>}
      </div>
    </div>
  )
}
