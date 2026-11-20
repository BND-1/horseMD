// Desktop sync folders: the shared registry (src/shared/sync/sync-workspaces.js)
// over node:fs, rooted at userData, with the desktop's folder rules (absolute,
// not a system location — workspace-watch-policy.js). Same exports and IPC as
// before.
import * as shared from '../shared/sync/sync-workspaces.js'
import { createNodePlatform } from './sync/node-platform.js'

export const { SYNC_WORKSPACE_DIR, SYNC_WORKSPACE_FILE } = shared

const platformFor = (userDataPath) => createNodePlatform({ userDataPath })

export const readWorkspaceRegistry = (userDataPath) => shared.readWorkspaceRegistry(platformFor(userDataPath))
export const adoptSyncWorkspace = (userDataPath, rootPath) => shared.adoptSyncWorkspace(platformFor(userDataPath), rootPath)
export const unregisterSyncWorkspace = (userDataPath, rootPath) => shared.unregisterSyncWorkspace(platformFor(userDataPath), rootPath)
export const bindSyncWorkspace = (userDataPath, rootPath, connectionId) => shared.bindSyncWorkspace(platformFor(userDataPath), rootPath, connectionId)
export const joinSyncWorkspace = (userDataPath, rootPath, remoteWorkspaceId) => shared.joinSyncWorkspace(platformFor(userDataPath), rootPath, remoteWorkspaceId)

export function registerSyncWorkspaceIpc(ipcMain, { getUserDataPath, isTrustedSender, beforeRemove = null }) {
  const trusted = (event) => {
    if (isTrustedSender?.(event)) return
    throw new Error('Untrusted renderer.')
  }

  ipcMain.handle('sync:workspaceList', async (event) => {
    trusted(event)
    return shared.listSyncWorkspaces(platformFor(getUserDataPath()))
  })
  ipcMain.handle('sync:workspaceAdopt', async (event, rootPath) => {
    trusted(event)
    return adoptSyncWorkspace(getUserDataPath(), rootPath)
  })
  ipcMain.handle('sync:workspaceRemove', async (event, rootPath) => {
    trusted(event)
    await beforeRemove?.(rootPath)
    return unregisterSyncWorkspace(getUserDataPath(), rootPath)
  })
}
