import { useCallback, useRef, useState } from 'react'

export function usePandocExport() {
  const [pandocExportState, setPandocExportState] = useState(null)
  const runningRef = useRef(false)

  const requestPandocExport = useCallback(async (payload) => {
    if (runningRef.current) return
    runningRef.current = true
    setPandocExportState({ status: 'running', format: payload.format, error: null, warning: null, code: null, path: null })
    try {
      const result = await window.api.exportWithPandoc(payload)
      runningRef.current = false
      if (result?.canceled) {
        setPandocExportState(null)
        return
      }
      if (!result?.ok) {
        setPandocExportState({ status: 'error', format: payload.format, error: result?.error || '', warning: null, code: result?.code || null, path: null })
        return
      }
      setPandocExportState({ status: 'success', format: payload.format, error: null, warning: result.warning || null, code: null, path: result.path })
    } catch (error) {
      runningRef.current = false
      setPandocExportState({ status: 'error', format: payload.format, error: error instanceof Error ? error.message : String(error || ''), warning: null, code: null, path: null })
    }
  }, [])

  const dismissPandocExport = useCallback(() => {
    if (!runningRef.current) setPandocExportState(null)
  }, [])

  return { pandocExportState, requestPandocExport, dismissPandocExport }
}
