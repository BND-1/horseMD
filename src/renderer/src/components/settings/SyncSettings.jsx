import { useEffect, useRef, useState } from 'react'
import { baseName } from '../../paths.js'
import { Icon } from '../icons.jsx'
import { SYNC_AUTO_MINUTES } from '../../settings.js'
import Toggle from '../ui/Toggle.jsx'
import { autoSyncText, isMassDelete, keyOf as syncKey } from '../../hooks/useAutoSync.js'
import SyncConnections from './SyncConnections.jsx'

const pathKey = (path) => String(path || '').replace(/[\\/]+$/, '').toLowerCase()

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

function SyncPlanPreview({ preview, onConfirm, onClose, busy = false, t }) {
  // Empty folders (S3 "path/" markers) count like files: creating one in the
  // cloud is an upload, creating it here a download.
  const labelFor = (operation) => {
    if (operation.type === 'upload' || operation.type === 'createRemoteDir') return t('sync.operationUpload')
    if (operation.type === 'download' || operation.type === 'createLocalDir') return t('sync.operationDownload')
    if (operation.type === 'conflict') return t('sync.operationConflict')
    return t('sync.operationDelete')
  }
  const isFolder = (operation) => /Dir$/.test(operation.type)
  // System files (.DS_Store…) removed from the cloud are housekeeping, not a
  // change to the user's files: not listed (and not counted as deletions).
  const changes = preview.data.operations.filter((operation) => !operation.systemFile && !['keep', 'keepDir', 'forgetDir'].includes(operation.type))
  return (
    <section className="sync-plan-preview" aria-label={t('sync.previewTitle')}>
      <div className="sync-plan-preview-head">
        <div>
          <div className="sync-plan-preview-title">{t('sync.previewTitle')}</div>
          <p>{t('sync.previewCounts', preview.data.summary)}</p>
        </div>
        <IconAction icon="close" label={t('sync.cancel')} onClick={onClose} />
      </div>
      <p className="sync-plan-preview-note">{preview.massDelete
        ? t('sync.massDeleteNotice', { n: preview.data.summary.delete })
        : preview.requiresConfirmation ? t('sync.riskNotice') : t('sync.previewNotice')}</p>
      {changes.length > 0 && <div className="sync-preview-changes">
        <div className="sync-preview-changes-title">{t('sync.previewChanges')}</div>
        <ul>
          {changes.map((operation) => <li key={`${operation.type}:${operation.path}`}>
            <span>{labelFor(operation)}</span>
            <code title={operation.path}>{isFolder(operation) ? `${operation.path}/` : operation.path}</code>
          </li>)}
        </ul>
      </div>}
      {preview.requiresConfirmation && <div className="sync-preview-actions">
        <button className="settings-action-btn" type="button" disabled={busy} onClick={onConfirm}>{busy ? t('sync.syncing') : t(`sync.confirm.${preview.strategy}`)}</button>
        <button className="settings-link-btn" type="button" onClick={onClose}>{t('sync.cancel')}</button>
      </div>}
    </section>
  )
}

// What the cloud lost, in numbers: files here, files the cloud still lists.
function remoteResetText(counts, t) {
  if (!counts) return t('sync.attn.loading')
  const remote = counts.remote > 0 ? t('sync.attn.remoteSome', { n: counts.remote }) : t('sync.attn.remoteEmpty')
  return t('sync.attn.resetBody', { local: counts.local, remote })
}

function RemoteResetDialog({ recovery, onPush, onPull, onStop, onCancel, t }) {
  const counts = recovery.data?.counts || null
  return <div className="sync-preview" role="dialog" aria-modal="true" aria-label={t('sync.remoteResetTitle')}>
    <div className="sync-preview-card">
      <h2>{t('sync.remoteResetTitle')}</h2>
      <p>{remoteResetText(counts, t)}</p>
      <p>{t('sync.remoteResetSafety')}</p>
      <div className="sync-preview-actions">
        <button className="settings-action-btn" type="button" onClick={() => onPush(recovery.entry)}>{t('sync.attn.reupload')}</button>
        {counts?.remote > 0 && <button className="settings-link-btn" type="button" onClick={() => onPull(recovery.entry)}>{t('sync.attn.download')}</button>}
        <button className="settings-link-btn" type="button" onClick={() => onStop(recovery.entry)}>{t('sync.attn.stop')}</button>
        <button className="settings-link-btn" type="button" onClick={onCancel}>{t('sync.cancel')}</button>
      </div>
    </div>
  </div>
}

