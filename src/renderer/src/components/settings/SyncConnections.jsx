// 云同步 › 云端连接: pick a service (坚果云, 数据胶囊, 七牛云, Cloudflare R2,
// Nextcloud, or any WebDAV / S3), see what to prepare, fill only what that
// service needs. The catalog is lib/sync-providers.js; the full forms
// (ConnectionForm) stay for 其他 WebDAV / S3 and for a saved connection that a
// service form cannot show (it is never rewritten silently).
import { useState } from 'react'
import { Icon } from '../icons.jsx'
import {
  QINIU_REGIONS,
  SYNC_PROVIDERS,
  buildProviderConnection,
  providerFormValues,
  providerOfConnection
} from '../../lib/sync-providers.js'
import { ConnectionField, ConnectionForm } from './SyncConnectionForm.jsx'
import jianguoyunLogo from '../../assets/providers/jianguoyun.png'
import cstcloudLogo from '../../assets/providers/cstcloud.png'
import qiniuLogo from '../../assets/providers/qiniu.svg'
import cloudflareLogo from '../../assets/providers/cloudflare.svg'
import nextcloudLogo from '../../assets/providers/nextcloud.svg'

const SECRET_FIELDS = new Set(['password', 'secretAccessKey'])

// Each service's own logo (assets/providers, sources in its README) on a
// white tile in both themes, as app icons are shown; generic WebDAV / S3 keep
// a plain cloud.
const PROVIDER_LOGOS = { jianguoyun: jianguoyunLogo, cstcloud: cstcloudLogo, qiniu: qiniuLogo, r2: cloudflareLogo, nextcloud: nextcloudLogo }

export function ProviderMark({ provider, size = 'md' }) {
  const logo = provider && !provider.generic ? PROVIDER_LOGOS[provider.id] : null
  if (!logo) {
    return <span className={`sync-provider-mark generic ${size}`} aria-hidden="true"><Icon name={provider?.icon || 'cloud'} size={size === 'sm' ? 15 : 18} /></span>
  }
  return <span className={`sync-provider-mark logo ${size}`} data-logo={provider.id} aria-hidden="true">
    <img src={logo} alt="" draggable="false" />
  </span>
}

// WebDAV / S3: which protocol the service speaks (names, not translated).
function ProtocolBadge({ provider }) {
  if (!provider) return null
  return <span className="sync-protocol-badge">{provider.type === 'webdav' ? 'WebDAV' : 'S3'}</span>
}

const providerName = (provider, t) => t(`syncp.${provider.id}.name`)
// An optional string: '' when the key has no text.
const optional = (t, key) => { const text = t(key); return text === key ? '' : text }

// One line under a connection's name: the service and what identifies it.
function connectionDetail(connection, provider, t) {
  const values = providerFormValues(provider, connection)
  if (!values) return connection.endpoint
  if (provider.id === 'jianguoyun') return values.username
  if (provider.id === 'qiniu') return `${t(`syncp.qiniu.region.${values.qiniuRegion}`)} · ${values.bucket}`
  if (provider.id === 'nextcloud') {
    try { return `${new URL(values.server).host} · ${values.username}` } catch { return values.username }
  }
  return values.bucket || connection.endpoint
}

// A failure the service form can explain: which field, in plain words.
function explainFailure(provider, message, t) {
  const text = String(message || '')
  const fields = new Set()
  let hint = ''
  if (/IncorrectRegion|AuthorizationHeaderMalformed/.test(text) && provider.fields.includes('qiniuRegion')) {
    fields.add('qiniuRegion')
    hint = t('syncp.err.region')
  } else if (/NoSuchBucket|HTTP 404/i.test(text) && provider.fields.includes('bucket')) {
    fields.add('bucket')
    hint = t('syncp.err.bucket')
  } else if (/HTTP 40[13]|InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|认证|鉴权/i.test(text)) {
    if (provider.id === 'cstcloud') {
      fields.add('client')
      fields.add('secretAccessKey')
      hint = t('syncp.err.client')
    } else {
      for (const field of ['password', 'accessKeyId', 'secretAccessKey']) if (provider.fields.includes(field)) fields.add(field)
      hint = t(provider.type === 'webdav' ? 'syncp.err.password' : 'syncp.err.keys')
    }
  } else if (/ENOTFOUND|ECONNREFUSED|超时|timeout|ERR_NAME|ERR_CONNECTION/i.test(text)) {
    for (const field of ['server', 'accountId']) if (provider.fields.includes(field)) fields.add(field)
    hint = t('syncp.err.network')
  } else if (/请填写/.test(text)) {
    hint = text
  }
  return { fields, hint }
}

