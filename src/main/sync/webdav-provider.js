// Desktop WebDAV provider: the shared one (src/shared/sync/webdav-provider.js)
// with Buffers and node:crypto UUIDs, as before.
import { randomUUID } from 'node:crypto'
import { WebDavProvider as SharedWebDavProvider, parsePropfind } from '../../shared/sync/webdav-provider.js'
import { nodeBytes } from './node-platform.js'

export class WebDavProvider extends SharedWebDavProvider {
  constructor(options) {
    super({ bytes: nodeBytes, uuid: randomUUID, ...options })
  }
}

export { parsePropfind }
