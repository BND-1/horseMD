import Toggle from '../ui/Toggle.jsx'

export default function EditorSettings({
  settings, onUpdateSettings, t
}) {
  const isMobile = window.api?.platform === 'ios' || window.api?.platform === 'android'

  return (
    <>
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
      </section>
      <section className="settings-block">
        <h2 className="settings-block-title">{t('settings.editing')}</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">{t('settings.preserveSoftBreaks')}</div>
            <div className="settings-row-desc">{t('settings.preserveSoftBreaksDesc')}</div>
          </div>
          <Toggle
            checked={settings.preserveSoftBreaks !== false}
            onChange={(preserveSoftBreaks) => onUpdateSettings({ preserveSoftBreaks })}
            label={t('settings.preserveSoftBreaks')}
          />
        </div>
        {!isMobile && (
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">{t('settings.selectionToolbar')}</div>
              <div className="settings-row-desc">{t('settings.selectionToolbarDesc')}</div>
            </div>
            <Toggle
              checked={settings.selectionToolbar !== false}
              onChange={(selectionToolbar) => onUpdateSettings({ selectionToolbar })}
              label={t('settings.selectionToolbar')}
            />
          </div>
        )}
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
