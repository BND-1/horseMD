import { PDF_MARGIN_PRESETS, PDF_PAGE_SIZES, PDF_PAGINATION } from '../../../../shared/pdf-options.js'

const Switch = ({ checked, disabled = false, onChange, label, description, t }) => (
  <button
    type="button"
    className="hm-pdf-switch"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
  >
    <span className="hm-pdf-switch-track" aria-hidden="true" />
    <span className="hm-pdf-switch-copy">
      <b>{label}</b>
      {description && <small>{description}</small>}
    </span>
    <em>{t(checked ? 'pdf.switchOn' : 'pdf.switchOff')}</em>
  </button>
)

export default function PdfSettings({ options, setOptions, rangeError, t }) {
  const set = (key, value) => setOptions((previous) => ({ ...previous, [key]: value }))
  const setMargin = (key, value) => setOptions((previous) => ({
    ...previous,
    margins: { ...previous.margins, [key]: value }
  }))

  return (
    <aside className="hm-pdf-settings">
      <section>
        <h3>{t('pdf.section.page')}</h3>
        <label className="hm-pdf-field">
          <span>{t('pdf.pageSize')}</span>
          <select value={options.pageSize} onChange={(event) => set('pageSize', event.target.value)}>
            {PDF_PAGE_SIZES.map((value) => <option key={value} value={value}>{t(`pdf.size.${value}`)}</option>)}
          </select>
        </label>
        {options.pageSize === 'Custom' && (
          <div className="hm-pdf-dimension-grid">
            <label><span>{t('pdf.width')}</span><input type="number" min="50" max="1000" value={options.customWidth} onChange={(event) => set('customWidth', event.target.value)} /><small>mm</small></label>
            <label><span>{t('pdf.height')}</span><input type="number" min="50" max="1000" value={options.customHeight} onChange={(event) => set('customHeight', event.target.value)} /><small>mm</small></label>
          </div>
        )}
        <div className="hm-pdf-field">
          <span>{t('pdf.orientation')}</span>
          <div className="hm-pdf-segmented">
            {['portrait', 'landscape'].map((value) => (
              <button key={value} type="button" className={options.orientation === value ? 'active' : ''} onClick={() => set('orientation', value)}>{t(`pdf.${value}`)}</button>
            ))}
          </div>
        </div>
        <label className="hm-pdf-field">
          <span>{t('pdf.margins')}</span>
          <select value={options.marginPreset} onChange={(event) => set('marginPreset', event.target.value)}>
            {PDF_MARGIN_PRESETS.map((value) => <option key={value} value={value}>{t(`pdf.margin.${value}`)}</option>)}
          </select>
        </label>
        {options.marginPreset === 'custom' && (
          <div className="hm-pdf-margin-grid">
            {['top', 'right', 'bottom', 'left'].map((key) => (
              <label key={key}><span>{t(`pdf.margin.${key}`)}</span><input type="number" min="0" max="100" value={options.margins[key]} onChange={(event) => setMargin(key, event.target.value)} /><small>mm</small></label>
            ))}
          </div>
        )}
        <label className="hm-pdf-field hm-pdf-scale">
          <span>{t('pdf.scale')}</span>
          <div><input type="range" min="50" max="200" step="5" value={options.scale} onChange={(event) => set('scale', Number(event.target.value))} /><output>{options.scale}%</output></div>
        </label>
      </section>

      <section>
        <h3>{t('pdf.section.structure')}</h3>
        <label className="hm-pdf-field">
          <span>{t('pdf.pagination')}</span>
          <select value={options.pagination} onChange={(event) => set('pagination', event.target.value)}>
            {PDF_PAGINATION.map((value) => <option key={value} value={value}>{t(`pdf.pagination.${value}`)}</option>)}
          </select>
        </label>
        <Switch checked={options.includeToc} onChange={(value) => set('includeToc', value)} label={t('pdf.includeToc')} description={t('pdf.includeTocHelp')} t={t} />
        {options.includeToc && (
          <div className="hm-pdf-nested-settings">
            <label className="hm-pdf-field"><span>{t('pdf.tocDepth')}</span><select value={options.tocDepth} onChange={(event) => set('tocDepth', Number(event.target.value))}>{[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>H1–H{level}</option>)}</select></label>
            <Switch checked={options.tocPageBreak} onChange={(value) => set('tocPageBreak', value)} label={t('pdf.tocPageBreak')} t={t} />
          </div>
        )}
        <Switch checked={options.generateOutline} onChange={(value) => set('generateOutline', value)} label={t('pdf.generateOutline')} description={t('pdf.generateOutlineHelp')} t={t} />
      </section>

      <section>
        <h3>{t('pdf.section.headerFooter')}</h3>
        <label className="hm-pdf-field"><span>{t('pdf.documentTitle')}</span><input type="text" value={options.documentTitle} onChange={(event) => set('documentTitle', event.target.value)} /></label>
        <Switch checked={options.headerEnabled} onChange={(value) => set('headerEnabled', value)} label={t('pdf.header')} t={t} />
        {options.headerEnabled && (
          <div className="hm-pdf-nested-settings">
            <label className="hm-pdf-field"><span>{t('pdf.headerText')}</span><input type="text" value={options.headerText} placeholder={t('pdf.optional')} onChange={(event) => set('headerText', event.target.value)} /></label>
            <Switch checked={options.includeTitle} onChange={(value) => set('includeTitle', value)} label={t('pdf.includeTitle')} t={t} />
            <Switch checked={options.includeDate} onChange={(value) => set('includeDate', value)} label={t('pdf.includeDate')} t={t} />
          </div>
        )}
        <Switch checked={options.footerEnabled} onChange={(value) => set('footerEnabled', value)} label={t('pdf.footer')} t={t} />
        {options.footerEnabled && (
          <div className="hm-pdf-nested-settings">
            <label className="hm-pdf-field"><span>{t('pdf.footerText')}</span><input type="text" value={options.footerText} placeholder={t('pdf.optional')} onChange={(event) => set('footerText', event.target.value)} /></label>
            <Switch checked={options.includePageNumbers} onChange={(value) => set('includePageNumbers', value)} label={t('pdf.includePageNumbers')} t={t} />
          </div>
        )}
      </section>

      <section>
        <h3>{t('pdf.section.range')}</h3>
        <label className={`hm-pdf-field${rangeError ? ' invalid' : ''}`}>
          <span>{t('pdf.pageRanges')}</span>
          <input type="text" value={options.pageRanges} placeholder={t('pdf.pageRangesPlaceholder')} onChange={(event) => set('pageRanges', event.target.value)} />
          {rangeError && <small role="alert">{t('pdf.pageRangesInvalid')}</small>}
        </label>
      </section>
    </aside>
  )
}
