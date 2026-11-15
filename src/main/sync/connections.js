// Desktop connection registry: userData/sync/connections.json (shared logic
// in src/shared/sync/connections.js; the S3 Access Key ID stays in the file).
import { randomUUID } from 'node:crypto'
import { ConnectionRegistry as SharedConnectionRegistry, readConnections as sharedReadConnections } from '../../shared/sync/connections.js'
import { createNodeStore } from './node-platform.js'

export const readConnections = (userDataPath) => sharedReadConnections(createNodeStore(() => userDataPath))

export class ConnectionRegistry extends SharedConnectionRegistry {
  constructor({ userDataPath, store = null, ...options }) {
    super({ uuid: randomUUID, ...options, store: store || createNodeStore(() => userDataPath) })
    this.userDataPath = userDataPath
  }
}
