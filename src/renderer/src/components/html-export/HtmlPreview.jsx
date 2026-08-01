import { useState } from 'react'
import { Icon } from '../icons.jsx'

export default function HtmlPreview({ html, status, token, error, warnings, retry, t }) {
  const [viewport, setViewport] = useState('desktop')
  return (
    <section className="hm-html-preview" aria-label={t('html.preview')} data-preview-token={token || ''} data-preview-status={status}>
      <div className="hm-html-preview-toolbar">
        <span>{t('html.preview')}</span>
        <div className="hm-html-viewport-controls">
          <button type="button" className={viewport === 'desktop' ? 'active' : ''} title={t('html.desktopPreview')} onClick={() => setViewport('desktop')}><Icon name="monitor" size={15} /></button>
          <button type="button" className={viewport === 'mobile' ? 'active' : ''} title={t('html.mobilePreview')} onClick={() => setViewport('mobile')}><Icon name="smartphone" size={15} /></button>
        </div>
      </div>
      <div className={`hm-html-preview-stage ${viewport}`}>
        {html && <iframe title={t('html.preview')} sandbox="" srcDoc={html} />}
        {!html && status !== 'error' && <div className="hm-html-preview-empty">{t(status === 'previewing' ? 'html.generatingPreview' : 'html.previewWaiting')}</div>}
      </div>
      {status === 'previewing' && <div className="hm-html-preview-progress" role="status">{t('html.generatingPreview')}</div>}
      {status === 'error' && <div className="hm-html-preview-error" role="alert"><strong>{t('html.previewFailed')}</strong><span>{error}</span><button type="button" onClick={retry}>{t('pdf.retry')}</button></div>}
      {warnings?.unresolvedImages > 0 && <div className="hm-html-preview-warning" role="status">{t('html.resourceWarning', { n: warnings.unresolvedImages })}</div>}
    </section>
  )
}
