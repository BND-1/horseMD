// Desktop entry point of the shared sync engine (src/shared/sync/sync-engine.js):
// the same constructor as before (`userDataPath` instead of a platform), run
// on the Node adapters of node-platform.js.
import { SyncEngine as SharedSyncEngine, massDeletion } from '../../shared/sync/sync-engine.js'
import { createNodePlatform } from './node-platform.js'

export class SyncEngine extends SharedSyncEngine {
  constructor({ userDataPath, platform = null, ...options }) {
    super({ ...options, platform: platform || createNodePlatform({ userDataPath }) })
    this.userDataPath = userDataPath
  }
}

export { massDeletion }
