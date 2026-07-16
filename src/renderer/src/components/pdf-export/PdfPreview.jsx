import { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import PdfPage from './PdfPage.jsx'
import { loadPdfJs, readPdfOutline } from './pdf-js.js'

export default function PdfPreview({ data, status, token, error, warnings, retry, t }) {
  const scrollRef = useRef(null)
  const [document, setDocument] = useState(null)
  const [size, setSize] = useState({ width: 595, height: 842 })
  const [zoom, setZoom] = useState(0.9)
  const [currentPage, setCurrentPage] = useState(1)
  const [outline, setOutline] = useState([])
  const [outlineOpen, setOutlineOpen] = useState(false)

  useEffect(() => {
    if (!data?.length) {
      setDocument(null)
      return
    }
    let canceled = false
    let task = null
    loadPdfJs().then((pdfjs) => {
      if (canceled) return null
      task = pdfjs.getDocument({ data: Uint8Array.from(data) })
      return task.promise
    }).then(async (nextDocument) => {
      if (!nextDocument) return
      if (canceled) {
        nextDocument.destroy()
        return
      }
      const firstPage = await nextDocument.getPage(1)
      const outlineRows = await readPdfOutline(nextDocument, t('pdf.bookmarks'))
      const viewport = firstPage.getViewport({ scale: 1 })
      setSize({ width: viewport.width, height: viewport.height })
      setDocument((previous) => {
        previous?.destroy?.()
        return nextDocument
      })
      setOutline(outlineRows)
      if (!outlineRows.length) setOutlineOpen(false)
      setCurrentPage(1)
      scrollRef.current?.scrollTo({ top: 0 })
    }).catch((loadError) => {
      if (!canceled) console.error('PDF preview load failed', loadError)
    })
    return () => {
      canceled = true
      task?.destroy?.()
    }
  }, [data, t])

  useEffect(() => {
    const root = scrollRef.current
    if (!root || !document) return
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      if (visible) setCurrentPage(Number(visible.target.dataset.pdfPage || 1))
    }, { root, threshold: [0.2, 0.45, 0.7] })
    root.querySelectorAll('[data-pdf-page]').forEach((page) => observer.observe(page))
    return () => observer.disconnect()
  }, [document, zoom])

  const zoomBy = (delta) => setZoom((value) => Math.min(1.6, Math.max(0.5, Number((value + delta).toFixed(2)))))
  const goToPage = (page) => {
    const target = scrollRef.current?.querySelector(`[data-pdf-page="${page}"]`)
    target?.scrollIntoView({ block: 'start' })
  }

  return (
    <section className="hm-pdf-preview" aria-label={t('pdf.preview')} data-preview-token={token || ''} data-outline-count={outline.length}>
      <div className="hm-pdf-preview-toolbar">
        <div className="hm-pdf-preview-leading">
          {outline.length > 0 && (
            <button type="button" className={outlineOpen ? 'active' : ''} title={t(outlineOpen ? 'pdf.hideBookmarks' : 'pdf.showBookmarks')} aria-pressed={outlineOpen} onClick={() => setOutlineOpen((value) => !value)}>
              <Icon name="outline" size={16} />
            </button>
          )}
          <span className="hm-pdf-page-count">
            {document ? t('pdf.pageCount', { current: currentPage, total: document.numPages }) : t('pdf.preview')}
          </span>
        </div>
        <div className="hm-pdf-zoom-controls">
          <button type="button" title={t('pdf.zoomOut')} onClick={() => zoomBy(-0.1)} disabled={zoom <= 0.5}>
            <Icon name="search-minus" size={16} />
          </button>
          <button type="button" className="hm-pdf-zoom-value" title={t('pdf.resetZoom')} onClick={() => setZoom(0.9)}>
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" title={t('pdf.zoomIn')} onClick={() => zoomBy(0.1)} disabled={zoom >= 1.6}>
            <Icon name="search-plus" size={16} />
          </button>
        </div>
      </div>

      <div className={`hm-pdf-preview-content${outlineOpen && outline.length ? ' with-outline' : ''}`}>
        {outlineOpen && outline.length > 0 && (
          <nav className="hm-pdf-outline" aria-label={t('pdf.bookmarks')}>
            <h3>{t('pdf.bookmarks')}</h3>
            {outline.map((item, index) => (
              <button key={`${item.title}-${index}`} type="button" style={{ paddingLeft: 12 + Math.min(item.level, 5) * 12 }} disabled={!item.page} title={item.title} onClick={() => goToPage(item.page)}>
                <span>{item.title}</span>
                {item.page && <small>{item.page}</small>}
              </button>
            ))}
          </nav>
        )}
        <div className="hm-pdf-preview-scroll" ref={scrollRef}>
          {document && Array.from({ length: document.numPages }, (_, index) => (
            <PdfPage key={`${document.fingerprints?.[0] || 'pdf'}-${index + 1}`} document={document} pageNumber={index + 1} size={size} zoom={zoom} />
          ))}
          {!document && status !== 'error' && (
            <div className="hm-pdf-preview-empty">{t(status === 'previewing' ? 'pdf.generatingPreview' : 'pdf.previewWaiting')}</div>
          )}
        </div>
      </div>

      {status === 'previewing' && <div className="hm-pdf-preview-progress" role="status">{t('pdf.generatingPreview')}</div>}
      {status === 'error' && (
        <div className="hm-pdf-preview-error" role="alert">
          <strong>{t('pdf.previewFailed')}</strong>
          <span>{error}</span>
          <button type="button" onClick={retry}>{t('pdf.retry')}</button>
        </div>
      )}
      {(warnings?.resourceTimeout || warnings?.failedImages > 0) && (
        <div className="hm-pdf-preview-warning" role="status">
          {t('pdf.resourceWarning', { n: warnings.failedImages || 0 })}
        </div>
      )}
    </section>
  )
}
