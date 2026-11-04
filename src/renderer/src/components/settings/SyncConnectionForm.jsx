// The full connection forms (any WebDAV / S3-compatible service), also used
// for a saved connection that its service's own form cannot show
// (SyncConnections.jsx).
import { useState } from 'react'

const emptyConnection = {
  name: '', endpoint: '', username: '', password: '', bucket: '', region: '', accessKeyId: '', secretAccessKey: '', userAgent: ''
}

export function ConnectionField({ id, label, invalid, help, ...inputProps }) {
  return <label className={`sync-field${invalid ? ' sync-field-invalid' : ''}`} htmlFor={id}>
    <span className="sync-field-label">{label}</span>
    <input id={id} aria-invalid={invalid || undefined} {...inputProps} />
    {invalid && help && <span className="sync-field-error">{help}</span>}
  </label>
}

// The main-process validation throws plain localized messages. Map each
// message to the form field it describes so a failed submit highlights the
// offending input(s) instead of resetting everything the user typed.
const fieldErrorHints = (type, message) => {
  const text = String(message || '')
  const fields = new Set()
  if (text.includes('连接名称')) fields.add('name')
  if (text.includes('User-Agent')) fields.add('userAgent')
  if (type === 'webdav') {
    if (text.includes('WebDAV 地址')) fields.add('endpoint')
    if (text.includes('密码')) fields.add('password')
  } else {
    if (text.includes('Endpoint')) fields.add('endpoint')
    if (text.includes('Bucket')) fields.add('bucket')
    if (text.includes('Region')) fields.add('region')
    if (text.includes('Access Key') || text.includes('Secret Key')) {
      fields.add('accessKeyId')
      fields.add('secretAccessKey')
    }
  }
  // A provider connection failure (bad endpoint/auth) names no field; the
  // endpoint is where those are most likely wrong, mark it softly.
  if (!fields.size && /连接|地址|认证|鉴权|401|403|超时|timeout|ENOTFOUND|ECONNREFUSED/i.test(text)) {
    fields.add('endpoint')
  }
  return fields
}

