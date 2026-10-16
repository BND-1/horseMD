import { HTML_THEMES, HTML_WIDTHS } from '../../../../shared/html-options.js'
import ExportSwitch from '../export/ExportSwitch.jsx'

export default function HtmlSettings({ options, setOptions, t }) {
  const set = (key, value) => setOptions((previous) => ({ ...previous, [key]: value }))
  return (
    <aside className="hm-pdf-settings hm-html-settings">
      <section>
        <h3>{t('html.section.style')}</h3>
        <label className="hm-pdf-field">
          <span>{t('html.theme')}</span>
          <select value={options.theme} onChange={(event) => set('theme', event.target.value)}>
            {HTML_THEMES.map((theme) => <option key={theme} value={theme}>{t(`html.theme.${theme}`)}</option>)}
          </select>
        </label>
        <label className="hm-pdf-field">
          <span>{t('html.contentWidth')}</span>
          <select value={options.contentWidth} onChange={(event) => set('contentWidth', event.target.value)}>
            {HTML_WIDTHS.map((width) => <option key={width} value={width}>{t(`html.width.${width}`)}</option>)}
          </select>
        </label>
        <label className="hm-pdf-field hm-pdf-scale">
          <span>{t('html.fontSize')}</span>
          <div><input type="range" min="12" max="24" step="1" value={options.fontSizePx} onChange={(event) => set('fontSizePx', Number(event.target.value))} /><output>{options.fontSizePx}px</output></div>
        </label>
        <label className="hm-pdf-field hm-pdf-scale">
          <span>{t('html.lineHeight')}</span>
          <div><input type="range" min="1.4" max="2.4" step="0.1" value={options.lineHeight} onChange={(event) => set('lineHeight', Number(event.target.value))} /><output>{Number(options.lineHeight).toFixed(1)}</output></div>
        </label>
      </section>
      <section>
        <h3>{t('html.section.structure')}</h3>
        <ExportSwitch checked={options.includeDocumentTitle} onChange={(value) => set('includeDocumentTitle', value)} label={t('html.includeTitle')} t={t} />
        <ExportSwitch checked={options.includeToc} onChange={(value) => set('includeToc', value)} label={t('html.includeToc')} description={t('html.includeTocHelp')} t={t} />
        {options.includeToc && (
          <div className="hm-pdf-nested-settings">
            <label className="hm-pdf-field"><span>{t('html.tocDepth')}</span><select value={options.tocDepth} onChange={(event) => set('tocDepth', Number(event.target.value))}>{[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>H1–H{level}</option>)}</select></label>
          </div>
        )}
      </section>
      <section className="hm-html-output-note">
        <h3>{t('html.section.output')}</h3>
        <p>{t('html.singleFileHelp')}</p>
      </section>
    </aside>
  )
}

