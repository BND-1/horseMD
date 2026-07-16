import { useEffect, useMemo, useState } from 'react'
import { createPdfOptions, normalizePdfOptions } from '../../../../shared/pdf-options.js'
import { usePdfPreview } from '../../hooks/usePdfPreview.js'
import { Icon } from '../icons.jsx'
import PdfPreview from './PdfPreview.jsx'
import PdfSettings from './PdfSettings.jsx'
import './pdf-export.css'

export default function PdfExportStudio({ request, saving, saveError, onCancel, onSave, t }) {
  const [options, setOptions] = useState(() => createPdfOptions(request.source?.title || '', t('pdf.tocTitle')))
  const normalized = useMemo(() => {
    try {
      return { options: normalizePdfOptions(options), error: null }
    } catch {
      return { options: null, error: 'invalid-page-range' }
    }
  }, [options])
  const preview = usePdfPreview({ request: normalized.options ? request : null, options: normalized.options })

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !saving) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel, saving])

  const canSave = preview.status === 'ready' && !!preview.token && !normalized.error && !saving

  return (
    <div className="hm-pdf-studio" role="dialog" aria-modal="true" aria-labelledby="hm-pdf-studio-title" aria-busy={saving || preview.status === 'previewing'} data-source-headings={request.source?.headings?.length || 0}>
      <header className="hm-pdf-studio-header">
        <div>
          <Icon name="file" size={18} />
          <h2 id="hm-pdf-studio-title">{t('pdf.title')}</h2>
        </div>
        <button type="button" className="hm-pdf-close" title={t('edit.cancel')} disabled={saving} onClick={onCancel}><Icon name="close" size={18} /></button>
      </header>
      <div className="hm-pdf-studio-body">
        <PdfSettings options={options} setOptions={setOptions} rangeError={normalized.error} t={t} />
        <PdfPreview {...preview} t={t} />
      </div>
      <footer className="hm-pdf-studio-footer">
        <div className="hm-pdf-export-message" role={saveError ? 'alert' : 'status'}>
          {saveError ? t('pdf.error', { msg: saveError }) : t('pdf.previewHint')}
        </div>
        <button type="button" disabled={saving} onClick={onCancel}>{t('edit.cancel')}</button>
        <button type="button" className="primary" disabled={!canSave} onClick={() => onSave(preview.token)}>
          {saving ? t('pdf.saving') : t('pdf.export')}
        </button>
      </footer>
    </div>
  )
}
