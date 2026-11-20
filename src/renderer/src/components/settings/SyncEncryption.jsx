// End-to-end encrypted sync in Settings › 云同步 (docs/official-sync-design.md
// §4; main: src/shared/sync/sync-service.js). Cryptomator / Joplin practice:
// the choice is made when a folder first goes to the cloud, the password is
// asked once per device (the unlocked key is kept in the system key store),
// and a folder this device cannot open stops and asks in place.
import { useState } from 'react'
import { Icon } from '../icons.jsx'
import Toggle from '../ui/Toggle.jsx'

export const MIN_PASSWORD = 8

// Electron prefixes main-process errors with the IPC channel name.
export const errorMessage = (cause) => String(cause?.message || cause).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')

export function passwordProblem(password, confirm, t) {
  if ([...String(password || '')].length < MIN_PASSWORD) return t('sync.e2ee.tooShort', { n: MIN_PASSWORD })
  if (confirm !== undefined && password !== confirm) return t('sync.e2ee.mismatch')
  return ''
}

export const isEncryptionReason = (reason) => /^e2ee-/.test(String(reason || ''))

function PasswordInput({ id, label, value, onChange, autoFocus = false, autoComplete = 'current-password', disabled }) {
  return <label className="sync-field sync-e2ee-field" htmlFor={id}>
    <span className="sync-field-label">{label}</span>
    <input
      id={id}
      type="password"
      value={value}
      autoFocus={autoFocus}
      autoComplete={autoComplete}
      spellCheck={false}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  </label>
}

// Fields: 'old' (current password), 'password', 'confirm'. `onSubmit(values)`
// resolves to an error message, or '' when done.
export function PasswordForm({ idPrefix, fields, labels = {}, submitLabel, note = '', onSubmit, onCancel = null, t }) {
  const [values, setValues] = useState({ old: '', password: '', confirm: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => {
    setValues((current) => ({ ...current, [key]: value }))
    setError('')
  }
  const submit = async (event) => {
    event.preventDefault()
    if (busy) return
    if (fields.includes('confirm')) {
      const problem = passwordProblem(values.password, values.confirm, t)
      if (problem) { setError(problem); return }
    } else if (!values.password) { setError(t('sync.e2ee.enterPassword')); return }
    if (fields.includes('old') && !values.old) { setError(t('sync.e2ee.enterPassword')); return }
    setBusy(true)
    try {
      const problem = await onSubmit(values)
      if (problem) setError(problem)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const creating = fields.includes('confirm')
  return <form className="sync-e2ee-form" onSubmit={submit} noValidate>
    {fields.includes('old') && <PasswordInput id={`${idPrefix}-old`} label={labels.old || t('sync.e2ee.oldPassword')} value={values.old} onChange={set('old')} autoFocus disabled={busy} />}
    <PasswordInput
      id={`${idPrefix}-password`}
      label={labels.password || t('sync.e2ee.password')}
      value={values.password}
      onChange={set('password')}
      autoFocus={!fields.includes('old')}
      autoComplete={creating ? 'new-password' : 'current-password'}
      disabled={busy}
    />
    {creating && <PasswordInput id={`${idPrefix}-confirm`} label={t('sync.e2ee.confirm')} value={values.confirm} onChange={set('confirm')} autoComplete="new-password" disabled={busy} />}
    {note && <p className="sync-e2ee-note">{note}</p>}
    {error && <p className="sync-e2ee-error" role="alert">{error}</p>}
    <div className="sync-e2ee-actions">
      <button type="submit" className="settings-action-btn primary" disabled={busy}>{busy ? t('sync.e2ee.working') : submitLabel}</button>
      {onCancel && <button type="button" className="settings-link-btn" disabled={busy} onClick={onCancel}>{t('sync.cancel')}</button>}
    </div>
  </form>
}

// Before a folder first goes to the cloud: 端到端加密 on / off + the password.
export function EncryptionChoice({ idPrefix, value, onChange, error = '', disabled = false, t }) {
  const set = (patch) => onChange({ ...value, ...patch, error: '' })
  return <div className={`sync-e2ee-choice${value.on ? ' on' : ''}`}>
    <div className="sync-e2ee-choice-head">
      <Icon name="lock" size={15} className="sync-e2ee-icon" />
      <div className="sync-e2ee-choice-copy">
        <div className="sync-e2ee-choice-title">{t('sync.e2ee.option')}</div>
        <div className="sync-e2ee-choice-desc">{t('sync.e2ee.optionDesc')}</div>
      </div>
      <Toggle checked={value.on} onChange={(on) => set({ on })} label={t('sync.e2ee.option')} disabled={disabled} />
    </div>
    {value.on && <div className="sync-e2ee-choice-fields">
      <PasswordInput id={`${idPrefix}-password`} label={t('sync.e2ee.password')} value={value.password} onChange={(password) => set({ password })} autoComplete="new-password" disabled={disabled} />
      <PasswordInput id={`${idPrefix}-confirm`} label={t('sync.e2ee.confirm')} value={value.confirm} onChange={(confirm) => set({ confirm })} autoComplete="new-password" disabled={disabled} />
      <p className="sync-e2ee-note">{t('sync.e2ee.warning')}</p>
    </div>}
    {(error || value.error) && <p className="sync-e2ee-error" role="alert">{error || value.error}</p>}
  </div>
}

// A folder the sync cannot open now (reason from main): what happened and
// the password, right under the folder.
export function SyncUnlock({ entry, reason, onUnlock, onStop, busy = false, t }) {
  const missing = reason === 'e2ee-key-missing'
  const key = reason === 'e2ee-key-changed' ? 'changed' : missing ? 'missing' : 'locked'
  return <div className="sync-attention sync-e2ee-unlock" role="alert" data-reason={reason}>
    <Icon name="lock" size={16} className="sync-attention-icon" />
    <div className="sync-attention-copy">
      <strong>{t(`sync.e2ee.${key}Title`)}</strong>
      <p>{t(`sync.e2ee.${key}Body`)}</p>
      <PasswordForm
        idPrefix={`unlock-${entry.workspaceId}`}
        fields={missing ? ['password', 'confirm'] : ['password']}
        submitLabel={t(missing ? 'sync.e2ee.resetSubmit' : 'sync.e2ee.unlockSubmit')}
        note={missing ? t('sync.e2ee.warning') : ''}
        onSubmit={({ password }) => onUnlock(entry, password)}
        t={t}
      />
      {onStop && <div className="sync-attention-actions">
        <button type="button" className="settings-link-btn" disabled={busy} onClick={() => onStop(entry)}>{t('sync.attn.stop')}</button>
      </div>}
    </div>
  </div>
}
