import { useCallback, useRef, useState } from 'react'

export async function performPdfSave(savePDFPreview, token, defaultName) {
  try {
    const result = await savePDFPreview(token, defaultName)
    if (result?.canceled || result?.path) return { close: true, canceled: !!result.canceled, error: null }
    return { close: false, canceled: false, error: result?.error || null }
  } catch (error) {
    return {
      close: false,
      canceled: false,
      error: error instanceof Error ? error.message : String(error || '')
    }
  }
}

export function usePdfExport({ tRef }) {
  const [pdfExportState, setPdfExportState] = useState(null)
  const stateRef = useRef(null)
  const inFlightRef = useRef(false)
  stateRef.current = pdfExportState

  const requestPdfExport = useCallback((source, defaultName) => {
    if (!source || inFlightRef.current) return
    const normalizedSource = typeof source === 'string'
      ? { html: source, headings: [], title: String(defaultName || '').replace(/\.pdf$/i, '') }
      : source
    const next = { source: normalizedSource, defaultName, status: 'idle', error: null }
    stateRef.current = next
    setPdfExportState(next)
  }, [])

  const cancelPdfExport = useCallback(() => {
    if (inFlightRef.current) return
    stateRef.current = null
    setPdfExportState(null)
  }, [])

  const savePdfExport = useCallback(async (token) => {
    if (inFlightRef.current || !token) return false
    const request = stateRef.current
    if (!request) return false
    inFlightRef.current = true
    const saving = { ...request, status: 'saving', error: null }
    stateRef.current = saving
    setPdfExportState(saving)
    const result = await performPdfSave(window.api.savePDFPreview, token, request.defaultName)
    inFlightRef.current = false
    if (result.close) {
      if (!result.canceled) {
        stateRef.current = null
        setPdfExportState(null)
      } else {
        const idle = { ...request, status: 'idle', error: null }
        stateRef.current = idle
        setPdfExportState(idle)
      }
      return !result.canceled
    }
    const failed = {
      ...request,
      status: 'idle',
      error: result.error || tRef.current('pdf.errorUnknown')
    }
    stateRef.current = failed
    setPdfExportState(failed)
    return false
  }, [tRef])

  return { pdfExportState, requestPdfExport, cancelPdfExport, savePdfExport }
}