function ProviderField({ provider, field, value, invalid, editing, onChange, idPrefix, t }) {
  const label = optional(t, `syncp.${provider.id}.field.${field}`) || t(`syncp.field.${field}`)
  const placeholder = editing && SECRET_FIELDS.has(field)
    ? t('sync.keepExistingSecret')
    : optional(t, `syncp.${provider.id}.ph.${field}`) || t(`syncp.ph.${field}`)
  if (field === 'qiniuRegion') {
    return <label className={`sync-field${invalid ? ' sync-field-invalid' : ''}`} htmlFor={`${idPrefix}-${field}`}>
      <span className="sync-field-label">{label}</span>
      <select id={`${idPrefix}-${field}`} className="sync-select" value={value} aria-invalid={invalid || undefined} onChange={(event) => onChange(event.target.value)}>
        {QINIU_REGIONS.map((region) => <option key={region} value={region}>{t(`syncp.qiniu.region.${region}`)}（{region}）</option>)}
      </select>
    </label>
  }
  return <ConnectionField
    id={`${idPrefix}-${field}`}
    label={label}
    placeholder={placeholder}
    type={SECRET_FIELDS.has(field) ? 'password' : 'text'}
    autoComplete={SECRET_FIELDS.has(field) ? 'new-password' : 'off'}
    spellCheck={false}
    required={!(editing && SECRET_FIELDS.has(field)) && field !== 'client'}
    value={value}
    invalid={invalid || undefined}
    onChange={(event) => onChange(event.target.value)}
  />
}

// A service's own form: what to prepare, its fields, test & save.
function ProviderForm({ provider, connection = null, initial = null, onSubmit, onCancel, onFullForm, t }) {
  const editing = Boolean(connection?.id)
  const [values, setValues] = useState(() => ({
    name: connection?.name || providerName(provider, t),
    ...(provider.defaults || {}),
    ...(initial || {}),
    password: '',
    secretAccessKey: ''
  }))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(null)
  const set = (field) => (value) => {
    setValues((current) => ({ ...current, [field]: value }))
    if (failure?.fields.has(field)) setFailure(null)
  }
  const submit = async (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setFailure(null)
    let accepted = false
    let error = null
    try {
      accepted = Boolean(await onSubmit(provider.type, buildProviderConnection(provider, values), connection?.id))
    } catch (cause) {
      error = cause
    } finally {
      setBusy(false)
    }
    if (accepted) return
    const message = String(error?.message || '').replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
    // The service form explains the failure itself; of the generic message
    // only the server's answer is kept (its hints name other services).
    const code = /HTTP \d{3}[^；;）)]*/.exec(message)?.[0]?.trim()
    setFailure({ ...explainFailure(provider, message, t), message: code || message })
  }
  const idPrefix = `syncp-${editing ? connection.id : provider.id}`
  const steps = Array.from({ length: provider.steps || 0 }, (_, index) => t(`syncp.${provider.id}.step${index + 1}`))
  const note = optional(t, `syncp.${provider.id}.note`)
  return <form className="sync-provider-form" onSubmit={submit} data-provider={provider.id}>
    {!editing && steps.length > 0 && <div className="sync-provider-prepare">
      <div className="sync-provider-section-label">{t('syncp.prepare')}</div>
      <ol className="sync-provider-steps">{steps.map((step, index) => <li key={index}><span className="sync-provider-step-no">{index + 1}</span><span>{step}</span></li>)}</ol>
      {provider.link && <button type="button" className="sync-provider-link" onClick={() => window.api?.openExternal?.(provider.link)}>
        {t(`syncp.${provider.id}.link`)}
        <Icon name="external" size={13} />
      </button>}
    </div>}
    <div className="sync-provider-fields">
      <ConnectionField
        id={`${idPrefix}-name`}
        label={t('sync.name')}
        required
        value={values.name}
        onChange={(event) => set('name')(event.target.value)}
      />
      {provider.fields.map((field) => <ProviderField
        key={field}
        provider={provider}
        field={field}
        value={values[field] ?? ''}
        invalid={failure?.fields.has(field)}
        editing={editing}
        idPrefix={idPrefix}
        onChange={set(field)}
        t={t}
      />)}
    </div>
    {failure && <div className="sync-provider-error" role="alert">
      <strong>{failure.hint || t('syncp.err.generic')}</strong>
      {failure.message && failure.message !== failure.hint && <span>{failure.message}</span>}
    </div>}
    {note && <p className="sync-provider-note"><Icon name="info" size={13} />{note}</p>}
    <div className="sync-provider-actions">
      <button className="sync-provider-full" type="button" onClick={() => onFullForm(buildProviderConnection(provider, values))}>{t('syncp.fullForm')}</button>
      <span className="sync-provider-actions-spacer" />
      <button className="settings-action-btn" type="button" data-sync-cancel onClick={onCancel}>{t('sync.cancel')}</button>
      <button className="settings-action-btn primary" type="submit" disabled={busy}>
        {busy ? t('sync.testing') : editing ? t('sync.testAndUpdate') : t('sync.testAndSave')}
      </button>
    </div>
  </form>
}

