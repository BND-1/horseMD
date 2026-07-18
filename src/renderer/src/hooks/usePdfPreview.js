import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const asUint8Array = (value) => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value)) return Uint8Array.from(value)
  if (Array.isArray(value?.data)) return Uint8Array.from(value.data)
  return null
}

const capturePdfPreviewForTest = (payload) => {
  if (!window.__HORSEMD_TEST_CAPTURE_PDF__) return
  window.__horsemdLastPdfPreview = payload
}

export function usePdfPreview({ request, options, delay = 160 }) {
  const [state, setState] = useState({ status: 'idle', token: null, data: null, error: null, warnings: null })
  const [retryVersion, setRetryVersion] = useState(0)
  const requestIdRef = useRef(0)
  const tokenRef = useRef(null)
  const optionsKey = useMemo(() => JSON.stringify(options), [options])

  const retry = useCallback(() => setRetryVersion((value) => value + 1), [])

  useEffect(() => {
    if (!request) return
    const requestId = ++requestIdRef.current
    setState((previous) => ({ ...previous, status: 'previewing', error: null }))
    const timer = setTimeout(async () => {
      try {
        capturePdfPreviewForTest({ source: request.source, options })
        const result = await window.api.previewPDF(request.source, request.defaultName, options)
        if (requestId !== requestIdRef.current) {
          if (result?.token) window.api.disposePDFPreview(result.token).catch(() => {})
          return
        }
        const data = asUint8Array(result?.data)
        if (!result?.ok || !result.token || !data?.length) {
          throw new Error(result?.error || 'PDF preview returned no data')
        }
        tokenRef.current = result.token
        setState({
          status: 'ready',
          token: result.token,
          data,
          error: null,
          warnings: result.warnings || null
        })
        capturePdfPreviewForTest({
          source: request.source,
          options,
          result: {
            ok: true,
            token: result.token,
            bytes: data.length,
            warnings: result.warnings || null
          }
        })
      } catch (error) {
        if (requestId !== requestIdRef.current) return
        capturePdfPreviewForTest({
          source: request.source,
          options,
          result: {
            ok: false,
            error: error instanceof Error ? error.message : String(error || '')
          }
        })
        setState((previous) => ({
          ...previous,
          status: 'error',
          error: error instanceof Error ? error.message : String(error || '')
        }))
      }
    }, delay)
    return () => {
      clearTimeout(timer)
      if (requestId === requestIdRef.current) requestIdRef.current += 1
    }
  }, [request, optionsKey, retryVersion, delay])

  useEffect(() => () => {
    requestIdRef.current += 1
    if (tokenRef.current) window.api.disposePDFPreview(tokenRef.current).catch(() => {})
  }, [])

  return { ...state, retry }
}
