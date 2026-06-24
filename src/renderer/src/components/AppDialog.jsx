import { useCallback, useRef, useState } from 'react'
import { Icon } from './icons.jsx'

export function useAppDialog() {
  const [dialog, setDialog] = useState(null)
  const resolverRef = useRef(null)

  const close = useCallback((value) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setDialog(null)
    resolve?.(value)
  }, [])

  const alert = useCallback((options) => new Promise((resolve) => {
    resolverRef.current = resolve
    setDialog(typeof options === 'string' ? { message: options, type: 'info', mode: 'alert' } : { ...options, mode: 'alert' })
  }), [])

  const confirm = useCallback((options) => new Promise((resolve) => {
    resolverRef.current = resolve
    setDialog(typeof options === 'string' ? { message: options, type: 'warning', mode: 'confirm' } : { ...options, mode: 'confirm' })
  }), [])

  const node = dialog ? <AppDialog dialog={dialog} onClose={close} /> : null
  return { alert, confirm, node }
}

function AppDialog({ dialog, onClose }) {
  const isDanger = dialog.type === 'danger'
  const isError = dialog.type === 'error'
  const icon = isDanger ? 'trash' : isError ? 'alert-circle' : dialog.type === 'warning' ? 'warning' : 'info'

  return (
    <div className="app-dialog-backdrop" role="presentation" onMouseDown={() => onClose(false)}>
      <div className={`app-dialog ${dialog.type || 'info'}`} role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="app-dialog-icon">
          <Icon name={icon} size={20} />
        </div>
        <div className="app-dialog-main">
          <div className="app-dialog-title">{dialog.title}</div>
          <div className="app-dialog-message">{dialog.message}</div>
          {dialog.detail && <div className="app-dialog-detail">{dialog.detail}</div>}
          <div className="app-dialog-actions">
            {dialog.mode === 'confirm' && (
              <button onClick={() => onClose(false)}>
                {dialog.cancelText}
              </button>
            )}
            <button className={isDanger ? 'danger' : 'primary'} autoFocus onClick={() => onClose(true)}>
              {dialog.confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
