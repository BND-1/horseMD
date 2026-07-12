import { useEffect, useState } from 'react'
import { Icon } from './icons.jsx'

// Custom caption buttons for Windows and Linux.
// macOS uses its native traffic lights, so this isn't rendered there.
// On Linux we use the GNOME/GTK style (square buttons with rounded-rect hover,
// matching VSCode on Linux). On Windows we use the traditional flat wide buttons.
const isLinux = window.api.platform === 'linux'

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

  if (isLinux) {
    return (
      <div className="gtk-controls drag-no">
        <button className="gtk-ctrl" title={t('tip.minimize')} onClick={() => window.api.windowMinimize()}>
          <Icon name="gtk-min" size={16} strokeWidth={1.4} />
        </button>
        <button
          className="gtk-ctrl"
          title={t(max ? 'tip.restore' : 'tip.maximize')}
          onClick={async () => setMax(!!(await window.api.windowToggleMaximize()))}
        >
          <Icon name={max ? 'gtk-restore' : 'gtk-max'} size={14} strokeWidth={1.4} />
        </button>
        <button className="gtk-ctrl close" title={t('tip.close')} onClick={() => window.api.windowClose()}>
          <Icon name="close" size={14} strokeWidth={1.4} />
        </button>
      </div>
    )
  }

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
