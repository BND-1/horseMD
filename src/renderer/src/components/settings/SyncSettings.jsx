import { useState } from 'react'
import { baseName } from '../../paths.js'
import { Icon } from '../icons.jsx'

const pathKey = (path) => String(path || '').replace(/[\\/]+$/, '').toLowerCase()

const emptyConnection = {
  name: '', endpoint: '', username: '', password: '', bucket: '', region: '', accessKeyId: '', secretAccessKey: '', userAgent: ''
}

function ConnectionField({ id, label, ...inputProps }) {
  return <label className="sync-field" htmlFor={id}>
    <span className="sync-field-label">{label}</span>
    <input id={id} {...inputProps} />
  </label>
}

function ConnectionForm({ connection = null, type: requestedType = 'webdav', onSubmit, onCancel, t }) {
  const type = connection?.type || requestedType
  const editing = Boolean(connection?.id)
  const [form, setForm] = useState({
    ...emptyConnection,
    ...(connection || {}),
    // Credentials are intentionally never returned from the main process.
    // An empty value during editing means "keep the secure value already saved".
    password: '',
    secretAccessKey: ''
  })

  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const submit = async (event) => {
    event.preventDefault()
    await onSubmit(type, form, connection?.id)
    if (!editing) setForm({ ...emptyConnection })
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
      onChange={update('name')}
    />
    <ConnectionField
      id={fieldId('endpoint')}
      required
      label={t(type === 'webdav' ? 'sync.endpoint' : 'sync.s3Endpoint')}
      placeholder={t(type === 'webdav' ? 'sync.webdavEndpointExample' : 'sync.s3EndpointExample')}
      value={form.endpoint}
      onChange={update('endpoint')}
    />
    <ConnectionField
      id={fieldId('user-agent')}
      label={t('sync.userAgent')}
      placeholder={t('sync.userAgentExample')}
      value={form.userAgent}
      onChange={update('userAgent')}
    />
    <p className="sync-field-help">{t('sync.userAgentHelp')}</p>
    {type === 'webdav' ? <>
      <ConnectionField
        id={fieldId('username')}
        label={t('sync.username')}
        placeholder={t('sync.webdavUsernameExample')}
        value={form.username}
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
        onChange={update('password')}
      />
    </> : <>
      <ConnectionField
        id={fieldId('bucket')}
        required
        label={t('sync.s3Bucket')}
        placeholder={t('sync.s3BucketExample')}
        value={form.bucket}
        onChange={update('bucket')}
      />
      <ConnectionField
        id={fieldId('region')}
        required
        label={t('sync.s3Region')}
        placeholder={t('sync.s3RegionExample')}
        value={form.region}
        onChange={update('region')}
      />
      <ConnectionField
        id={fieldId('access-key')}
        required
        label={t('sync.s3AccessKey')}
        placeholder={t('sync.s3AccessKeyExample')}
        value={form.accessKeyId}
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
        onChange={update('secretAccessKey')}
      />
    </>}
      <div className="sync-form-actions">
        <button className="settings-action-btn" type="submit">{editing ? t('sync.testAndUpdate') : t('sync.testAndSave')}</button>
        {editing && <button className="settings-link-btn" type="button" onClick={onCancel}>{t('sync.cancel')}</button>}
      </div>
  </form>
}

function ConnectionPicker({ connections, value, onChange, t }) {
  return (
    <select className="sync-select" value={value || ''} onChange={(event) => onChange(event.target.value)}>
      <option value="">{t('sync.chooseConnection')}</option>
      {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
    </select>
  )
}

function IconAction({ icon, label, className = '', ...props }) {
  return <button
    type="button"
    className={`sync-icon-btn ${className}`.trim()}
    title={label}
    aria-label={label}
    {...props}
  >
    <Icon name={icon} size={16} />
  </button>
}

function SyncPlanPreview({ preview, onConfirm, onClose, t }) {
  const labelFor = (operation) => {
    if (operation.type === 'upload') return t('sync.operationUpload')
    if (operation.type === 'download') return t('sync.operationDownload')
    if (operation.type === 'conflict') return t('sync.operationConflict')
    return t('sync.operationDelete')
  }
  const changes = preview.data.operations.filter((operation) => operation.type !== 'keep')
  return (
    <section className="sync-plan-preview" aria-label={t('sync.previewTitle')}>
      <div className="sync-plan-preview-head">
        <div>
          <div className="sync-plan-preview-title">{t('sync.previewTitle')}</div>
          <p>{t('sync.previewCounts', preview.data.summary)}</p>
        </div>
        <IconAction icon="close" label={t('sync.cancel')} onClick={onClose} />
      </div>
      <p className="sync-plan-preview-note">{preview.requiresConfirmation ? t('sync.riskNotice') : t('sync.previewNotice')}</p>
      {changes.length > 0 && <div className="sync-preview-changes">
        <div className="sync-preview-changes-title">{t('sync.previewChanges')}</div>
        <ul>
          {changes.map((operation) => <li key={`${operation.type}:${operation.path}`}>
            <span>{labelFor(operation)}</span>
            <code title={operation.path}>{operation.path}</code>
          </li>)}
        </ul>
      </div>}
      {preview.requiresConfirmation && <div className="sync-preview-actions">
        <button className="settings-action-btn" type="button" onClick={onConfirm}>{t(`sync.confirm.${preview.strategy}`)}</button>
        <button className="settings-link-btn" type="button" onClick={onClose}>{t('sync.cancel')}</button>
      </div>}
    </section>
  )
}

function RemoteResetDialog({ recovery, onPush, onPull, onCancel, t }) {
  return <div className="sync-preview" role="dialog" aria-modal="true" aria-label={t('sync.remoteResetTitle')}>
    <div className="sync-preview-card">
      <h2>{t('sync.remoteResetTitle')}</h2>
      <p>{t('sync.remoteResetDesc')}</p>
      <p>{t('sync.remoteResetSafety')}</p>
      <div className="sync-preview-actions">
        <button className="settings-action-btn" type="button" onClick={() => onPush(recovery.entry)}>{t('sync.pushLocal')}</button>
        <button className="settings-link-btn" type="button" onClick={() => onPull(recovery.entry)}>{t('sync.pullRemote')}</button>
        <button className="settings-link-btn" type="button" onClick={onCancel}>{t('sync.cancel')}</button>
      </div>
    </div>
  </div>
}

export default function SyncSettings({
  folderRoots = [],
  registered = [],
  connections = [],
  loading,
  busyRoot,
  onEnableFolder,
  onAddSyncFolder,
  onRemoveFolder,
  onAddWebDavConnection,
  onAddS3Connection,
  onUpdateConnection,
  onRemoveConnection,
  onTestConnection,
  onBindConnection,
  onPreview,
  onRun,
  onListRemoteWorkspaces,
  onJoinWorkspace,
  t
}) {
  const [openForms, setOpenForms] = useState({ webdav: false, s3: false })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState(null)
  const [recovery, setRecovery] = useState(null)
  const [editingConnection, setEditingConnection] = useState(null)
  const [selectedConnections, setSelectedConnections] = useState({})
  const [remoteChoices, setRemoteChoices] = useState({})
  const [syncStates, setSyncStates] = useState({})
  const byPath = new Map(registered.map((entry) => [pathKey(entry.rootPath), entry]))
  const localOnly = folderRoots.filter((path) => !byPath.has(pathKey(path)))
  const connectionName = (id) => connections.find((item) => item.id === id)?.name || ''
  const connectionFor = (entry) => selectedConnections[pathKey(entry.rootPath)] || ''
  const setConnectionFor = (entry, connectionId) => {
    setSelectedConnections((current) => ({ ...current, [pathKey(entry.rootPath)]: connectionId }))
    setRemoteChoices((current) => ({ ...current, [pathKey(entry.rootPath)]: null }))
  }
  const markSyncComplete = (rootPath) => setSyncStates((current) => ({ ...current, [pathKey(rootPath)]: 'complete' }))

  const safely = async (action) => {
    setError('')
    setNotice('')
    try {
      return await action()
    } catch (cause) {
      setError(cause?.message || String(cause))
      return null
    }
  }

  const submitConnection = async (type, form, connectionId = null) => {
    const connection = await safely(() => connectionId
      ? onUpdateConnection(connectionId, form)
      : type === 'webdav'
        ? onAddWebDavConnection(form)
        : onAddS3Connection(form))
    if (!connection) return
    if (connectionId) {
      setEditingConnection(null)
      setNotice(t('sync.connectionUpdated'))
    } else {
      setOpenForms((current) => ({ ...current, [type]: false }))
    }
  }

  const testConnection = async (connectionId) => {
    const result = await safely(() => onTestConnection(connectionId))
    if (result) setNotice(t('sync.connectionTestPassed'))
  }

  const prepareSync = async (entry, strategy = 'merge', { previewOnly = false } = {}) => {
    const data = await safely(() => onPreview(entry.rootPath, strategy))
    if (!data) return
    if (data.status === 'remote-reset') {
      setRecovery({ entry, data })
      return
    }
    const requiresConfirmation = strategy !== 'merge' || data.summary.conflict > 0 || data.summary.delete > 0
    if (previewOnly || requiresConfirmation) {
      setPreview({ entry, data, strategy, requiresConfirmation })
      return
    }
    const done = await safely(() => onRun(entry.rootPath, strategy))
    if (done) {
      markSyncComplete(entry.rootPath)
      setNotice(t('sync.syncCompleted', done.summary))
    }
  }

  const showPreview = (entry) => prepareSync(entry, 'merge', { previewOnly: true })

  const startNewRemote = async (entry) => {
    const connectionId = connectionFor(entry)
    if (!connectionId) {
      setError(t('sync.chooseConnectionFirst'))
      return
    }
    const bound = await safely(() => onBindConnection(entry.rootPath, connectionId))
    if (bound) await prepareSync(bound, 'push')
  }

  const continueWithConnection = async (entry) => {
    const connectionId = connectionFor(entry)
    if (!connectionId) {
      setError(t('sync.chooseConnectionFirst'))
      return
    }
    const remote = await safely(() => onListRemoteWorkspaces(connectionId))
    if (!remote) return
    if (remote.length === 0) {
      await startNewRemote(entry)
      return
    }
    setRemoteChoices((current) => ({ ...current, [pathKey(entry.rootPath)]: remote }))
  }

  const joinRemote = async (entry, workspaceId) => {
    const connectionId = connectionFor(entry)
    const joined = await safely(() => onJoinWorkspace(entry.rootPath, connectionId, workspaceId))
    if (joined) await prepareSync(joined, 'pull')
  }

  const confirmRun = async () => {
    const done = await safely(() => onRun(preview.entry.rootPath, preview.strategy))
    if (done) {
      setPreview(null)
      markSyncComplete(preview.entry.rootPath)
      setNotice(t('sync.syncCompleted', done.summary))
    }
  }

  return <>
    <section className="settings-block">
      <div className="settings-heading-row">
        <div>
          <h2 className="settings-block-title">{t('sync.connections')}</h2>
          <p className="settings-block-desc">{t('sync.connectionsDesc')}</p>
        </div>
      </div>
      <div className="sync-add-options">
        <button
          type="button"
          className="sync-connection-option"
          aria-expanded={openForms.webdav}
          onClick={() => setOpenForms((current) => ({ ...current, webdav: !current.webdav }))}
        >
          <Icon name="cloud" size={17} />
          <span><strong>WebDAV</strong><small>{t('sync.webdavOptionDesc')}</small></span>
          <Icon name={openForms.webdav ? 'chevron-down' : 'plus'} size={15} />
        </button>
        <button
          type="button"
          className="sync-connection-option"
          aria-expanded={openForms.s3}
          onClick={() => setOpenForms((current) => ({ ...current, s3: !current.s3 }))}
        >
          <Icon name="cloud" size={17} />
          <span><strong>S3 {t('sync.s3Compatible')}</strong><small>{t('sync.s3OptionDesc')}</small></span>
          <Icon name={openForms.s3 ? 'chevron-down' : 'plus'} size={15} />
        </button>
      </div>
      {notice && <div className="sync-notice">{notice}</div>}
      {error && <div className="sync-error">{error}</div>}
      {openForms.webdav && <ConnectionForm type="webdav" onSubmit={submitConnection} t={t} />}
      {openForms.s3 && <ConnectionForm type="s3" onSubmit={submitConnection} t={t} />}
      {connections.length === 0 && <div className="sync-empty">{t('sync.noConnections')}</div>}
      {connections.map((connection) => <div key={connection.id}>
        <div className="sync-folder-row">
          <Icon name="cloud" size={17} className="sync-folder-icon" />
          <div className="sync-folder-copy">
            <div className="sync-folder-name">{connection.name}</div>
            <div className="sync-folder-path">{connection.endpoint}</div>
          </div>
          <span className="sync-folder-status">{connection.type === 's3' ? 'S3' : 'WebDAV'}</span>
          <div className="sync-icon-actions">
            <IconAction icon="pencil" label={t('sync.editConnection')} onClick={() => setEditingConnection(connection)} />
            <IconAction icon="refresh" label={t('sync.testConnection')} onClick={() => testConnection(connection.id)} />
            <IconAction icon="trash" label={t('sync.removeConnection')} onClick={() => safely(() => onRemoveConnection(connection.id))} />
          </div>
        </div>
        {editingConnection?.id === connection.id && <ConnectionForm
          connection={connection}
          onSubmit={submitConnection}
          onCancel={() => setEditingConnection(null)}
          t={t}
        />}
      </div>)}
    </section>

    <section className="settings-block">
      <div className="settings-heading-row">
        <div>
          <h2 className="settings-block-title">{t('sync.folders')}</h2>
          <p className="settings-block-desc">{t('sync.foldersDesc')}</p>
        </div>
        <button type="button" className="settings-action-btn" onClick={onAddSyncFolder}>
          <Icon name="folder-plus" size={15} />
          {t('sync.addFolder')}
        </button>
      </div>
      <div className="sync-tip">
        <Icon name="info" size={15} />
        <span>{t('sync.localFolderTip')}</span>
      </div>
      {loading && <div className="sync-empty">{t('sync.loading')}</div>}
      {!loading && <div className="sync-folder-list">
        {registered.map((entry) => {
          const selectedConnection = connectionFor(entry)
          const remote = remoteChoices[pathKey(entry.rootPath)]
          const busy = busyRoot === entry.rootPath
          const state = busy ? 'syncing' : syncStates[pathKey(entry.rootPath)]
          const activePreview = preview?.entry.rootPath === entry.rootPath ? preview : null
          return <div className="sync-workspace-item" key={entry.rootPath}>
            <div className="sync-folder-row">
              <Icon name="folder-open" size={17} className="sync-folder-icon" />
              <div className="sync-folder-copy">
                <div className="sync-folder-name">{entry.name || baseName(entry.rootPath)}</div>
                <div className="sync-folder-path">{entry.rootPath}</div>
                {entry.connectionId ? <div className="sync-folder-status">{connectionName(entry.connectionId)}</div> : <>
                  <div className="sync-folder-status muted">{t('sync.readyToConnect')}</div>
                  <ConnectionPicker
                    connections={connections}
                    value={selectedConnection}
                    onChange={(connectionId) => setConnectionFor(entry, connectionId)}
                    t={t}
                  />
                  <div className="sync-folder-actions">
                    <button type="button" className="settings-link-btn" disabled={busy} onClick={() => continueWithConnection(entry)}>{t('sync.continueConnection')}</button>
                  </div>
                  {Array.isArray(remote) && <div className="sync-remote-list">
                    <span className="sync-folder-status muted">{t('sync.remoteWorkspacesFound', { count: remote.length })}</span>
                    {remote.map((workspace) => <button
                      key={workspace.workspaceId}
                      type="button"
                      className="sync-remote-choice"
                      disabled={busy}
                      onClick={() => joinRemote(entry, workspace.workspaceId)}
                    >
                      {t('sync.joinRemoteItem', { count: workspace.fileCount })}
                    </button>)}
                    <button
                      type="button"
                      className="settings-link-btn"
                      disabled={busy}
                      onClick={() => startNewRemote(entry)}
                    >
                      {t('sync.createSeparateRemote')}
                    </button>
                  </div>}
                </>}
              </div>
              {entry.connectionId && <div className="sync-icon-actions">
                <IconAction icon="refresh" label={t('sync.syncNow')} disabled={busy} onClick={() => prepareSync(entry)} />
                <IconAction icon="upload" label={t('sync.pushLocal')} disabled={busy} onClick={() => prepareSync(entry, 'push')} />
                <IconAction icon="download" label={t('sync.pullRemote')} disabled={busy} onClick={() => prepareSync(entry, 'pull')} />
                <IconAction icon="list" label={t('sync.viewPreview')} disabled={busy} onClick={() => showPreview(entry)} />
              </div>}
              {state && <span className={`sync-state-icon ${state}`} title={state === 'syncing' ? t('sync.syncing') : t('sync.syncCompletedIcon')}>
                <Icon name={state === 'syncing' ? 'refresh' : 'check'} size={15} />
              </span>}
              <IconAction icon="trash" label={t('sync.stopManaging')} onClick={() => safely(() => onRemoveFolder(entry.rootPath))} />
            </div>
            {activePreview && <SyncPlanPreview preview={activePreview} onConfirm={confirmRun} onClose={() => setPreview(null)} t={t} />}
          </div>
        })}
        {localOnly.map((rootPath) => <div className="sync-folder-row" key={rootPath}>
          <Icon name="folder" size={17} className="sync-folder-icon muted" />
          <div className="sync-folder-copy">
            <div className="sync-folder-name">{baseName(rootPath)}</div>
            <div className="sync-folder-path">{rootPath}</div>
            <div className="sync-folder-status muted">{t('sync.localOnly')}</div>
          </div>
          <button type="button" className="settings-link-btn" onClick={() => safely(() => onEnableFolder(rootPath))}>{t('sync.enable')}</button>
        </div>)}
      </div>}
    </section>

    {recovery && <RemoteResetDialog
      recovery={recovery}
      onPush={(entry) => { setRecovery(null); prepareSync(entry, 'push') }}
      onPull={(entry) => { setRecovery(null); prepareSync(entry, 'pull') }}
      onCancel={() => setRecovery(null)}
      t={t}
    />}
  </>
}
