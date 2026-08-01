export default function ExportSwitch({ checked, disabled = false, onChange, label, description, t }) {
  return (
    <button
      type="button"
      className="hm-pdf-switch"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="hm-pdf-switch-track" aria-hidden="true" />
      <span className="hm-pdf-switch-copy">
        <b>{label}</b>
        {description && <small>{description}</small>}
      </span>
      <em>{t(checked ? 'pdf.switchOn' : 'pdf.switchOff')}</em>
    </button>
  )
}

