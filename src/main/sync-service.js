import { isAbsolute, relative } from 'node:path'
import { deviceLabel } from './sync/conflict-name.js'
import { CredentialStore } from './sync/credential-store.js'
import { ConnectionRegistry } from './sync/connections.js'
import { WebDavProvider } from './sync/webdav-provider.js'
import { S3Provider } from './sync/s3-provider.js'
import { SyncEngine } from './sync/sync-engine.js'
import { SyncControl } from './sync/sync-control.js'
import { bindSyncWorkspace, joinSyncWorkspace, readWorkspaceRegistry } from './sync-workspaces.js'

import { RequestPacer } from './sync/request-pacer.js'
import { createSyncRequest } from './sync/sync-request.js'

// UI tests shorten the throttling waits (minutes in production) to seconds.
const testPacerOptions = () => {
  try { return JSON.parse(process.env.HORSEMD_TEST_SYNC_PACER || 'null') } catch { return null }
}
const newPacer = () => {
  const options = testPacerOptions()
  return options ? new RequestPacer(options) : new RequestPacer()
}

// Absolute paths of files open with unsaved edits → paths relative to the
// sync root (others dropped).
export function busyRelativePaths(rootPath, absolutePaths) {
  const out = []
  for (const path of Array.isArray(absolutePaths) ? absolutePaths.slice(0, 1000) : []) {
    if (typeof path !== 'string' || !isAbsolute(path)) continue
    const rel = relative(rootPath, path)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    out.push(rel.replace(/\\/g, '/'))
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const compactRemotePrefix = (workspaceId) => `HorseMD/${workspaceId}`
const legacyRemotePrefix = (workspaceId) => `HorseMD/v1/workspaces/${workspaceId}`
const manifestPath = '.horsemd/manifest.json'

export class SyncService {
  constructor({ getUserDataPath, safeStorage, request: rawRequest, traceLog = null, history = null }) {
    this.getUserDataPath = getUserDataPath
    // Local version history: files the sync replaces or deletes go there.
    this.history = history
    // Timeout + optional trace for every provider request (#161). Tests may
    // shorten the timeout (HORSEMD_TEST_SYNC_REQUEST_TIMEOUT_MS).
    const testTimeout = Number(process.env.HORSEMD_TEST_SYNC_REQUEST_TIMEOUT_MS)
    const request = createSyncRequest(rawRequest, {
      log: traceLog,
      ...(Number.isFinite(testTimeout) && testTimeout > 0 ? { baseTimeoutMs: testTimeout } : {})
    })
    this.request = request
    this.credentials = new CredentialStore({ userDataPath: getUserDataPath(), safeStorage })
    this.connections = new ConnectionRegistry({
      userDataPath: getUserDataPath(),
      credentialStore: this.credentials,
      createWebDavProvider: (config) => new WebDavProvider({ ...config, request, pacer: newPacer() }),
      createS3Provider: (config) => new S3Provider({ ...config, request, pacer: newPacer() })
    })
    this.running = new Set()
    this.runningPaths = new Map()
    // rootPath (lower-cased) -> SyncControl of the running sync.
    this.controls = new Map()
  }

  async addWebDavConnection(config) {
    return this.connections.addWebDav(config)
  }

  async addS3Connection(config) {
    return this.connections.addS3(config)
  }

  async listConnections() {
    return this.connections.list()
  }

  async updateConnection(connectionId, config) {
    return this.connections.update(connectionId, config)
  }

  async removeConnection(connectionId) {
    const bound = (await readWorkspaceRegistry(this.getUserDataPath()))
      .find((workspace) => workspace.connectionId === connectionId)
    if (bound) throw new Error(`“${bound.rootPath}”仍在使用这个连接。请先停止管理该同步文件夹。`)
    return this.connections.remove(connectionId)
  }

  async testConnection(connectionId) {
    return this.connections.test(connectionId)
  }

  async bindWorkspace(rootPath, connectionId) {
    await this.connections.createProvider(connectionId)
    return bindSyncWorkspace(this.getUserDataPath(), rootPath, connectionId)
  }

  async listRemoteWorkspaces(connectionId) {
    const provider = await this.connections.createProvider(connectionId)
    const workspaces = new Map()
    for (const root of ['HorseMD', 'HorseMD/v1/workspaces']) {
      const rows = await provider.list(root)
      const ids = rows.filter((row) => row.isDirectory).map((row) => row.href.split('/').filter(Boolean).pop()).filter(Boolean)
      for (const workspaceId of ids) {
        if (workspaces.has(workspaceId)) continue
        const manifest = await provider.get(`${root}/${workspaceId}/${manifestPath}`)
        if (!manifest) continue
        try {
          const parsed = JSON.parse(manifest.bytes.toString('utf8'))
          if (parsed.workspaceId === workspaceId) workspaces.set(workspaceId, { workspaceId, fileCount: Object.keys(parsed.files || {}).length })
        } catch { /* ignore malformed non-HorseMD directories */ }
      }
    }
    return [...workspaces.values()]
  }

  async joinWorkspace(rootPath, connectionId, workspaceId) {
    await this.connections.createProvider(connectionId)
    const candidates = await this.listRemoteWorkspaces(connectionId)
    if (!candidates.some((item) => item.workspaceId === workspaceId)) throw new Error('远端工作区不存在。')
    const entry = await joinSyncWorkspace(this.getUserDataPath(), rootPath, workspaceId)
    return bindSyncWorkspace(this.getUserDataPath(), entry.rootPath, connectionId)
  }

  async engineFor(rootPath, onProgress = null, control = null, { busyPaths = [] } = {}) {
    const entry = (await readWorkspaceRegistry(this.getUserDataPath()))
      .find((workspace) => workspace.rootPath.toLowerCase() === rootPath.replace(/[\\/]+$/, '').toLowerCase())
    if (!entry?.connectionId) throw new Error('请先为这个文件夹选择云端连接。')
    const prefixes = [compactRemotePrefix(entry.workspaceId), legacyRemotePrefix(entry.workspaceId)]
    let provider = null
    let compactProvider = null
    for (const prefix of prefixes) {
      const candidate = await this.connections.createProvider(entry.connectionId, { prefix })
      if (prefix === prefixes[0]) compactProvider = candidate
      if (await candidate.get(manifestPath)) {
        provider = candidate
        break
      }
    }
    provider ||= compactProvider
    if (onProgress && provider.pacer) provider.pacer.onThrottle = (event) => onProgress({ throttle: event })
    // Throttling waits end at once on stop and hold while paused.
    if (control && provider.pacer) provider.pacer.sleep = (ms) => control.sleep(ms)
    return new SyncEngine({
      userDataPath: this.getUserDataPath(),
      rootPath: entry.rootPath,
      workspaceId: entry.workspaceId,
      provider,
      deviceName: deviceLabel(),
      onProgress,
      control,
      busyPaths: busyRelativePaths(entry.rootPath, busyPaths),
      history: this.history
    })
  }

  async preview(rootPath, strategy = 'merge') {
    return (await this.engineFor(rootPath)).preview(strategy)
  }

  // `busyPaths`: absolute paths of files open with unsaved edits (never
  // overwritten by this run). A run whose manifest commit loses to another
  // device re-plans and runs again (up to 3 times) instead of failing.
  async run(rootPath, strategy = 'merge', onProgress = null, { safeOnly = false, busyPaths = [] } = {}) {
    const key = rootPath.toLowerCase()
    if (this.running.has(key)) throw new Error('这个文件夹正在同步。')
    this.running.add(key)
    this.runningPaths.set(key, rootPath)
    const control = new SyncControl({ onChange: (state) => onProgress?.({ control: state }) })
    this.controls.set(key, control)
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await (await this.engineFor(rootPath, onProgress, control, { busyPaths })).execute(null, strategy, { safeOnly })
        } catch (error) {
          if (!error?.manifestChanged || attempt >= 3) throw error
          await sleep(400 * attempt)
        }
      }
    } finally {
      this.running.delete(key)
      this.runningPaths.delete(key)
      this.controls.delete(key)
    }
  }

  // Folders with a sync in progress (a reopened window asks, #161).
  status() {
    return { running: [...this.runningPaths.values()] }
  }

  // Pause / resume / stop the running sync of a folder (false when none runs).
  control(rootPath, action) {
    const control = this.controls.get(String(rootPath || '').toLowerCase())
    if (!control || !['pause', 'resume', 'stop'].includes(action)) return false
    return control[action]()
  }
}