// A folder whose automatic sync stopped to ask (mass deletion, or the cloud
// copy is gone / replaced): what happened and the choices, right under the
// folder (Dropbox / OneDrive show sync issues with their fixes in place —
// a one-line status with the choices behind an icon told the user nothing).
// The first one scrolls into view, so the status bar's 需要确认 lands here.
function SyncAttention({ entry, status, busy, onPreview, onReview, onPush, onPull, onStop, t }) {
  const ref = useRef(null)
  const reset = status.reason !== 'mass-delete'
  const [counts, setCounts] = useState(null)
  useEffect(() => {
    if (!reset) return undefined
    let alive = true
    Promise.resolve(onPreview?.(entry.rootPath, 'merge'))
      .then((data) => { if (alive) setCounts(data?.counts || { local: 0, remote: 0 }) })
      .catch(() => { if (alive) setCounts(null) })
    return () => { alive = false }
  }, [reset, entry.rootPath, status.at])
  useEffect(() => {
    if (document.querySelector('.sync-attention') === ref.current) ref.current?.scrollIntoView({ block: 'center' })
  }, [])
  const time = new Date(status.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return <div ref={ref} className="sync-attention" role="alert">
    <Icon name="info" size={16} className="sync-attention-icon" />
    <div className="sync-attention-copy">
      <strong>{reset ? t('sync.attn.resetTitle') : t('sync.attn.massTitle', { n: status.summary?.delete || 0 })}</strong>
      <p>{reset ? remoteResetText(counts, t) : t('sync.attn.massBody')}</p>
      <small>{t('sync.attn.paused', { time })}</small>
      <div className="sync-attention-actions">
        {reset ? <>
          <button type="button" className="settings-action-btn primary" disabled={busy} onClick={() => onPush(entry)}>{t('sync.attn.reupload')}</button>
          {counts?.remote > 0 && <button type="button" className="settings-action-btn" disabled={busy} onClick={() => onPull(entry)}>{t('sync.attn.download')}</button>}
        </> : <button type="button" className="settings-action-btn primary" disabled={busy} onClick={() => onReview(entry)}>{t('sync.attn.review')}</button>}
        <button type="button" className="settings-link-btn" disabled={busy} onClick={() => onStop(entry)}>{t('sync.attn.stop')}</button>
      </div>
    </div>
  </div>
}

// Last sync result of one folder (hooks/useAutoSync.js).
function AutoSyncLine({ status, t }) {
  const text = autoSyncText(status, t)
  if (!text) return null
  const warn = status.kind === 'confirm' || status.kind === 'error'
  return <div className={`sync-auto-line${warn ? ' warn' : ''}`}>{text}</div>
}

// Automatic sync (无感同步): the switch, then the fallback check interval.
function AutoSyncSettings({ on, minutes, folderCount, nextAt, onToggle, onChange, t }) {
  const next = nextAt ? new Date(nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  let state = t('sync.auto.stateOff')
  if (on) state = folderCount ? t('sync.auto.stateOn', { n: minutes, count: folderCount, time: next }) : t('sync.auto.stateNoFolder', { n: minutes })
  return <section className="settings-block sync-auto">
    <div className="settings-heading-row">
      <div>
        <h2 className="settings-block-title">{t('sync.auto.label')}</h2>
        <p className="settings-block-desc">{t('sync.auto.desc')}</p>
      </div>
      <Toggle checked={on} onChange={onToggle} label={t('sync.auto.label')} />
    </div>
    <div className={`sync-auto-card${on ? '' : ' off'}`}>
      <div className="settings-row sync-auto-row">
        <div className="settings-row-text">
          <div className="settings-row-label">{t('sync.auto.interval')}</div>
          <div className={`settings-row-desc sync-auto-state${on ? ' on' : ''}`}>{state}</div>
        </div>
        <div className="settings-segmented" role="radiogroup" aria-label={t('sync.auto.interval')}>
          {SYNC_AUTO_MINUTES.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={minutes === value}
              disabled={!on}
              className={`settings-segmented-option${minutes === value ? ' active' : ''}`}
              onClick={() => onChange(value)}
            >
              {t('sync.auto.minutes', { n: value })}
            </button>
          ))}
        </div>
      </div>
    </div>
  </section>
}

