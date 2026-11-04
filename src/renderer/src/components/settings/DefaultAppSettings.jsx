import { useCallback, useEffect, useState } from 'react'
import { fireToast } from '../../ui.js'

// Settings › 通用 › 默认打开方式 (#170): is HorseMD what a double-clicked
// .md opens, and a button to make it so. The system confirms the change —
// macOS with its own dialog, Windows through the "Open with" dialog (pick
// HorseMD + 始终) — see src/main/default-app.js. Hidden where unsupported
// (mobile, an unpackaged run).
export default function DefaultAppSettings({ t }) {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)
  const [waitingWindows, setWaitingWindows] = useState(false)

  const refresh = useCallback(() => Promise.resolve(window.api.defaultAppGet?.())
    .then((next) => { if (next) setState(next); return next })
    .catch(() => null), [])

  useEffect(() => {
    refresh()
    // Back from the system dialog / Settings: read it again.
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    // Windows: the user picked HorseMD in the "Open with" dialog.
    const off = window.api.onDefaultAppChanged?.(() => {
      setWaitingWindows(false)
      refresh().then((next) => { if (next?.isDefault) fireToast(t('settings.defaultApp.done')) })
    })
    return () => {
      window.removeEventListener('focus', onFocus)
      off?.()
    }
  }, [refresh, t])

  if (!window.api.defaultAppGet || !state?.supported) return null

  const set = async () => {
    setBusy(true)
    try {
      const next = await window.api.defaultAppSet()
      if (next) setState(next)
      if (next?.pending) setWaitingWindows(true)
      else if (next?.isDefault) fireToast(t('settings.defaultApp.done'))
    } finally {
      setBusy(false)
    }
  }

  let desc
  if (state.isDefault) desc = t('settings.defaultApp.isDefault')
  else if (waitingWindows) desc = t('settings.defaultApp.windowsHint')
  else if (state.current) desc = t('settings.defaultApp.current', { app: state.current })
  else desc = t('settings.defaultApp.notDefault')

  return (
    <section className="settings-block">
      <h2 className="settings-block-title">{t('settings.defaultApp')}</h2>
      <div className="settings-row hm-default-app">
        <div className="settings-row-text">
          <div className="settings-row-label">{t('settings.defaultApp.label')}</div>
          <div className="settings-row-desc" data-default-app-status={state.isDefault ? 'default' : 'other'}>{desc}</div>
        </div>
        <button className="settings-link-btn" data-default-app-set onClick={set} disabled={busy || state.isDefault}>
          {state.isDefault ? t('settings.defaultApp.already') : busy ? t('settings.defaultApp.waiting') : t('settings.defaultApp.set')}
        </button>
      </div>
    </section>
  )
}
