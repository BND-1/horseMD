// Phones: PDF / HTML Studio show one pane at a time (preview first), switched
// by this segmented control under the header. Desktop never renders it.
export const isExportPhone = () => ['ios', 'android'].includes(window.api?.platform)

export default function ExportPhoneTabs({ value, onChange, t }) {
  return (
    <div className="hm-export-phone-tabs" role="tablist" aria-label={t('export.phoneTabs')}>
      {['preview', 'settings'].map((view) => (
        <button
          key={view}
          type="button"
          role="tab"
          aria-selected={value === view}
          className={value === view ? 'active' : ''}
          onClick={() => onChange(view)}
        >
          {t(view === 'preview' ? 'export.phonePreview' : 'export.phoneSettings')}
        </button>
      ))}
    </div>
  )
}
