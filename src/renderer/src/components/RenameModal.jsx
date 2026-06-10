import { useEffect, useRef, useState } from 'react'

// Small modal for renaming a tab's file (Electron has no window.prompt). The
// filename (without extension) is pre-selected; Enter confirms, Esc cancels.
export default function RenameModal({ t, initial, onConfirm, onCancel }) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef(null)
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])
  return (
    <>
      <div className="menu-backdrop" onMouseDown={onCancel} />
      <div className="hm-rename-modal" role="dialog" aria-modal="true">
        <div className="hm-rename-title">{t('side.rename')}</div>
        <input
          ref={inputRef}
          className="hm-rename-input"
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onConfirm(value) }
            if (e.key === 'Escape') { e.preventDefault(); onCancel() }
          }}
        />
        <div className="hm-rename-actions">
          <button onClick={onCancel}>{t('edit.cancel')}</button>
          <button className="primary" onClick={() => onConfirm(value)}>{t('edit.confirm')}</button>
        </div>
      </div>
    </>
  )
}
