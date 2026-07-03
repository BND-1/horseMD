// Accessible on/off toggle switch, built from the app's theme tokens so it
// matches the .hm-seg-pill / .hm-pop DNA. Used by the Settings page (e.g. the
// spell-check switch). Keyboard: Space / Enter flips it (native <button>).
export default function Toggle({ checked, onChange, label, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked ? 'true' : 'false'}
      aria-label={label}
      disabled={disabled}
      className={`hm-toggle${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="hm-toggle-thumb" />
    </button>
  )
}