// Running sync: file count, or the long wait while the service throttles,
// with pause / continue / stop.
function SyncProgressLine({ progress, onControl, t }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!progress.waiting) return undefined
    const timer = setInterval(() => setNow(Date.now()), 10000)
    return () => clearInterval(timer)
  }, [progress.waiting])
  const done = progress.completed || 0
  const total = progress.total || 0
  let text = ''
  if (progress.stopping) text = t('sync.stopping', { done, total })
  else if (progress.paused) text = t(progress.holding ? 'sync.paused' : 'sync.pausing', { done, total })
  else if (progress.waiting) {
    const minutes = Math.max(1, Math.ceil((progress.waiting.resumeAt - now) / 60000))
    const waited = Math.max(0, Math.round((progress.waiting.waitedMs + Math.max(0, now - (progress.waiting.receivedAt || now))) / 60000))
    text = t('sync.throttled', { done, total, minutes, waited })
  } else if (total) text = t('sync.progress', { done, total })
  else text = t('sync.syncing')
  const state = progress.stopping ? 'stopping' : progress.paused ? 'paused' : progress.waiting ? 'waiting' : ''
  return <div className={`sync-progress-line ${state}`.trim()}>
    <span role="status">{text}</span>
    {!progress.stopping && onControl && <span className="sync-progress-actions">
      <button type="button" className="settings-link-btn sync-pause-btn" onClick={() => onControl(progress.paused ? 'resume' : 'pause')}>
        {progress.paused ? t('sync.resume') : t('sync.pause')}
      </button>
      <button type="button" className="settings-link-btn sync-stop-btn" onClick={() => onControl('stop')}>{t('sync.stop')}</button>
    </span>}
  </div>
}

