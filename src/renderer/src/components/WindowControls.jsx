import { useEffect, useState } from 'react'
import { Icon } from './icons.jsx'

// Custom Windows/Linux caption buttons (the native overlay is disabled in the
// main process). macOS uses its native traffic lights, so this isn't rendered
// there. The maximize icon reflects the live window state.
export default function WindowControls({ t }) {
  const [max, setMax] = useState(false)
  useEffect(() => {
    let alive = true
    window.api.windowIsMaximized?.().then((v) => alive && setMax(!!v))
    const off = window.api.onWindowMaximized?.((v) => setMax(!!v))
    return () => {
      alive = false
      off?.()
    }
  }, [])
  return (
    <div className="win-controls drag-no">
      <button className="win-ctrl" title={t('tip.minimize')} onClick={() => window.api.windowMinimize()}>
        <Icon name="win-min" size={14} strokeWidth={1.6} />
      </button>
      <button
        className="win-ctrl"
        title={t(max ? 'tip.restore' : 'tip.maximize')}
        onClick={async () => setMax(!!(await window.api.windowToggleMaximize()))}
      >
        <Icon name={max ? 'win-restore' : 'win-max'} size={13} strokeWidth={1.6} />
      </button>
      <button className="win-ctrl close" title={t('tip.close')} onClick={() => window.api.windowClose()}>
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
