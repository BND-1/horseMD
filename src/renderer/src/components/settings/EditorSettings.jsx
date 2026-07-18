import Toggle from '../ui/Toggle.jsx'
import TypographyControls from './TypographyControls.jsx'

export default function EditorSettings({ settings, onUpdateSettings, onHoverFont, t }) {
  return (
    <>
      <section className="settings-block">
        <h2 className="settings-block-title">{t('settings.typography')}</h2>
        <TypographyControls
          settings={settings}
          onUpdateSettings={onUpdateSettings}
          onHoverFont={onHoverFont}
          t={t}
        />
      </section>
      <section className="settings-block">
        <h2 className="settings-block-title">{t('settings.proofreading')}</h2>
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
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">{t('settings.inlineMathDelete')}</div>
            <div className="settings-row-desc">{t('settings.inlineMathDeleteDesc')}</div>
          </div>
          <div className="settings-segmented">
            {['protect', 'fast'].map((mode) => (
              <button
                key={mode}
                type="button"
                className={`settings-segmented-option${(settings.inlineMathDeleteMode || 'protect') === mode ? ' active' : ''}`}
                onClick={() => onUpdateSettings({ inlineMathDeleteMode: mode })}
              >
                {t(`settings.inlineMathDelete.${mode}`)}
              </button>
            ))}
          </div>
        </div>
      </section>
    </>
  )
}
