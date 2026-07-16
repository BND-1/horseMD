import Toggle from '../ui/Toggle.jsx'

export default function FilesSettings({ settings, onUpdateSettings, t }) {
  return (
    <>
      <section className="settings-block">
        <h2 className="settings-block-title">{t('settings.files')}</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">{t('settings.showHiddenFiles')}</div>
            <div className="settings-row-desc">{t('settings.showHiddenFilesDesc')}</div>
          </div>
          <Toggle
            checked={!!settings.showHiddenFiles}
            onChange={(v) => onUpdateSettings({ showHiddenFiles: v })}
            label={t('settings.showHiddenFiles')}
          />
        </div>
      </section>
      <section className="settings-block">
        <h2 className="settings-block-title">{t('settings.imageHost')}</h2>
        <p className="settings-block-desc">{t('settings.imageHostDesc')}</p>
        <input
          className="settings-input" type="text" spellCheck={false}
          placeholder={t('settings.imageHostPlaceholder')}
          value={settings.imageUploadCommand || ''}
          onChange={(e) => onUpdateSettings({ imageUploadCommand: e.target.value })}
        />
      </section>
    </>
  )
}
