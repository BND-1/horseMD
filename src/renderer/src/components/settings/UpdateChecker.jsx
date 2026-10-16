import { useState } from 'react'
import { resolveUpdateCheckState } from '../../lib/settings-update.js'

export default function UpdateChecker({ t }) {
  const [status, setStatus] = useState('idle')
  const [info, setInfo] = useState(null)

  const run = async () => {
    setStatus('checking')
    try {
      const r = await window.api.checkUpdate()
      const next = resolveUpdateCheckState(r)
      setInfo(next.info)
      setStatus(next.status)
    } catch {
      setInfo(null)
      setStatus('error')
    }
  }

  return (
    <div className="settings-row settings-update-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{t('settings.updateTitle')}</div>
        <div className="settings-row-desc settings-update-status">
          {status === 'checking' && t('settings.checking')}
          {status === 'uptodate' && t('settings.upToDate')}
          {status === 'available' && info && (
            <span>
              {t('settings.newVersionAvailable', { v: info.latest })}
              {' · '}
              <button className="settings-inline-link" onClick={() => info.url && window.api.openExternal(info.url)}>
                {t('update.download')} →
              </button>
            </span>
          )}
          {status === 'error' && t('settings.checkFailed')}
        </div>
      </div>
      <button
        className="settings-link-btn"
        onClick={run}
        disabled={status === 'checking'}
      >
        {status === 'checking' ? t('settings.checking') : t('settings.checkUpdate')}
      </button>
    </div>
  )
}
