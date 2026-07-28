import { THEMES } from '../../themes.js'
import Toggle from '../ui/Toggle.jsx'

export default function AppearanceSettings({
  settings,
  onUpdateSettings,
  theme,
  setTheme,
  customThemes,
  customTheme,
  onPickCustom,
  onOpenThemesFolder,
  onGetMoreThemes,
  followsSystemTheme,
  lang,
  t
}) {
  const themeLabel = (item) => (lang === 'zh' ? item.zh : item.en)

  return (
    <section className="settings-block">
      <h2 className="settings-block-title">{t('settings.appearance')}</h2>
      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-row-label">{t('settings.followSystemTheme')}</div>
          <div className="settings-row-desc">
            {t('settings.followSystemThemeDesc')}
          </div>
        </div>
        <Toggle
          checked={followsSystemTheme}
          onChange={(enabled) => onUpdateSettings({ themeMode: enabled ? 'system' : 'manual' })}
          label={t('settings.followSystemTheme')}
        />
      </div>
      {followsSystemTheme && (
        <div className="settings-system-theme">
          <label className="settings-system-theme-field">
            <span>{t('settings.systemLightTheme')}</span>
            <select
              aria-label={t('settings.systemLightTheme')}
              value={settings.systemLightTheme}
              onChange={(event) => onUpdateSettings({ systemLightTheme: event.target.value })}
            >
              {THEMES.filter((item) => !item.dark).map((item) => (
                <option key={item.id} value={item.id}>{themeLabel(item)}</option>
              ))}
            </select>
          </label>
          <label className="settings-system-theme-field">
            <span>{t('settings.systemDarkTheme')}</span>
            <select
              aria-label={t('settings.systemDarkTheme')}
              value={settings.systemDarkTheme}
              onChange={(event) => onUpdateSettings({ systemDarkTheme: event.target.value })}
            >
              {THEMES.filter((item) => item.dark).map((item) => (
                <option key={item.id} value={item.id}>{themeLabel(item)}</option>
              ))}
            </select>
          </label>
          <p className="settings-system-theme-note">
            {t('settings.systemThemeCssHint')}
          </p>
        </div>
      )}
      <div className="settings-swatches">
        {THEMES.map((th) => (
          <button
            key={th.id}
            className={`settings-swatch${!customTheme && th.id === theme ? ' active' : ''}`}
            style={{ background: th.swatch }}
            title={followsSystemTheme ? t('settings.manualThemeHint') : themeLabel(th)}
            onClick={() => setTheme(th.id)}
          >
            <span className="settings-swatch-name">{themeLabel(th)}</span>
          </button>
        ))}
        {customThemes.map((c) => (
          <button
            key={c.file}
            className={`settings-swatch settings-swatch-custom${customTheme === c.file ? ' active' : ''}`}
            style={{ background: c.swatch || 'var(--accent-soft)' }}
            title={c.name}
            onClick={() => onPickCustom && onPickCustom(c.file)}
          >
            <span className="settings-swatch-name">{c.name}</span>
          </button>
        ))}
      </div>
      <div className="settings-row settings-row-actions">
        <button className="settings-link-btn" onClick={() => onOpenThemesFolder && onOpenThemesFolder()}>{t('settings.openThemesFolder')}</button>
        <button className="settings-link-btn" onClick={() => onGetMoreThemes && onGetMoreThemes()}>{t('settings.getMoreThemes')}</button>
      </div>
    </section>
  )
}