function ProviderPanel({ provider, onBack, children, t }) {
  return <div className="sync-provider-panel">
    <div className="sync-provider-panel-head">
      {onBack && <button type="button" className="sync-icon-btn" title={t('syncp.back')} aria-label={t('syncp.back')} onClick={onBack}>
        <Icon name="chevron-left" size={17} />
      </button>}
      <ProviderMark provider={provider} />
      <div className="sync-provider-panel-title">
        <strong>{providerName(provider, t)}</strong>
        <small>{t(`syncp.${provider.id}.desc`)}</small>
      </div>
      <ProtocolBadge provider={provider} />
    </div>
    <div className="sync-provider-panel-body">{children}</div>
  </div>
}

function ProviderRow({ provider, onPick, t }) {
  return <button type="button" className={`sync-provider-row${provider.generic ? ' generic' : ''}`} data-provider={provider.id} onClick={() => onPick(provider)}>
    <ProviderMark provider={provider} />
    <span className="sync-provider-row-copy">
      <strong>{providerName(provider, t)}</strong>
      <small>{t(`syncp.${provider.id}.desc`)}</small>
    </span>
    <ProtocolBadge provider={provider} />
    <Icon name="chevron-right" size={15} className="sync-provider-row-arrow" />
  </button>
}

// The services as one list (macOS 互联网账户 / Raycast): each row a mark,
// name, one line about it and its protocol; the full forms below.
function ProviderGallery({ onPick, onClose, t }) {
  const services = SYNC_PROVIDERS.filter((provider) => !provider.generic)
  const generic = SYNC_PROVIDERS.filter((provider) => provider.generic)
  return <div className="sync-provider-gallery" role="group" aria-label={t('syncp.pick')}>
    <div className="sync-provider-gallery-head">
      <div>
        <strong>{t('syncp.pick')}</strong>
        <small>{t('syncp.pickDesc')}</small>
      </div>
      {onClose && <button type="button" className="sync-icon-btn" title={t('sync.cancel')} aria-label={t('sync.cancel')} onClick={onClose}>
        <Icon name="close" size={16} />
      </button>}
    </div>
    <div className="sync-provider-list">
      {services.map((provider) => <ProviderRow key={provider.id} provider={provider} onPick={onPick} t={t} />)}
    </div>
    <div className="sync-provider-group-label">{t('syncp.groupOther')}</div>
    <div className="sync-provider-list">
      {generic.map((provider) => <ProviderRow key={provider.id} provider={provider} onPick={onPick} t={t} />)}
    </div>
  </div>
}

function IconAction({ icon, label, ...props }) {
  return <button type="button" className="sync-icon-btn" title={label} aria-label={label} {...props}>
    <Icon name={icon} size={16} />
  </button>
}

