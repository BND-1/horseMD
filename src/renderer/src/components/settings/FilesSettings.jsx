import { useEffect, useState } from 'react'
import Toggle from '../ui/Toggle.jsx'
import { AUTO_SAVE_DELAYS, HISTORY_RETENTION_DAYS, DEFAULT_HISTORY_RETENTION_DAYS } from '../../settings.js'
import { errorText, formatBytes, historySupported, openDeletedFiles } from '../../lib/history-ui.js'
import DocumentToolsSettings from './DocumentToolsSettings.jsx'

// 历史版本: retention, space used, 最近删除…, 清空历史… (two clicks).
function HistorySettings({ settings, onUpdateSettings, t }) {
  const [usage, setUsage] = useState(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState('')
  const refresh = () => {
    Promise.resolve(window.api.historyUsage?.())
      .then((res) => setUsage(res || null))
      .catch(() => setUsage(null))
  }
  useEffect(refresh, [])
  // The confirm step falls back after a few seconds.
  useEffect(() => {
    if (!confirmClear) return undefined
    const timer = setTimeout(() => setConfirmClear(false), 5000)
    return () => clearTimeout(timer)
  }, [confirmClear])
  const days = settings.historyRetentionDays || DEFAULT_HISTORY_RETENTION_DAYS
  const clear = async () => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    setConfirmClear(false)
    setClearing(true)
    setError('')
    try {
      await window.api.historyClear()
    } catch (err) {
      setError(t('history.clearFailed', { msg: errorText(err) }))
    }
    setClearing(false)
    refresh()
  }
  return (
    <section className="settings-block" data-settings="history">
      <h2 className="settings-block-title">{t('history.settingsTitle')}</h2>
      <p className="settings-block-desc">{t('history.settingsDesc')}</p>
      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-row-label">{t('history.retention')}</div>
        </div>
        <div className="settings-segmented">
          {HISTORY_RETENTION_DAYS.map((n) => (
            <button
              key={n}
              type="button"
              className={`settings-segmented-option${days === n ? ' active' : ''}`}
              onClick={() => onUpdateSettings({ historyRetentionDays: n })}
            >
              {n === 365 ? t('history.retention.year') : t('history.retention.days', { n })}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-row-label">{t('history.usageLabel')}</div>
          <div className="settings-row-desc">
            {usage
              ? t('history.usage', { size: formatBytes(usage.bytes), n: usage.versions || 0 })
              : t('history.usageUnknown')}
          </div>
          {error && <div className="settings-row-desc hm-history-settings-error">{error}</div>}
        </div>
        <div className="hm-history-settings-actions">
          <button type="button" className="settings-action-btn" onClick={openDeletedFiles}>{t('cmd.recentlyDeleted')}</button>
          <button
            type="button"
            className={`settings-action-btn${confirmClear ? ' hm-history-danger' : ''}`}
            disabled={clearing || !usage?.versions}
            onClick={clear}
          >
            {clearing ? t('history.clearing') : confirmClear ? t('history.clearConfirm') : t('history.clear')}
          </button>
        </div>
      </div>
    </section>
  )
}

export default function FilesSettings({ settings, onUpdateSettings, syncAutoSave = false, t }) {
  return (
    <>
      <section className="settings-block">
        <h2 className="settings-block-title">{t('settings.files')}</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">{t('settings.showHiddenFiles')}</div>
            <div className="settings-row-desc">{t('settings.showHiddenFilesDesc')}</div>
          </div>
          <Toggle
            checked={!!settings.showHiddenFiles}
            onChange={(v) => onUpdateSettings({ showHiddenFiles: v })}
            label={t('settings.showHiddenFiles')}
          />
        </div>
        {window.api.platform !== 'ios' && window.api.platform !== 'android' && (
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">{t('settings.autoSave')}</div>
              <div className="settings-row-desc">{t('settings.autoSaveDesc')}</div>
              {syncAutoSave && !settings.autoSaveDelay && (
                <div className="settings-row-desc settings-row-note">{t('settings.autoSave.syncNote')}</div>
              )}
            </div>
            <div className="settings-segmented">
              {AUTO_SAVE_DELAYS.map((delay) => (
                <button
                  key={delay}
                  type="button"
                  className={`settings-segmented-option${(settings.autoSaveDelay || 0) === delay ? ' active' : ''}`}
                  onClick={() => onUpdateSettings({ autoSaveDelay: delay })}
                >
                  {delay === 0
                    ? t('settings.autoSave.off')
                    : delay >= 60
                      ? t('settings.autoSave.minute')
                      : t('settings.autoSave.seconds', { n: delay })}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
      {historySupported() && <HistorySettings settings={settings} onUpdateSettings={onUpdateSettings} t={t} />}
      <section className="settings-block">
        <h2 className="settings-block-title">{t('settings.imageHost')}</h2>
        <p className="settings-block-desc">{t('settings.imageHostDesc')}</p>
        <input
          className="settings-input" type="text" spellCheck={false}
          placeholder={t('settings.imageHostPlaceholder')}
          value={settings.imageUploadCommand || ''}
          onChange={(e) => onUpdateSettings({ imageUploadCommand: e.target.value })}
        />
      </section>
      {window.api.capabilities?.pandocExport && <DocumentToolsSettings t={t} />}
    </>
  )
}