export default function SyncSettings({
  folderRoots = [],
  registered = [],
  connections = [],
  loading,
  busyRoot,
  progress = null,
  onControlSync,
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
  autoSync = null,
  settings = {},
  onUpdateSettings,
  t
}) {
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState(null)
  const [recovery, setRecovery] = useState(null)
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
      // Electron prefixes main-process errors with the IPC channel name.
      setError(String(cause?.message || cause).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''))
      return null
    }
  }

  // Errors go back to the form (shown in place, next to the fields).
  const submitConnection = async (type, form, connectionId = null) => {
    setError('')
    setNotice('')
    const connection = await (connectionId
      ? onUpdateConnection(connectionId, form)
      : type === 'webdav'
        ? onAddWebDavConnection(form)
        : onAddS3Connection(form))
    if (!connection) return false
    setNotice(t(connectionId ? 'sync.connectionUpdated' : 'sync.connectionAdded', { name: connection.name }))
    if (connection.uploadThrottled) setNotice(t('sync.connectionSavedThrottled'))
    return true
  }

  const testConnection = async (connectionId) => {
    const result = await safely(() => onTestConnection(connectionId))
    if (result) setNotice(t(result.uploadThrottled ? 'sync.connectionTestThrottled' : 'sync.connectionTestPassed'))
  }

  const prepareSync = async (entry, strategy = 'merge', { previewOnly = false } = {}) => {
    const data = await safely(() => onPreview(entry.rootPath, strategy))
    if (!data) return
    if (data.status === 'remote-reset') {
      setRecovery({ entry, data })
      return
    }
    // 双向同步 runs at once (conflicts are merged or kept as copies, deletions
    // are recoverable); only a mass deletion — or a directional sync — asks.
    const massDelete = strategy === 'merge' && isMassDelete(data.summary)
    const requiresConfirmation = strategy !== 'merge' || massDelete
    if (previewOnly || requiresConfirmation) {
      setPreview({ entry, data, strategy, requiresConfirmation, massDelete })
      return
    }
    const done = await safely(() => onRun(entry.rootPath, strategy))
    finishRun(entry, done)
  }

  const finishRun = (entry, done) => {
    if (!done) return false
    if (done.stopped) {
      setNotice(t('sync.stoppedNotice', { done: done.completed, total: done.total }))
      return true
    }
    if (done.needsConfirmation) {
      // Changed since the preview: show the fresh plan instead.
      prepareSync(entry, 'merge', { previewOnly: true })
      return true
    }
    markSyncComplete(entry.rootPath)
    autoSync?.recordResult?.(entry.rootPath, done)
    setNotice([
      t('sync.syncCompleted', done.summary || {}),
      done.merged ? t('sync.auto.mergedToast', { n: done.merged }) + t('sync.sentenceEnd') : '',
      done.conflicts ? t('sync.auto.conflictToast', { n: done.conflicts }) + t('sync.sentenceEnd') : '',
      done.deferred?.length ? t('sync.deferredNotice', { n: done.deferred.length }) : ''
    ].filter(Boolean).join(' '))
    return true
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
    const { entry, strategy } = preview
    const done = await safely(() => onRun(entry.rootPath, strategy))
    if (done) setPreview(null)
    finishRun(entry, done)
  }

  return <>
    <SyncConnections
      connections={connections}
      onSubmit={submitConnection}
      onTest={testConnection}
      onRemove={(id) => safely(() => onRemoveConnection(id))}
      notice={notice}
      error={error}
      t={t}
    />

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
          // A folder waiting for the user shows no ✓ (its box says why).
          const waiting = autoSync?.byFolder?.[syncKey(entry.rootPath)]?.kind === 'confirm'
          const state = busy ? 'syncing' : waiting ? null : syncStates[pathKey(entry.rootPath)]
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
            {!busy && entry.connectionId && autoSync?.byFolder?.[syncKey(entry.rootPath)] && (autoSync.byFolder[syncKey(entry.rootPath)].kind === 'confirm'
              ? <SyncAttention
                  entry={entry}
                  status={autoSync.byFolder[syncKey(entry.rootPath)]}
                  busy={!!busyRoot}
                  onPreview={onPreview}
                  onReview={(item) => prepareSync(item)}
                  onPush={(item) => prepareSync(item, 'push')}
                  onPull={(item) => prepareSync(item, 'pull')}
                  onStop={(item) => safely(() => onRemoveFolder(item.rootPath))}
                  t={t}
                />
              : <AutoSyncLine status={autoSync.byFolder[syncKey(entry.rootPath)]} t={t} />)}
            {busy && <SyncProgressLine
              progress={progress?.rootPath === entry.rootPath ? progress : { rootPath: entry.rootPath, completed: 0, total: 0 }}
              onControl={onControlSync ? (action) => onControlSync(entry.rootPath, action) : null}
              t={t}
            />}
            {activePreview && <SyncPlanPreview preview={activePreview} busy={busy} onConfirm={confirmRun} onClose={() => setPreview(null)} t={t} />}
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

    {onUpdateSettings && <AutoSyncSettings
      on={settings.syncAuto !== false}
      minutes={settings.syncAutoMinutes || SYNC_AUTO_MINUTES[0]}
      folderCount={registered.filter((entry) => entry.connectionId).length}
      nextAt={autoSync?.nextAt}
      onToggle={(syncAuto) => onUpdateSettings({ syncAuto })}
      onChange={(syncAutoMinutes) => onUpdateSettings({ syncAutoMinutes })}
      t={t}
    />}

    {recovery && <RemoteResetDialog
      recovery={recovery}
      onPush={(entry) => { setRecovery(null); prepareSync(entry, 'push') }}
      onPull={(entry) => { setRecovery(null); prepareSync(entry, 'pull') }}
      onStop={(entry) => { setRecovery(null); safely(() => onRemoveFolder(entry.rootPath)) }}
      onCancel={() => setRecovery(null)}
      t={t}
    />}
  </>
}
