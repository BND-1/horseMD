import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export function useHtmlPreview({ request, options, delay = 180 }) {
  const [state, setState] = useState({ status: 'idle', token: null, html: '', error: null, warnings: null })
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
        const result = await window.api.previewHTML(request.source, request.defaultName, options, request.sourcePath)
        if (requestId !== requestIdRef.current) {
          if (result?.token) window.api.disposeHTMLPreview(result.token).catch(() => {})
          return
        }
        if (result?.stale) return
        if (!result?.ok || !result.token || !result.html) {
          throw new Error(result?.error || 'HTML preview returned no content')
        }
        tokenRef.current = result.token
        setState({
          status: 'ready',
          token: result.token,
          html: result.html,
          error: null,
          warnings: result.warnings || null
        })
      } catch (error) {
        if (requestId !== requestIdRef.current) return
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
    if (tokenRef.current) window.api.disposeHTMLPreview(tokenRef.current).catch(() => {})
  }, [])

  return { ...state, retry }
}

