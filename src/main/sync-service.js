// Desktop sync service: the shared service (src/shared/sync/sync-service.js)
// on Node adapters (sync/node-platform.js), safeStorage credentials and
// Electron's net.request; the IPC surface is unchanged.
import { CredentialStore } from './sync/credential-store.js'
import { SyncService as SharedSyncService, busyRelativePaths as sharedBusyRelativePaths } from '../shared/sync/sync-service.js'
import { createNodePlatform, createNodeStore, nodePaths } from './sync/node-platform.js'

// Absolute paths of files open with unsaved edits → paths relative to the
// sync root (others dropped).
export function busyRelativePaths(rootPath, absolutePaths) {
  return sharedBusyRelativePaths(nodePaths, rootPath, absolutePaths)
}

export class SyncService extends SharedSyncService {
  constructor({ getUserDataPath, safeStorage, request, traceLog = null, history = null }) {
    // Connections and credentials use the userData folder of the moment the
    // service is created; the registry, state and merge ancestors read it on
    // every use (as before).
    const userDataPath = getUserDataPath()
    super({
      platform: createNodePlatform({ getUserDataPath }),
      credentials: new CredentialStore({ userDataPath, safeStorage }),
      connectionsStore: createNodeStore(() => userDataPath),
      request,
      traceLog,
      history
    })
    this.getUserDataPath = getUserDataPath
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
  // HorseMD 同步: login code by mail, then the code → a connection.
  ipcMain.handle('sync:officialLoginStart', async (event, config) => {
    trusted(event)
    return syncService.startOfficialLogin(config || {})
  })
  ipcMain.handle('sync:officialLoginVerify', async (event, config) => {
    trusted(event)
    return syncService.addOfficialConnection(config || {})
  })
  ipcMain.handle('sync:officialEnabled', async (event) => {
    trusted(event)
    return syncService.officialSyncEnabled()
  })
  ipcMain.handle('sync:officialAccount', async (event, connectionId) => {
    trusted(event)
    return syncService.officialAccount(connectionId)
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
  // options.encryption: { password } → end-to-end encrypted (sync-crypto.js).
  ipcMain.handle('sync:workspaceBindConnection', async (event, rootPath, connectionId, options) => {
    trusted(event)
    const password = options?.encryption?.password
    return syncService.bindWorkspace(rootPath, connectionId, typeof password === 'string' ? { encryption: { password } } : {})
  })
  ipcMain.handle('sync:workspaceUnlock', async (event, rootPath, password) => {
    trusted(event)
    return syncService.unlockWorkspace(rootPath, String(password ?? ''))
  })
  ipcMain.handle('sync:encryptionPassword', async (event, rootPath, oldPassword, newPassword) => {
    trusted(event)
    return syncService.changeEncryptionPassword(rootPath, String(oldPassword ?? ''), String(newPassword ?? ''))
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
      // automatic sync (hooks/useAutoSync.js) — merge only; `safeOnly` is
      // the old name of the option.
      const automatic = options?.automatic === true || options?.safeOnly === true
      const busyPaths = Array.isArray(options?.dirtyPaths) ? options.dirtyPaths.filter((path) => typeof path === 'string') : []
      return await syncService.run(rootPath, automatic ? 'merge' : strategy, report, { automatic, busyPaths })
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
  ipcMain.handle('sync:workspaceJoin', async (event, rootPath, connectionId, workspaceId, options) => {
    trusted(event)
    return syncService.joinWorkspace(rootPath, connectionId, workspaceId, { password: String(options?.password ?? '') })
  })
}
