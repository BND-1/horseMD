import { useCallback, useRef, useState } from 'react'

export function useHtmlExport({ tRef }) {
  const [htmlExportState, setHtmlExportState] = useState(null)
  const stateRef = useRef(null)
  const savingRef = useRef(false)
  stateRef.current = htmlExportState

  const requestHtmlExport = useCallback((source, defaultName, sourcePath) => {
    if (!source || savingRef.current) return
    const next = { source, defaultName, sourcePath: sourcePath || null, status: 'idle', error: null }
    stateRef.current = next
    setHtmlExportState(next)
  }, [])

  const cancelHtmlExport = useCallback(() => {
    if (savingRef.current) return
    stateRef.current = null
    setHtmlExportState(null)
  }, [])

  const saveHtmlExport = useCallback(async (token) => {
    if (!token || savingRef.current || !stateRef.current) return false
    const request = stateRef.current
    savingRef.current = true
    const saving = { ...request, status: 'saving', error: null }
    stateRef.current = saving
    setHtmlExportState(saving)
    try {
      const result = await window.api.saveHTMLPreview(token, request.defaultName)
      savingRef.current = false
      if (result?.canceled) {
        const idle = { ...request, status: 'idle', error: null }
        stateRef.current = idle
        setHtmlExportState(idle)
        return false
      }
      if (!result?.path) throw new Error(result?.error || tRef.current('html.errorUnknown'))
      stateRef.current = null
      setHtmlExportState(null)
      return true
    } catch (error) {
      savingRef.current = false
      const failed = {
        ...request,
        status: 'idle',
        error: error instanceof Error ? error.message : String(error || '')
      }
      stateRef.current = failed
      setHtmlExportState(failed)
      return false
    }
  }, [tRef])

  return { htmlExportState, requestHtmlExport, cancelHtmlExport, saveHtmlExport }
}

