import Toggle from '../ui/Toggle.jsx'
import { AUTO_SAVE_DELAYS } from '../../settings.js'
import DocumentToolsSettings from './DocumentToolsSettings.jsx'

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
        {window.api.platform !== 'ios' && window.api.platform !== 'android' && (
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">{t('settings.autoSave')}</div>
              <div className="settings-row-desc">{t('settings.autoSaveDesc')}</div>
            </div>
            <div className="settings-segmented">
              {AUTO_SAVE_DELAYS.map((delay) => (
                <button
                  key={delay}
                  type="button"
                  className={`settings-segmented-option${(settings.autoSaveDelay || 0) === delay ? ' active' : ''}`}
                  onClick={() => onUpdateSettings({ autoSaveDelay: delay })}
                >
                  {delay === 0
                    ? t('settings.autoSave.off')
                    : delay >= 60
                      ? t('settings.autoSave.minute')
                      : t('settings.autoSave.seconds', { n: delay })}
                </button>
              ))}
            </div>
          </div>
        )}
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
      {window.api.capabilities?.pandocExport && <DocumentToolsSettings t={t} />}
    </>
  )
}
