import { CredentialStore } from './sync/credential-store.js'
import { ConnectionRegistry } from './sync/connections.js'
import { WebDavProvider } from './sync/webdav-provider.js'
import { S3Provider } from './sync/s3-provider.js'
import { SyncEngine } from './sync/sync-engine.js'
import { bindSyncWorkspace, joinSyncWorkspace, readWorkspaceRegistry } from './sync-workspaces.js'

const compactRemotePrefix = (workspaceId) => `HorseMD/${workspaceId}`
const legacyRemotePrefix = (workspaceId) => `HorseMD/v1/workspaces/${workspaceId}`
const manifestPath = '.horsemd/manifest.json'

export class SyncService {
  constructor({ getUserDataPath, safeStorage, request }) {
    this.getUserDataPath = getUserDataPath
    this.request = request
    this.credentials = new CredentialStore({ userDataPath: getUserDataPath(), safeStorage })
    this.connections = new ConnectionRegistry({
      userDataPath: getUserDataPath(),
      credentialStore: this.credentials,
      createWebDavProvider: (config) => new WebDavProvider({ ...config, request }),
      createS3Provider: (config) => new S3Provider({ ...config, request })
    })
    this.running = new Set()
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

  async engineFor(rootPath) {
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
    return new SyncEngine({
      userDataPath: this.getUserDataPath(),
      rootPath: entry.rootPath,
      workspaceId: entry.workspaceId,
      provider,
      deviceName: 'HorseMD'
    })
  }

  async preview(rootPath, strategy = 'merge') {
    return (await this.engineFor(rootPath)).preview(strategy)
  }

  async run(rootPath, strategy = 'merge') {
    const key = rootPath.toLowerCase()
    if (this.running.has(key)) throw new Error('这个文件夹正在同步。')
    this.running.add(key)
    try {
      return await (await this.engineFor(rootPath)).execute(null, strategy)
    } finally {
      this.running.delete(key)
    }
  }
}

export function registerSyncServiceIpc(ipcMain, { syncService, isTrustedSender }) {
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
  ipcMain.handle('sync:run', async (event, rootPath, strategy) => {
    trusted(event)
    return syncService.run(rootPath, strategy)
  })
  ipcMain.handle('sync:remoteWorkspaceList', async (event, connectionId) => { trusted(event); return syncService.listRemoteWorkspaces(connectionId) })
  ipcMain.handle('sync:workspaceJoin', async (event, rootPath, connectionId, workspaceId) => { trusted(event); return syncService.joinWorkspace(rootPath, connectionId, workspaceId) })
}
