// The sync service (connections, sync folders, runs), shared by desktop and
// phones. The desktop builds it with Node adapters and keeps the IPC in
// src/main/sync-service.js; a phone builds it in the WebView with its own
// adapters (docs/mobile-cloud-sync-architecture.md §6).
import { ConnectionRegistry } from './connections.js'
import { WebDavProvider } from './webdav-provider.js'
import { S3Provider } from './s3-provider.js'
import { SyncEngine } from './sync-engine.js'
import { SyncControl } from './sync-control.js'
import { bindSyncWorkspace, joinSyncWorkspace, readWorkspaceRegistry } from './sync-workspaces.js'
import { RequestPacer } from './request-pacer.js'
import { createSyncRequest } from './sync-request.js'
import { createFetchFromHttp } from './http.js'

// UI tests shorten the throttling waits (minutes in production) to seconds.
const testPacerOptions = (env) => {
  try { return JSON.parse(env?.HORSEMD_TEST_SYNC_PACER || 'null') } catch { return null }
}
const newPacer = (env) => {
  const options = testPacerOptions(env)
  return options ? new RequestPacer(options) : new RequestPacer()
}

// Paths of files open with unsaved edits → paths relative to the sync root
// (others dropped). `paths.relativeInside` is the platform's rule (desktop:
// absolute paths only, node:path).
export function busyRelativePaths(paths, rootPath, absolutePaths) {
  const out = []
  for (const path of Array.isArray(absolutePaths) ? absolutePaths.slice(0, 1000) : []) {
    const rel = paths.relativeInside(rootPath, path)
    if (rel) out.push(rel)
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const compactRemotePrefix = (workspaceId) => `HorseMD/${workspaceId}`
const legacyRemotePrefix = (workspaceId) => `HorseMD/v1/workspaces/${workspaceId}`
const manifestPath = '.horsemd/manifest.json'

export class SyncService {
  // `platform`: §6 adapters. `credentials`: get / set / remove of secret
  // objects. `request`: fetch-like (url, init) → Response, or `http`: the
  // platform's raw request adapter (wrapped here). `history`: optional local
  // version history. `connectionsStore`: where sync/connections.json lives
  // (default platform.store). `secretAccessKeyId`: keep the S3 Access Key ID
  // with the secrets (phones).
  constructor({ platform, credentials, request: rawRequest = null, http = null, traceLog = null, history = null, connectionsStore = null, secretAccessKeyId = false }) {
    this.platform = platform
    // Local version history: files the sync replaces or deletes go there.
    this.history = history
    // Timeout + optional trace for every provider request (#161). Tests may
    // shorten the timeout (HORSEMD_TEST_SYNC_REQUEST_TIMEOUT_MS).
    const testTimeout = Number(platform.env?.HORSEMD_TEST_SYNC_REQUEST_TIMEOUT_MS)
    const request = createSyncRequest(rawRequest || createFetchFromHttp(http), {
      log: traceLog,
      ...(Number.isFinite(testTimeout) && testTimeout > 0 ? { baseTimeoutMs: testTimeout } : {})
    })
    this.request = request
    this.credentials = credentials
    const providerOptions = { request, bytes: platform.bytes, uuid: platform.uuid }
    this.connections = new ConnectionRegistry({
      store: connectionsStore || platform.store,
      credentialStore: this.credentials,
      uuid: platform.uuid,
      secretAccessKeyId,
      createWebDavProvider: (config) => new WebDavProvider({ ...config, ...providerOptions, pacer: newPacer(platform.env) }),
      createS3Provider: (config) => new S3Provider({ ...config, ...providerOptions, pacer: newPacer(platform.env) })
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
    const bound = (await readWorkspaceRegistry(this.platform))
      .find((workspace) => workspace.connectionId === connectionId)
    if (bound) throw new Error(`“${bound.rootPath}”仍在使用这个连接。请先停止管理该同步文件夹。`)
    return this.connections.remove(connectionId)
  }

  async testConnection(connectionId) {
    return this.connections.test(connectionId)
  }

  async bindWorkspace(rootPath, connectionId) {
    await this.connections.createProvider(connectionId)
    return bindSyncWorkspace(this.platform, rootPath, connectionId)
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
          const parsed = JSON.parse(this.platform.bytes.toText(manifest.bytes))
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
    const entry = await joinSyncWorkspace(this.platform, rootPath, workspaceId)
    return bindSyncWorkspace(this.platform, entry.rootPath, connectionId)
  }

  async engineFor(rootPath, onProgress = null, control = null, { busyPaths = [] } = {}) {
    const entry = (await readWorkspaceRegistry(this.platform))
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
      platform: this.platform,
      rootPath: entry.rootPath,
      workspaceId: entry.workspaceId,
      provider,
      deviceName: this.platform.deviceName(),
      onProgress,
      control,
      busyPaths: busyRelativePaths(this.platform.paths, entry.rootPath, busyPaths),
      history: this.history
    })
  }

  async preview(rootPath, strategy = 'merge') {
    return (await this.engineFor(rootPath)).preview(strategy)
  }

  // `busyPaths`: absolute paths of files open with unsaved edits (never
  // overwritten by this run). A run whose manifest commit loses to another
  // device re-plans and runs again (up to 3 times) instead of failing.
  async run(rootPath, strategy = 'merge', onProgress = null, { automatic = false, safeOnly = false, busyPaths = [] } = {}) {
    automatic = automatic || safeOnly
    const key = rootPath.toLowerCase()
    if (this.running.has(key)) throw new Error('这个文件夹正在同步。')
    this.running.add(key)
    this.runningPaths.set(key, rootPath)
    const control = new SyncControl({ onChange: (state) => onProgress?.({ control: state }) })
    this.controls.set(key, control)
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await (await this.engineFor(rootPath, onProgress, control, { busyPaths })).execute(null, strategy, { automatic })
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
