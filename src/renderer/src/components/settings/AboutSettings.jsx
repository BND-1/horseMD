import UpdateChecker from './UpdateChecker.jsx'

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''

export default function AboutSettings({ t }) {
  return (
    <section className="settings-block">
      <h2 className="settings-block-title">{t('settings.about')}</h2>
      <div className="settings-row">
        <div className="settings-row-label">HorseMD {APP_VERSION && <span className="settings-version">{APP_VERSION}</span>}</div>
      </div>
      <UpdateChecker t={t} />
      <div className="settings-row settings-row-actions">
        <button className="settings-link-btn" onClick={() => window.api.openExternal('https://horsemd.yangsir.net')}>{t('settings.website')}</button>
        <button className="settings-link-btn" onClick={() => window.api.openExternal('https://github.com/BND-1/horseMD')}>GitHub</button>
        <button className="settings-link-btn" onClick={() => window.api.openExternal('https://gitee.com/yty11167/horse-md')}>Gitee</button>
      </div>
    </section>
  )
}