export function ConnectionForm({ connection = null, initial = null, type: requestedType = 'webdav', onSubmit, onCancel, t }) {
  const type = connection?.type || requestedType
  const editing = Boolean(connection?.id)
  const [form, setForm] = useState({
    ...emptyConnection,
    ...(connection || initial || {}),
    // Credentials are intentionally never returned from the main process.
    // An empty value during editing means "keep the secure value already saved".
    password: '',
    secretAccessKey: ''
  })
  const [invalidFields, setInvalidFields] = useState(null)
  const [submitError, setSubmitError] = useState('')
  // The test can take several seconds (retries on a throttled service):
  // show it and ignore repeated clicks.
  const [busy, setBusy] = useState(false)

  const update = (key) => (event) => {
    setForm((current) => ({ ...current, [key]: event.target.value }))
    // Editing a field clears its error marker (and the message once every
    // marked field has been touched).
    if (invalidFields?.has(key)) {
      const next = new Set(invalidFields)
      next.delete(key)
      setInvalidFields(next.size ? next : null)
      if (!next.size) setSubmitError('')
    }
  }
  const submit = async (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    // Only clear the form when the connection was actually accepted — a
    // failed submit (bad endpoint, auth rejected) must keep everything the
    // user typed so they can correct one field instead of retyping all.
    let accepted = false
    let failure = null
    try {
      accepted = Boolean(await onSubmit(type, form, connection?.id))
    } catch (cause) {
      failure = cause
    } finally {
      setBusy(false)
    }
    if (accepted) {
      setInvalidFields(null)
      setSubmitError('')
      if (!editing) setForm({ ...emptyConnection })
      return
    }
    const message = String(failure?.message || '').replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
    const fields = fieldErrorHints(type, message)
    setInvalidFields(fields.size ? fields : null)
    setSubmitError(message)
  }
  const fieldId = (name) => `sync-${editing ? connection.id : type}-${name}`
  const credentialExample = (key) => editing ? t('sync.keepExistingSecret') : t(key)

  return <form className="sync-form" onSubmit={submit}>
    <ConnectionField
      id={fieldId('name')}
      required
      label={t('sync.name')}
      placeholder={t(type === 'webdav' ? 'sync.webdavNameExample' : 'sync.s3NameExample')}
      value={form.name}
        invalid={invalidFields?.has('name') || undefined}
        help={invalidFields && [...invalidFields][0] === 'name' ? submitError : undefined}
        onChange={update('name')}
    />
    <ConnectionField
      id={fieldId('endpoint')}
      required
      label={t(type === 'webdav' ? 'sync.endpoint' : 'sync.s3Endpoint')}
      placeholder={t(type === 'webdav' ? 'sync.webdavEndpointExample' : 'sync.s3EndpointExample')}
      value={form.endpoint}
        invalid={invalidFields?.has('endpoint') || undefined}
        help={invalidFields && [...invalidFields][0] === 'endpoint' ? submitError : undefined}
        onChange={update('endpoint')}
    />
    <ConnectionField
      id={fieldId('user-agent')}
      label={t('sync.userAgent')}
      placeholder={t('sync.userAgentExample')}
      value={form.userAgent}
        invalid={invalidFields?.has('userAgent') || undefined}
        help={invalidFields && [...invalidFields][0] === 'userAgent' ? submitError : undefined}
        onChange={update('userAgent')}
    />
    <p className="sync-field-help">{t('sync.userAgentHelp')}</p>
    {type === 'webdav' ? <>
      <ConnectionField
        id={fieldId('username')}
        label={t('sync.username')}
        placeholder={t('sync.webdavUsernameExample')}
        value={form.username}
        invalid={invalidFields?.has('username') || undefined}
        help={invalidFields && [...invalidFields][0] === 'username' ? submitError : undefined}
            onChange={update('username')}
      />
      <ConnectionField
        id={fieldId('password')}
        required={!editing}
        type="password"
        label={t('sync.password')}
        placeholder={credentialExample('sync.webdavPasswordExample')}
        autoComplete="new-password"
        value={form.password}
        invalid={invalidFields?.has('password') || undefined}
        help={invalidFields && [...invalidFields][0] === 'password' ? submitError : undefined}
            onChange={update('password')}
      />
    </> : <>
      <ConnectionField
        id={fieldId('bucket')}
        required
        label={t('sync.s3Bucket')}
        placeholder={t('sync.s3BucketExample')}
        value={form.bucket}
        invalid={invalidFields?.has('bucket') || undefined}
        help={invalidFields && [...invalidFields][0] === 'bucket' ? submitError : undefined}
            onChange={update('bucket')}
      />
      <ConnectionField
        id={fieldId('region')}
        required
        label={t('sync.s3Region')}
        placeholder={t('sync.s3RegionExample')}
        value={form.region}
        invalid={invalidFields?.has('region') || undefined}
        help={invalidFields && [...invalidFields][0] === 'region' ? submitError : undefined}
            onChange={update('region')}
      />
      <ConnectionField
        id={fieldId('access-key')}
        required
        label={t('sync.s3AccessKey')}
        placeholder={t('sync.s3AccessKeyExample')}
        value={form.accessKeyId}
        invalid={invalidFields?.has('accessKeyId') || undefined}
        help={invalidFields && [...invalidFields][0] === 'accessKeyId' ? submitError : undefined}
            onChange={update('accessKeyId')}
      />
      <ConnectionField
        id={fieldId('secret-key')}
        required={!editing}
        type="password"
        label={t('sync.s3SecretKey')}
        placeholder={credentialExample('sync.s3SecretKeyExample')}
        autoComplete="new-password"
        value={form.secretAccessKey}
        invalid={invalidFields?.has('secretAccessKey') || undefined}
        help={invalidFields && [...invalidFields][0] === 'secretAccessKey' ? submitError : undefined}
            onChange={update('secretAccessKey')}
      />
    </>}
      {submitError && !invalidFields && <div className="sync-provider-error sync-form-wide" role="alert"><span>{submitError}</span></div>}
      <div className="sync-form-actions">
        {onCancel && <button className="settings-action-btn" type="button" data-sync-cancel onClick={onCancel}>{t('sync.cancel')}</button>}
        <button className="settings-action-btn primary" type="submit" disabled={busy}>{busy ? t('sync.testing') : editing ? t('sync.testAndUpdate') : t('sync.testAndSave')}</button>
      </div>
  </form>
}
