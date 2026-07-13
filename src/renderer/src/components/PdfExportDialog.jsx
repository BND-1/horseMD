import { useEffect, useRef, useState } from 'react'

const PAGE_SIZES = ['A4', 'A3', 'Letter', 'Custom']
const PAGINATION = ['none', 'h1', 'h2', 'h3', 'hr']

export default function PdfExportDialog({ t, onConfirm, onCancel }) {
  const [pageSize, setPageSize] = useState('A4')
  const [orientation, setOrientation] = useState('portrait')
  const [pagination, setPagination] = useState('none')
  const [customWidth, setCustomWidth] = useState('210')
  const [customHeight, setCustomHeight] = useState('297')
  const firstRef = useRef(null)

  useEffect(() => {
    firstRef.current?.focus()
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const width = Number(customWidth)
  const height = Number(customHeight)
  const customValid = pageSize !== 'Custom' || (
    Number.isFinite(width) && width >= 50 && width <= 1000 &&
    Number.isFinite(height) && height >= 50 && height <= 1000
  )
  const submit = () => {
    if (!customValid) return
    onConfirm({ pageSize, orientation, pagination, customWidth: width, customHeight: height })
  }

  return (
    <>
      <div className="menu-backdrop" onMouseDown={onCancel} />
      <div className="hm-pdf-modal" role="dialog" aria-modal="true" aria-labelledby="hm-pdf-title">
        <div className="hm-pdf-title" id="hm-pdf-title">{t('pdf.title')}</div>

        <label className="hm-pdf-field">
          <span>{t('pdf.pageSize')}</span>
          <select ref={firstRef} value={pageSize} onChange={(event) => setPageSize(event.target.value)}>
            {PAGE_SIZES.map((value) => (
              <option key={value} value={value}>{t(`pdf.size.${value}`)}</option>
            ))}
          </select>
        </label>

        {pageSize === 'Custom' && (
          <div className="hm-pdf-custom" aria-label={t('pdf.customSize')}>
            <label>
              <span>{t('pdf.width')}</span>
              <input
                type="number"
                min="50"
                max="1000"
                step="1"
                value={customWidth}
                onChange={(event) => setCustomWidth(event.target.value)}
              />
              <small>mm</small>
            </label>
            <label>
              <span>{t('pdf.height')}</span>
              <input
                type="number"
                min="50"
                max="1000"
                step="1"
                value={customHeight}
                onChange={(event) => setCustomHeight(event.target.value)}
              />
              <small>mm</small>
            </label>
          </div>
        )}

        <fieldset className="hm-pdf-orientation">
          <legend>{t('pdf.orientation')}</legend>
          <div className="hm-pdf-segmented">
            {['portrait', 'landscape'].map((value) => (
              <label key={value} className={orientation === value ? 'active' : ''}>
                <input
                  type="radio"
                  name="pdf-orientation"
                  value={value}
                  checked={orientation === value}
                  onChange={() => setOrientation(value)}
                />
                {t(`pdf.${value}`)}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="hm-pdf-field">
          <span>{t('pdf.pagination')}</span>
          <select value={pagination} onChange={(event) => setPagination(event.target.value)}>
            {PAGINATION.map((value) => (
              <option key={value} value={value}>{t(`pdf.pagination.${value}`)}</option>
            ))}
          </select>
        </label>

        <div className="hm-pdf-actions">
          <button onClick={onCancel}>{t('edit.cancel')}</button>
          <button className="primary" disabled={!customValid} onClick={submit}>{t('pdf.export')}</button>
        </div>
      </div>
    </>
  )
}
