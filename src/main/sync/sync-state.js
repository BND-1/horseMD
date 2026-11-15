// Desktop sync state: userData/sync/state/<workspaceId>.json (shared logic in
// src/shared/sync/sync-state.js).
import { readSyncState as sharedRead, writeSyncState as sharedWrite } from '../../shared/sync/sync-state.js'
import { createNodeStore } from './node-platform.js'

export const readSyncState = (userDataPath, workspaceId) => sharedRead(createNodeStore(() => userDataPath), workspaceId)
export const writeSyncState = (userDataPath, state) => sharedWrite(createNodeStore(() => userDataPath), state)
