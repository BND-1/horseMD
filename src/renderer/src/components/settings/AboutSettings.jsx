import UpdateChecker from './UpdateChecker.jsx'
import { UPDATE_MODES } from '../../settings.js'

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''

// 更新方式 (#170): prompt / install quietly on quit / only by hand. Desktop
// only (mobile has no in-app update).
function UpdateModeRow({ settings, onUpdateSettings, t }) {
  if (!window.api.updateSetMode) return null
  const mode = UPDATE_MODES.includes(settings.updateMode) ? settings.updateMode : 'notify'
  return (
    <div className="settings-row settings-update-mode">
      <div className="settings-row-text">
        <div className="settings-row-label">{t('settings.updateMode')}</div>
        <div className="settings-row-desc">{t(`settings.updateMode.${mode}Desc`)}</div>
      </div>
      <div className="settings-segmented">
        {UPDATE_MODES.map((value) => (
          <button
            key={value}
            type="button"
            data-update-mode={value}
            className={`settings-segmented-option${mode === value ? ' active' : ''}`}
            onClick={() => onUpdateSettings({ updateMode: value })}
          >
            {t(`settings.updateMode.${value}`)}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function AboutSettings({ settings = {}, onUpdateSettings, t }) {
  return (
    <section className="settings-block">
      <h2 className="settings-block-title">{t('settings.about')}</h2>
      <div className="settings-row">
        <div className="settings-row-label">HorseMD {APP_VERSION && <span className="settings-version">{APP_VERSION}</span>}</div>
      </div>
      <UpdateChecker t={t} />
      {onUpdateSettings && <UpdateModeRow settings={settings} onUpdateSettings={onUpdateSettings} t={t} />}
      <div className="settings-row settings-row-actions">
        <button className="settings-link-btn" onClick={() => window.api.openExternal('https://horsemd.yangsir.net')}>{t('settings.website')}</button>
        <button className="settings-link-btn" onClick={() => window.api.openExternal('https://github.com/BND-1/horseMD')}>GitHub</button>
        <button className="settings-link-btn" onClick={() => window.api.openExternal('https://gitee.com/yty11167/horse-md')}>Gitee</button>
      </div>
    </section>
  )
}
