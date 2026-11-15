// Desktop S3 provider: the shared one (src/shared/sync/s3-provider.js) with
// Buffers and node:crypto UUIDs, as before.
import { randomUUID } from 'node:crypto'
import { S3Provider as SharedS3Provider } from '../../shared/sync/s3-provider.js'
import { nodeBytes } from './node-platform.js'

export class S3Provider extends SharedS3Provider {
  constructor(options) {
    super({ bytes: nodeBytes, uuid: randomUUID, ...options })
  }
}
