import { LANGS } from '../../i18n.jsx'
import Toggle from '../ui/Toggle.jsx'

export default function GeneralSettings({ lang, setLang, settings, onUpdateSettings, t }) {
  return (
    <>
      <section className="settings-block">
        <h2 className="settings-block-title">{t('settings.language')}</h2>
        <div className="settings-langs">
          {LANGS.map((l) => (
            <button key={l.id} className={`settings-lang${l.id === lang ? ' active' : ''}`} onClick={() => setLang(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-block">
        <h2 className="settings-block-title">{t('settings.startup')}</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">{t('settings.restoreSession')}</div>
            <div className="settings-row-desc">{t('settings.restoreSessionDesc')}</div>
          </div>
          <Toggle
            checked={settings.restoreSession !== false}
            onChange={(restoreSession) => onUpdateSettings({ restoreSession })}
            label={t('settings.restoreSession')}
          />
        </div>
      </section>
    </>
  )
}
