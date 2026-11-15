// Desktop merge ancestors: userData/sync/base/<workspace>/<sha256>.gz (shared
// logic in src/shared/sync/sync-base.js).
import { SyncBaseStore as SharedSyncBaseStore, MERGEABLE, MAX_MERGE_BYTES, isMergeable } from '../../shared/sync/sync-base.js'
import { createNodePlatform } from './node-platform.js'

export class SyncBaseStore extends SharedSyncBaseStore {
  constructor(userDataPath, workspaceId) {
    super(createNodePlatform({ userDataPath }), workspaceId)
  }
}

export { MERGEABLE, MAX_MERGE_BYTES, isMergeable }
