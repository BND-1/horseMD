import { THEMES } from '../../themes.js'

export default function AppearanceSettings({
  theme,
  setTheme,
  customThemes,
  customTheme,
  onPickCustom,
  onOpenThemesFolder,
  onGetMoreThemes,
  lang,
  t
}) {
  return (
    <section className="settings-block">
      <h2 className="settings-block-title">{t('settings.appearance')}</h2>
      <div className="settings-swatches">
        {THEMES.map((th) => (
          <button
            key={th.id}
            className={`settings-swatch${!customTheme && th.id === theme ? ' active' : ''}`}
            style={{ background: th.swatch }}
            title={lang === 'zh' ? th.zh : th.en}
            onClick={() => setTheme(th.id)}
          >
            <span className="settings-swatch-name">{lang === 'zh' ? th.zh : th.en}</span>
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
