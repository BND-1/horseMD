// Desktop scan of a sync folder: the shared scan (src/shared/sync/local-files.js)
// over node:fs, with the per-process hash cache.
import {
  scanLocalEmptyDirs as sharedScanLocalEmptyDirs,
  scanLocalWorkspace as sharedScanLocalWorkspace
} from '../../shared/sync/local-files.js'
import { nodeFs, nodeHash, nodeHashCache, sha256 } from './node-platform.js'

const platform = { fs: nodeFs, hash: nodeHash }

export { sha256 }

export const clearScanCache = () => nodeHashCache.clear()

export function scanLocalWorkspace(rootPath, { maxFiles = 20000 } = {}) {
  return sharedScanLocalWorkspace(platform, rootPath, { maxFiles, cache: nodeHashCache })
}

export function scanLocalEmptyDirs(rootPath) {
  return sharedScanLocalEmptyDirs(platform, rootPath)
}
