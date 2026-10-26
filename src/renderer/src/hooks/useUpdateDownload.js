import { useCallback, useEffect, useState } from 'react'

// In-app update download (#164): mirrors the main process state
// (src/main/updater.js) — idle | downloading | ready | error — and exposes
// the actions. Main is the single owner: a reloaded window picks the
// running download up from update:getState.
export function useUpdateDownload() {
  const [state, setState] = useState({ status: 'idle' })
  useEffect(() => {
    let alive = true
    window.api.updateGetState?.().then((next) => { if (alive && next) setState(next) }).catch(() => {})
    const off = window.api.onUpdateState?.((next) => { if (next) setState(next) })
    return () => {
      alive = false
      off?.()
    }
  }, [])
  const start = useCallback(() => window.api.updateDownload?.(), [])
  const cancel = useCallback(() => window.api.updateCancel?.(), [])
  const install = useCallback(() => window.api.updateInstall?.(), [])
  const showFile = useCallback(() => window.api.updateShowFile?.(), [])
  return { state, start, cancel, install, showFile }
}
