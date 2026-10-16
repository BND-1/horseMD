import { useEffect, useMemo, useState } from 'react'
import { createHtmlOptions, normalizeHtmlOptions } from '../../../../shared/html-options.js'
import { useHtmlPreview } from '../../hooks/useHtmlPreview.js'
import { Icon } from '../icons.jsx'
import HtmlPreview from './HtmlPreview.jsx'
import HtmlSettings from './HtmlSettings.jsx'
import '../pdf-export/pdf-export.css'
import './html-export.css'

export default function HtmlExportStudio({ request, saving, saveError, onCancel, onSave, t }) {
  const [options, setOptions] = useState(() => createHtmlOptions(t('html.tocTitle')))
  const normalized = useMemo(() => normalizeHtmlOptions(options), [options])
  const preview = useHtmlPreview({ request, options: normalized })

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !saving) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel, saving])

  const canSave = preview.status === 'ready' && !!preview.token && !saving
  return (
    <div className="hm-pdf-studio hm-html-studio" role="dialog" aria-modal="true" aria-labelledby="hm-html-studio-title" aria-busy={saving || preview.status === 'previewing'}>
      <header className="hm-pdf-studio-header">
        <div><Icon name="globe" size={18} /><h2 id="hm-html-studio-title">{t('html.title')}</h2></div>
        <button type="button" className="hm-pdf-close" title={t('edit.cancel')} disabled={saving} onClick={onCancel}><Icon name="close" size={18} /></button>
      </header>
      <div className="hm-pdf-studio-body">
        <HtmlSettings options={options} setOptions={setOptions} t={t} />
        <HtmlPreview {...preview} t={t} />
      </div>
      <footer className="hm-pdf-studio-footer">
        <div className="hm-pdf-export-message" role={saveError ? 'alert' : 'status'}>{saveError ? t('html.error', { msg: saveError }) : t('html.previewHint')}</div>
        <button type="button" disabled={saving} onClick={onCancel}>{t('edit.cancel')}</button>
        <button type="button" className="primary" disabled={!canSave} onClick={() => onSave(preview.token)}>{saving ? t('html.saving') : t('html.export')}</button>
      </footer>
    </div>
  )
}