export function registerSyncServiceIpc(ipcMain, { syncService, isTrustedSender, sendToRenderer = null }) {
  const trusted = (event) => {
    if (isTrustedSender(event)) return
    throw new Error('Untrusted renderer.')
  }
  ipcMain.handle('sync:connectionList', async (event) => {
    trusted(event)
    return syncService.listConnections()
  })
  ipcMain.handle('sync:connectionAddWebDav', async (event, config) => {
    trusted(event)
    return syncService.addWebDavConnection(config || {})
  })
  ipcMain.handle('sync:connectionAddS3', async (event, config) => {
    trusted(event)
    return syncService.addS3Connection(config || {})
  })
  ipcMain.handle('sync:connectionUpdate', async (event, connectionId, config) => {
    trusted(event)
    return syncService.updateConnection(connectionId, config || {})
  })
  ipcMain.handle('sync:connectionRemove', async (event, connectionId) => {
    trusted(event)
    return syncService.removeConnection(connectionId)
  })
  ipcMain.handle('sync:connectionTest', async (event, connectionId) => {
    trusted(event)
    return syncService.testConnection(connectionId)
  })
  ipcMain.handle('sync:workspaceBindConnection', async (event, rootPath, connectionId) => {
    trusted(event)
    return syncService.bindWorkspace(rootPath, connectionId)
  })
  ipcMain.handle('sync:preview', async (event, rootPath, strategy) => {
    trusted(event)
    return syncService.preview(rootPath, strategy)
  })
  ipcMain.handle('sync:run', async (event, rootPath, strategy, options) => {
    trusted(event)
    // Progress (and long throttling waits) go to the window that started it.
    const sender = event.sender
    // On macOS the window can be closed and reopened while the sync runs:
    // the new window gets the progress through sendToRenderer.
    const report = (progress) => {
      const payload = { rootPath, ...progress }
      try {
        if (!sender.isDestroyed()) sender.send('sync:progress', payload)
        else sendToRenderer?.('sync:progress', payload)
      } catch { /* window gone */ }
    }
    try {
      // safeOnly: automatic sync (hooks/useAutoSync.js) — merge only.
      const safeOnly = options?.safeOnly === true
      const busyPaths = Array.isArray(options?.dirtyPaths) ? options.dirtyPaths.filter((path) => typeof path === 'string') : []
      return await syncService.run(rootPath, safeOnly ? 'merge' : strategy, report, { safeOnly, busyPaths })
    } finally {
      report({ done: true })
    }
  })
  ipcMain.handle('sync:status', async (event) => {
    trusted(event)
    return syncService.status()
  })
  ipcMain.handle('sync:control', async (event, rootPath, action) => {
    trusted(event)
    return syncService.control(rootPath, action)
  })
  ipcMain.handle('sync:remoteWorkspaceList', async (event, connectionId) => { trusted(event); return syncService.listRemoteWorkspaces(connectionId) })
  ipcMain.handle('sync:workspaceJoin', async (event, rootPath, connectionId, workspaceId) => { trusted(event); return syncService.joinWorkspace(rootPath, connectionId, workspaceId) })
}
