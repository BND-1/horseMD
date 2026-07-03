// Settings page — a full-tab view (kind:'settings') grouping every operable
// preference: typography (font size / line height / paragraph spacing / page
// width) with a live preview, spell-check toggle, theme, language, image-host
// command, and an About section. Opened from the ActivityBar gear button.
//
// Sections are added incrementally: US-4 adds Proofreading (spell-check toggle);
// US-5 adds Typography + live preview; US-6 adds Appearance / Language / Image
// host / About. StatusBar quick-controls (排版/主题/语言) stay where they are —
// this is their full-version home, not a replacement.
import { useI18n } from '../i18n.jsx'
import Toggle from './ui/Toggle.jsx'

export default function SettingsView({ settings, onUpdateSettings }) {
  const { t } = useI18n()
  return (
    <div className="settings-page">
      <div className="settings-card">
        <h1 className="settings-title">{t('settings.pageTitle')}</h1>
        <p className="settings-subtitle">{t('settings.pageSubtitle')}</p>

        {/* Proofreading — US-4 */}
        <section className="settings-section">
          <div className="settings-section-head">
            <span className="settings-section-title">{t('settings.proofreading')}</span>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">{t('settings.spellcheck')}</div>
              <div className="settings-row-desc">{t('settings.spellcheckDesc')}</div>
            </div>
            <Toggle
              checked={!!settings.spellcheck}
              onChange={(v) => onUpdateSettings({ spellcheck: v })}
              label={t('settings.spellcheck')}
            />
          </div>
        </section>

        {/* Typography + Appearance + Language + Image host + About come in US-5/US-6 */}
      </div>
    </div>
  )
}
