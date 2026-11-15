// The desktop's platform adapters for the shared sync code (src/shared/sync/,
// contract in docs/mobile-cloud-sync-architecture.md §6). Everything here is
// exactly what the sync did before the code was shared: node:fs with the same
// temp-file names and modes, node:path semantics (Windows paths too),
// node:crypto hashes, zlib gzip, and Buffers for every byte it hands out (the
// providers, the tests' mock clouds and the history read them as Buffers).
import fs from 'node:fs/promises'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { gzip as gzipCb, gunzip as gunzipCb } from 'node:zlib'
import { promisify } from 'node:util'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isAbsoluteWatchPath, isRestrictedWatchRoot } from '../workspace-watch-policy.js'
import { INTERNAL_DIRS, createHashCache } from '../../shared/sync/local-files.js'
import { isSystemJunkPath } from '../../shared/sync/sync-ignore.js'
import { deviceLabel } from './conflict-name.js'

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export const nodeHash = { sha256: async (bytes) => sha256(bytes) }

export const nodeBytes = {
  fromText: (text) => Buffer.from(text, 'utf8'),
  // A Buffer (or anything else a mock cloud returns) decodes as before.
  toText: (bytes) => (Buffer.isBuffer(bytes) || !(bytes instanceof Uint8Array)
    ? bytes.toString('utf8')
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')),
  fromArrayBuffer: (arrayBuffer) => Buffer.from(arrayBuffer),
  empty: () => Buffer.alloc(0),
  base64: (text) => Buffer.from(text).toString('base64')
}

export const nodePaths = {
  // The engine's old assertSafeRelative: strictly inside the root, else null.
  resolveInside(rootPath, relativePath) {
    const target = resolve(rootPath, relativePath)
    const rel = relative(rootPath, target)
    if (!rel || rel.startsWith('..') || resolve(rootPath) === target) return null
    return target
  },
  join: (...parts) => join(...parts),
  // Absolute path inside the root → '/'-joined relative path, else null.
  relativeInside(rootPath, path) {
    if (typeof path !== 'string' || !isAbsolute(path)) return null
    const rel = relative(rootPath, path)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    return rel.replace(/\\/g, '/')
  },
  normalizeRoot: (path) => resolve(path).replace(/[\\/]+$/, ''),
  isRootAllowed: (path) => isAbsoluteWatchPath(path),
  isRestrictedRoot: (path) => isRestrictedWatchRoot(path),
  basename: (path) => basename(path)
}

const mkdirOptions = (secret) => (secret ? { recursive: true, mode: 0o700 } : { recursive: true })

export const nodeFs = {
  // Recursive listing for the scan: never follows symlinks, does not enter
  // .horsemd/.git/.obsidian/node_modules, and leaves out system files and
  // HorseMD's in-flight temp files BEFORE stat (a save's temp file may be gone
  // a moment later). Depth-first in readdir order, as the scan always was.
  async scan(rootPath) {
    const out = []
    async function walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory() && INTERNAL_DIRS.has(entry.name)) continue
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          const rel = relative(rootPath, fullPath)
          if (rel && !rel.startsWith(`..${sep}`)) out.push({ kind: 'dir', rel: rel.replace(/\\/g, '/'), abs: fullPath })
          await walk(fullPath)
          continue
        }
        if (!entry.isFile()) continue
        if (isSystemJunkPath(entry.name)) continue
        const rel = relative(rootPath, fullPath)
        if (!rel || rel.startsWith(`..${sep}`)) continue
        const stat = await fs.stat(fullPath)
        out.push({
          kind: 'file',
          rel: rel.replace(/\\/g, '/'),
          abs: fullPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          cacheKey: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
        })
      }
    }
    await walk(rootPath)
    return out
  },
  readBytes: (path) => fs.readFile(path),
  async writeAtomic(path, bytes, { private: secret = false } = {}) {
    await fs.mkdir(dirname(path), mkdirOptions(secret))
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(temp, bytes, secret ? { mode: 0o600 } : undefined)
    await fs.rename(temp, path)
  },
  // Create-only (EEXIST when the file is there); the folder must exist.
  writeNew: (path, bytes, { private: secret = false } = {}) => fs.writeFile(path, bytes, secret ? { mode: 0o600, flag: 'wx' } : { flag: 'wx' }),
  mkdirp: (path, { private: secret = false } = {}) => fs.mkdir(path, mkdirOptions(secret)),
  async moveFile(from, to) {
    await fs.mkdir(dirname(to), { recursive: true })
    await fs.rename(from, to)
  },
  rm: (path) => fs.rm(path, { force: true }),
  unlink: (path) => fs.unlink(path),
  rmdir: (path) => fs.rmdir(path),
  async readdir(path) {
    return (await fs.readdir(path, { withFileTypes: true }))
      .map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() }))
  },
  async exists(path) {
    try {
      await fs.access(path)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  },
  async stat(path) {
    const stat = await fs.stat(path)
    return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs }
  }
}

// Small private documents under userData (connections, registry, sync state,
// merge ancestors). `getRoot` is read on every call: the main process may set
// userData (--user-data-dir) after this module loads.
export function createNodeStore(getRoot) {
  const at = (name) => join(getRoot(), ...String(name).split('/'))
  const readOrNull = async (path, encoding) => {
    try {
      return await fs.readFile(path, encoding)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
  return {
    readText: (name) => readOrNull(at(name), 'utf8'),
    async writeText(name, text, { private: secret = false } = {}) {
      const path = at(name)
      await fs.mkdir(dirname(path), mkdirOptions(secret))
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      await fs.writeFile(temp, text, secret ? { encoding: 'utf8', mode: 0o600 } : { encoding: 'utf8' })
      await fs.rename(temp, path)
    },
    readBytes: (name) => readOrNull(at(name)),
    async writeBytes(name, bytes) {
      const path = at(name)
      await fs.mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      await fs.writeFile(temp, bytes)
      await fs.rename(temp, path)
    },
    async exists(name) {
      try { await fs.access(at(name)); return true } catch { return false }
    },
    list: (dir) => fs.readdir(at(dir)),
    remove: (name) => fs.rm(at(name), { force: true }),
    removeTree: (dir) => fs.rm(at(dir), { recursive: true, force: true })
  }
}

const gzip = promisify(gzipCb)
const gunzip = promisify(gunzipCb)

// One hash cache per process (per absolute path), shared by every engine.
export const nodeHashCache = createHashCache()

// `userDataPath` (fixed) or `getUserDataPath` (read on every store call).
export function createNodePlatform({ userDataPath = null, getUserDataPath = null } = {}) {
  const getRoot = getUserDataPath || (() => userDataPath)
  return {
    fs: nodeFs,
    paths: nodePaths,
    hash: nodeHash,
    bytes: nodeBytes,
    store: createNodeStore(getRoot),
    gzip,
    gunzip,
    uuid: () => randomUUID(),
    deviceName: () => deviceLabel(),
    env: process.env,
    hashCache: nodeHashCache
  }
}
