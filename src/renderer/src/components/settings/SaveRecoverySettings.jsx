import { useEffect, useState } from 'react'
import { Icon } from '../icons.jsx'
import { AUTO_SAVE_DELAYS, HISTORY_RETENTION_DAYS, DEFAULT_HISTORY_RETENTION_DAYS } from '../../settings.js'
import { errorText, formatBytes, historySupported, openDeletedFiles } from '../../lib/history-ui.js'

// Settings › 通用 › 保存与恢复 (Typora: Preferences › General › Save &
// Recover): auto-save, then the local version history as one card —
// space used against the cap, retention, 最近删除…, 清空历史… (two clicks).

function AutoSaveRow({ settings, onUpdateSettings, syncAutoSave, t }) {
  const delay = settings.autoSaveDelay || 0
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{t('settings.autoSave')}</div>
        <div className="settings-row-desc">{t('settings.autoSaveDesc')}</div>
        {syncAutoSave && !delay && (
          <div className="settings-row-desc settings-row-note">{t('settings.autoSave.syncNote')}</div>
        )}
      </div>
      <div className="settings-segmented">
        {AUTO_SAVE_DELAYS.map((value) => (
          <button
            key={value}
            type="button"
            className={`settings-segmented-option${delay === value ? ' active' : ''}`}
            onClick={() => onUpdateSettings({ autoSaveDelay: value })}
          >
            {value === 0
              ? t('settings.autoSave.off')
              : value >= 60
                ? t('settings.autoSave.minute')
                : t('settings.autoSave.seconds', { n: value })}
          </button>
        ))}
      </div>
    </div>
  )
}

function HistoryCard({ settings, onUpdateSettings, t }) {
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
  const cap = usage?.capBytes || 1024 * 1024 * 1024
  const ratio = usage ? Math.min(1, (usage.bytes || 0) / cap) : 0
  return (
    <div className="hm-history-card" data-settings="history">
      <div className="hm-history-card-head">
        <span className="hm-history-card-icon"><Icon name="history" size={16} /></span>
        <div className="hm-history-card-title">
          <strong>{t('history.settingsTitle')}</strong>
          <small>{t('history.settingsDesc')}</small>
        </div>
      </div>

      <div className="hm-history-card-usage">
        <div className="hm-history-meter" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={usage?.bytes || 0} aria-label={t('history.usageLabel')}>
          <span style={{ width: `${Math.max(ratio > 0 ? 1.5 : 0, ratio * 100)}%` }} />
        </div>
        <div className="hm-history-card-numbers">
          <span>
            {usage
              ? t('history.usageOfCap', { size: formatBytes(usage.bytes || 0), cap: formatBytes(cap) })
              : t('history.usageUnknown')}
          </span>
          {usage && <span>{t('history.usageCount', { files: usage.files || 0, n: usage.versions || 0 })}</span>}
        </div>
      </div>

      <div className="hm-history-card-row">
        <div className="settings-row-text">
          <div className="settings-row-label">{t('history.retention')}</div>
          <div className="settings-row-desc">{t('history.retentionRule')}</div>
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

      <div className="hm-history-card-foot">
        <span className="hm-history-card-tip"><Icon name="info" size={13} />{t('history.howToOpen')}</span>
        <div className="hm-history-settings-actions">
          <button type="button" className="settings-action-btn" onClick={openDeletedFiles}>
            <Icon name="trash" size={13} />{t('cmd.recentlyDeleted')}
          </button>
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
      {error && <div className="settings-row-desc hm-history-settings-error">{error}</div>}
    </div>
  )
}

export default function SaveRecoverySettings({ settings, onUpdateSettings, syncAutoSave = false, t }) {
  const mobile = window.api?.platform === 'ios' || window.api?.platform === 'android'
  const history = historySupported()
  if (mobile && !history) return null
  return (
    <section className="settings-block hm-save-recovery">
      <h2 className="settings-block-title">{t('settings.saveRecovery')}</h2>
      {!mobile && <AutoSaveRow settings={settings} onUpdateSettings={onUpdateSettings} syncAutoSave={syncAutoSave} t={t} />}
      {history && <HistoryCard settings={settings} onUpdateSettings={onUpdateSettings} t={t} />}
    </section>
  )
}
