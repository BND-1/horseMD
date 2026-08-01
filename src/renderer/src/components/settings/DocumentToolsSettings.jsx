import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../icons.jsx'
import './document-tools-settings.css'

const EMPTY_INFO = { available: false, path: null, version: null }

export default function DocumentToolsSettings({ t }) {
  const [info, setInfo] = useState(EMPTY_INFO)
  const [status, setStatus] = useState('detecting')
  const [error, setError] = useState('')

  const detect = useCallback(async () => {
    setStatus('detecting')
    setError('')
    try {
      const result = await window.api.detectPandoc()
      setInfo(result || EMPTY_INFO)
      setStatus(result?.available ? 'available' : 'missing')
    } catch (nextError) {
      setStatus('missing')
      setError(nextError instanceof Error ? nextError.message : String(nextError || ''))
    }
  }, [])

  useEffect(() => { detect() }, [detect])

  const choose = async () => {
    setError('')
    const result = await window.api.selectPandocExecutable()
    if (result?.canceled) return
    if (!result?.ok) {
      setError(result?.error || t('pandoc.invalidExecutable'))
      return
    }
    setInfo(result)
    setStatus('available')
  }

  return (
    <section className="settings-block hm-document-tools-settings">
      <h2 className="settings-block-title">{t('settings.documentTools')}</h2>
      <p className="settings-block-desc">{t('settings.documentToolsDesc')}</p>
      <div className={`hm-pandoc-tool-state ${status}`}>
        <span className="hm-pandoc-tool-icon"><Icon name={status === 'available' ? 'check' : status === 'detecting' ? 'refresh' : 'info'} size={16} /></span>
        <div className="hm-pandoc-tool-copy">
          <strong>{t(`pandoc.detect.${status}`)}</strong>
          {status === 'available' && <small>{t('pandoc.versionPath', { version: info.version || '—', path: info.path || '—' })}</small>}
          {status === 'missing' && <small>{t('pandoc.installSummary')}</small>}
          {error && <small className="error">{error}</small>}
        </div>
        <div className="hm-pandoc-tool-actions">
          <button type="button" onClick={detect}><Icon name="refresh" size={15} /><span>{t('pandoc.detectAgain')}</span></button>
          <button type="button" onClick={choose}><Icon name="folder-open" size={15} /><span>{t('pandoc.chooseExecutable')}</span></button>
          <button type="button" onClick={() => window.api.openExternal('https://pandoc.org/installing.html')}><Icon name="globe" size={15} /><span>{t('pandoc.installGuide')}</span></button>
        </div>
      </div>
    </section>
  )
}