// Editing an existing connection: its service form when the saved settings
// fit it, else the full form (unchanged values, nothing lost).
function ConnectionEditor({ connection, onSubmit, onCancel, t }) {
  const provider = providerOfConnection(connection)
  const initial = providerFormValues(provider, connection)
  const [full, setFull] = useState(null)
  if (full || !initial) {
    return <ConnectionForm connection={full ? { ...connection, ...full, provider: undefined } : connection} onSubmit={onSubmit} onCancel={onCancel} t={t} />
  }
  return <ProviderForm provider={provider} connection={connection} initial={initial} onSubmit={onSubmit} onCancel={onCancel} onFullForm={() => setFull({})} t={t} />
}

export default function SyncConnections({ connections, onSubmit, onTest, onRemove, notice, error, t }) {
  // 'gallery' | provider id | null; with no connection the gallery is open.
  const [adding, setAdding] = useState(null)
  const [fullFrom, setFullFrom] = useState(null)
  const [editing, setEditing] = useState(null)
  const showGallery = adding === 'gallery' || (adding === null && connections.length === 0)
  const picked = adding && adding !== 'gallery' ? SYNC_PROVIDERS.find((item) => item.id === adding) : null
  const closeAdd = () => { setAdding(null); setFullFrom(null) }
  const submit = async (type, config, id) => {
    const ok = await onSubmit(type, config, id)
    if (ok) {
      if (id) setEditing(null)
      else closeAdd()
    }
    return ok
  }
  return <section className="settings-block sync-connections">
    <div className="settings-heading-row">
      <div>
        <h2 className="settings-block-title">{t('sync.connections')}</h2>
        <p className="settings-block-desc">{t('sync.connectionsDesc')}</p>
      </div>
      {!showGallery && !picked && <button type="button" className="settings-action-btn" data-sync-add onClick={() => setAdding('gallery')}>
        <Icon name="plus" size={15} />
        {t('sync.addConnection')}
      </button>}
    </div>
    {notice && <div className="sync-notice">{notice}</div>}
    {error && <div className="sync-error">{error}</div>}
    {showGallery && <ProviderGallery
      onPick={(provider) => { setAdding(provider.id); setFullFrom(null) }}
      onClose={connections.length ? closeAdd : null}
      t={t}
    />}
    {picked && <ProviderPanel provider={fullFrom ? SYNC_PROVIDERS.find((item) => item.id === picked.type) : picked} onBack={() => { setAdding('gallery'); setFullFrom(null) }} t={t}>
      {picked.generic || fullFrom
        ? <ConnectionForm type={picked.type} initial={fullFrom} onSubmit={submit} onCancel={closeAdd} t={t} />
        : <ProviderForm provider={picked} onSubmit={submit} onCancel={closeAdd} onFullForm={(config) => setFullFrom(config)} t={t} />}
    </ProviderPanel>}
    {connections.length > 0 && <div className="sync-connection-list">
      {connections.map((connection) => {
        const provider = providerOfConnection(connection)
        return <div key={connection.id} className={`sync-connection-card${editing === connection.id ? ' editing' : ''}`} data-connection-provider={provider?.id || ''}>
          <div className="sync-connection-card-row">
            <ProviderMark provider={provider} />
            <div className="sync-connection-card-copy">
              <div className="sync-connection-card-name">{connection.name}</div>
              <div className="sync-connection-card-detail">
                {(!provider || providerName(provider, t) !== connection.name) && <>
                  <span className="sync-connection-card-service">{provider ? providerName(provider, t) : connection.type}</span>
                  <span className="sync-connection-card-sep">·</span>
                </>}
                <span className="sync-connection-card-where" title={connection.endpoint}>{connectionDetail(connection, provider, t)}</span>
              </div>
            </div>
            <div className="sync-icon-actions">
              <IconAction icon="pencil" label={t('sync.editConnection')} onClick={() => setEditing(editing === connection.id ? null : connection.id)} />
              <IconAction icon="refresh" label={t('sync.testConnection')} onClick={() => onTest(connection.id)} />
              <IconAction icon="trash" label={t('sync.removeConnection')} onClick={() => onRemove(connection.id)} />
            </div>
          </div>
          {editing === connection.id && <div className="sync-connection-card-edit">
            <ConnectionEditor connection={connection} onSubmit={submit} onCancel={() => setEditing(null)} t={t} />
          </div>}
        </div>
      })}
    </div>}
  </section>
}
