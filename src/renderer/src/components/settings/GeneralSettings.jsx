import { LANGS } from '../../i18n.jsx'

export default function GeneralSettings({ lang, setLang, t }) {
  return (
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
  )
}
