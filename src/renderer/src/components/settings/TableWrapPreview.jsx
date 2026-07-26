export default function TableWrapPreview({ wraps, t }) {
  return (
    <div className="settings-table-preview" data-wrap={wraps ? 'true' : 'false'}>
      <div className="settings-table-preview-head">
        <span>{t('settings.tableAutoWrapPreview')}</span>
        <span className="settings-table-preview-state" aria-live="polite">
          {wraps ? t('settings.tableAutoWrapPreview.wrap') : t('settings.tableAutoWrapPreview.scroll')}
        </span>
      </div>
      <div className="settings-table-preview-viewport">
        <table>
          <thead>
            <tr>
              <th>{t('settings.tableAutoWrapPreview.project')}</th>
              <th>{t('settings.tableAutoWrapPreview.notes')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{t('settings.tableAutoWrapPreview.projectValue')}</td>
              <td>{t('settings.tableAutoWrapPreview.notesValue')}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
