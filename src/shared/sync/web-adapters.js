// Building blocks for a WebView platform (phones): hashing through Web
// Crypto, gzip through CompressionStream, POSIX paths. The phone's fs, store,
// secrets and http adapters wrap native plugins and live with the renderer
// (src/renderer/src/platform/mobile-sync/); see
// docs/mobile-cloud-sync-architecture.md §6.
import { webBytes } from './bytes.js'
import { join, normalize, relativeInside, resolveInside, basename } from './posix-path.js'

const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')

export const webHash = {
  async sha256(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : webBytes.fromText(String(bytes))
    return hex(await globalThis.crypto.subtle.digest('SHA-256', view))
  }
}

async function streamThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// CompressionStream: iOS 16.4+, Android System WebView 80+. The merge
// ancestors are an optimization; a platform without it may pass identity
// functions (the store keeps the raw bytes under the same name).
export const webGzip = (bytes) => streamThrough(bytes, new CompressionStream('gzip'))
export const webGunzip = (bytes) => streamThrough(bytes, new DecompressionStream('gzip'))

export const webUuid = () => globalThis.crypto.randomUUID()

// Path rules for a phone whose sync root is a relative library folder
// ("HorseMD") or an absolute POSIX path. `isRootAllowed` defaults to "a
// non-empty path without '..' segments"; the phone passes its own (only the
// library root syncs in phase 1).
export function createPosixPaths({ isRootAllowed = null } = {}) {
  const allowed = isRootAllowed || ((path) => typeof path === 'string' && path.trim() !== '' &&
    !String(path).replace(/\\/g, '/').split('/').includes('..'))
  return {
    resolveInside,
    relativeInside,
    join: (...parts) => join(...parts.map((part) => String(part).replace(/\\/g, '/'))),
    normalizeRoot: (path) => {
      const value = normalize(String(path).replace(/\\/g, '/'))
      return value.length > 1 ? value.replace(/\/+$/, '') : value
    },
    isRootAllowed: allowed,
    isRestrictedRoot: (path) => !allowed(path) || ['', '.', '..', '/'].includes(String(path)),
    basename: (path) => basename(String(path).replace(/\\/g, '/'))
  }
}
