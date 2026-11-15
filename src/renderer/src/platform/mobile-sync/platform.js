// The phone's platform adapters for the shared sync engine (src/shared/sync/,
// contract in docs/mobile-cloud-sync-architecture.md §6.2). Loaded lazily by
// platform/capacitor-api.js (only when cloud sync is used).
//
//   fs       @capacitor/filesystem, the app library only (paths "HorseMD/…"
//            relative to the library's Directory, as capacitor-api.js uses);
//            bytes cross the bridge as base64.
//   paths    POSIX; the library root is the only sync root (phase 1: no
//            ext: roots — HorseFiles / SAF / iOS bookmarks do not sync).
//   store    app-private, never backed up (./store-location.js), under
//            horsemd-sync/.
//   hash     Web Crypto, @aws-crypto/sha256-js when crypto.subtle is missing.
//   gzip     CompressionStream when available, else stored as is (gunzip
//            reads both: a gzip header decides).
import { Encoding, Filesystem } from '@capacitor/filesystem'
import { Sha256 } from '@aws-crypto/sha256-js'
import { webBytes } from '../../../../shared/sync/bytes.js'
import { createPosixPaths, webGunzip, webGzip, webHash } from '../../../../shared/sync/web-adapters.js'
import { INTERNAL_DIRS, createHashCache } from '../../../../shared/sync/local-files.js'
import { isSystemJunkPath } from '../../../../shared/sync/sync-ignore.js'
import { base64ToBytes, bytesToBase64, deviceName as nativeDeviceName } from '../native-sync.js'
import { STORE_ROOT, storeDirectory } from './store-location.js'

// ---- errors ------------------------------------------------------------------
// @capacitor/filesystem 7+ rejects with OS-PLUG-FILE-00xx codes (0008 does not
// exist, 0010 already exists, 0012 directory has children); the web
// implementation only has messages. The engine wants Node codes.
const codeOf = (error) => String(error?.code || '')
const messageOf = (error) => String(error?.message || error || '')
const isNotFound = (error) => /0008$/.test(codeOf(error)) || codeOf(error) === 'ENOENT' ||
  /does not exist|no such file|not exist|not found/i.test(messageOf(error))
const isAlreadyExists = (error) => /0010$/.test(codeOf(error)) || /already exists/i.test(messageOf(error))
const isNotEmpty = (error) => /0012$/.test(codeOf(error)) || /children|not empty/i.test(messageOf(error))
const withCode = (error, code, path) => Object.assign(new Error(`${code}: ${messageOf(error) || path}`), { code, path, cause: error })

const dirname = (path) => {
  const cut = String(path).lastIndexOf('/')
  return cut <= 0 ? '' : path.slice(0, cut)
}

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

export const randomUuid = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    try { return globalThis.crypto.randomUUID() } catch { /* not a secure context */ }
  }
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const h = hex(bytes)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const hash = {
  async sha256(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : webBytes.fromText(String(bytes))
    if (globalThis.crypto?.subtle?.digest) {
      try { return await webHash.sha256(view) } catch { /* fall through */ }
    }
    const digest = new Sha256()
    digest.update(view)
    return hex(await digest.digest())
  }
}

const isGzip = (bytes) => bytes?.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
const gzip = async (bytes) => (typeof CompressionStream === 'function' ? webGzip(bytes) : bytes)
const gunzip = async (bytes) => (isGzip(bytes) && typeof DecompressionStream === 'function' ? webGunzip(bytes) : bytes)

// readFile without an encoding: base64 on iOS / Android, a Blob on the web.
async function dataToBytes(data) {
  if (data == null) return new Uint8Array(0)
  if (typeof data === 'string') return base64ToBytes(data)
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  return new Uint8Array(0)
}

// One directory's file operations (Filesystem paths relative to `directory`).
function makeFileOps(directory) {
  const at = (path) => ({ path, directory })

  async function stat(path) {
    try {
      const info = await Filesystem.stat(at(path))
      return {
        isDirectory: info.type === 'directory',
        isFile: info.type === 'file',
        size: Number(info.size) || 0,
        mtimeMs: Number(info.mtime) || 0
      }
    } catch (error) {
      if (isNotFound(error)) throw withCode(error, 'ENOENT', path)
      throw error
    }
  }

  async function exists(path) {
    try {
      await stat(path)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  // An error that does not say what happened: ENOENT when the path is gone.
  async function classify(error, path) {
    if (isNotFound(error)) return withCode(error, 'ENOENT', path)
    try {
      if (!(await exists(path))) return withCode(error, 'ENOENT', path)
    } catch { /* keep the original */ }
    return error
  }

  async function readBytes(path) {
    try {
      const { data } = await Filesystem.readFile(at(path))
      return await dataToBytes(data)
    } catch (error) {
      throw await classify(error, path)
    }
  }

  async function mkdirp(path) {
    if (!path) return
    try {
      await Filesystem.mkdir({ ...at(path), recursive: true })
    } catch (error) {
      if (isAlreadyExists(error)) return
      try {
        if ((await stat(path)).isDirectory) return
      } catch { /* report the original */ }
      throw error
    }
  }

  const writeRaw = (path, bytes) => Filesystem.writeFile({ ...at(path), data: bytesToBase64(bytes), recursive: true })

  async function deleteFile(path) {
    try {
      await Filesystem.deleteFile(at(path))
    } catch (error) {
      throw await classify(error, path)
    }
  }

  async function rename(from, to) {
    try {
      await Filesystem.rename({ from, to, directory, toDirectory: directory })
    } catch (error) {
      throw await classify(error, from)
    }
  }

  // Temp file in the same folder + rename. The temp name
  // `<file>.1.<uuid>.tmp` is what sync-ignore.js skips, so a scan never
  // uploads half a write. Filesystem.rename replaces an existing file on iOS
  // (IONFilesystemLib deletes it first); where it refuses, the old file is
  // removed — only after the temp write succeeded — and the rename retried.
  async function writeAtomic(path, bytes) {
    await mkdirp(dirname(path))
    const temp = `${path}.1.${randomUuid()}.tmp`
    try {
      await writeRaw(temp, bytes)
      try {
        await rename(temp, path)
      } catch (error) {
        let destination = null
        try { destination = await stat(path) } catch { /* not there */ }
        if (!destination?.isFile) throw error
        await deleteFile(path)
        await rename(temp, path)
      }
    } catch (error) {
      try { await Filesystem.deleteFile(at(temp)) } catch { /* already moved or never written */ }
      throw error
    }
  }

  async function readdir(path) {
    try {
      const { files } = await Filesystem.readdir(at(path))
      return files || []
    } catch (error) {
      throw await classify(error, path)
    }
  }

  return { at, stat, exists, readBytes, mkdirp, writeRaw, deleteFile, rename, writeAtomic, readdir }
}

// ---- platform.fs (the library) --------------------------------------------------
function makeLibraryFs(ops) {
  return {
    // Recursive, depth-first, dot files included; .horsemd / .git /
    // .obsidian / node_modules not entered; system files and temp files left
    // out. One readdir per folder: Filesystem.readdir already carries size and
    // mtime (no stat per file). cacheKey = size:mtime:ctime — the phone has no
    // inode; a file HorseMD writes forgets its hash (forgetHash below).
    async scan(rootPath) {
      const out = []
      const base = String(rootPath).replace(/\/+$/, '')
      async function walk(dir) {
        const entries = await ops.readdir(dir)
        for (const entry of entries) {
          const name = entry?.name
          if (!name || name === '.' || name === '..') continue
          const abs = `${dir}/${name}`
          const rel = abs.slice(base.length + 1)
          if (entry.type === 'directory') {
            if (INTERNAL_DIRS.has(name)) continue
            out.push({ kind: 'dir', rel, abs })
            await walk(abs)
            continue
          }
          if (entry.type !== 'file' || isSystemJunkPath(name)) continue
          const size = Number(entry.size)
          const mtimeMs = Number(entry.mtime)
          const file = { kind: 'file', rel, abs, size: Number.isFinite(size) ? size : 0, mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0 }
          if (Number.isFinite(size) && Number.isFinite(mtimeMs) && mtimeMs > 0) {
            file.cacheKey = `${size}:${mtimeMs}:${Number(entry.ctime) || 0}`
          }
          out.push(file)
        }
      }
      await walk(base)
      return out
    },
    readBytes: ops.readBytes,
    writeAtomic: (path, bytes) => ops.writeAtomic(path, bytes),
    // Create-only: EEXIST when the file is there.
    async writeNew(path, bytes) {
      if (await ops.exists(path)) throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST', path })
      await ops.writeRaw(path, bytes)
    },
    mkdirp: (path) => ops.mkdirp(path),
    async moveFile(from, to) {
      await ops.mkdirp(dirname(to))
      await ops.rename(from, to)
    },
    async rm(path) {
      try {
        await ops.deleteFile(path)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    },
    unlink: (path) => ops.deleteFile(path),
    // Empty folders only: ENOTEMPTY otherwise (never recursive).
    async rmdir(path) {
      try {
        await Filesystem.rmdir({ ...ops.at(path), recursive: false })
      } catch (error) {
        if (isNotEmpty(error)) throw withCode(error, 'ENOTEMPTY', path)
        const classified = await (async () => {
          if (isNotFound(error)) return withCode(error, 'ENOENT', path)
          try {
            const entries = await ops.readdir(path)
            if (entries.length) return withCode(error, 'ENOTEMPTY', path)
          } catch (inner) {
            if (inner?.code === 'ENOENT') return inner
          }
          return error
        })()
        throw classified
      }
    },
    async readdir(path) {
      return (await ops.readdir(path)).map((entry) => ({
        name: entry.name,
        isFile: entry.type === 'file',
        isDirectory: entry.type === 'directory'
      }))
    },
    exists: ops.exists,
    stat: ops.stat
  }
}

// ---- platform.store (private documents) ----------------------------------------
function makeStore(ops) {
  const at = (name) => `${STORE_ROOT}/${String(name).replace(/^\/+/, '')}`
  const readOrNull = async (read) => {
    try {
      return await read()
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
  return {
    readText: (name) => readOrNull(async () => {
      const path = at(name)
      try {
        const { data } = await Filesystem.readFile({ ...ops.at(path), encoding: Encoding.UTF8 })
        return typeof data === 'string' ? data : await data.text()
      } catch (error) {
        throw await (async () => {
          if (isNotFound(error)) return withCode(error, 'ENOENT', path)
          try { if (!(await ops.exists(path))) return withCode(error, 'ENOENT', path) } catch { /* original */ }
          return error
        })()
      }
    }),
    writeText: (name, text) => ops.writeAtomic(at(name), webBytes.fromText(String(text))),
    readBytes: (name) => readOrNull(() => ops.readBytes(at(name))),
    writeBytes: (name, bytes) => ops.writeAtomic(at(name), bytes),
    async exists(name) {
      try { return await ops.exists(at(name)) } catch { return false }
    },
    async list(dir) {
      return (await ops.readdir(at(dir))).map((entry) => entry.name).filter(Boolean)
    },
    async remove(name) {
      try { await ops.deleteFile(at(name)) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    },
    async removeTree(dir) {
      try {
        await Filesystem.rmdir({ ...ops.at(at(dir)), recursive: true })
      } catch (error) {
        if (isNotFound(error)) return
        if (await ops.exists(at(dir)).catch(() => true)) throw error
      }
    }
  }
}

// `directory` / `root`: where capacitor-api.js keeps the library
// (Directory.Documents on iOS, Directory.External on Android; "HorseMD").
export async function createMobilePlatform({ directory, root }) {
  const libraryOps = makeFileOps(directory)
  const storeOps = makeFileOps(storeDirectory())
  // platform.deviceName() is synchronous in the service: ask the phone once.
  const device = await nativeDeviceName().catch(() => 'Phone')
  const hashCache = createHashCache()
  return {
    fs: makeLibraryFs(libraryOps),
    paths: createPosixPaths({ isRootAllowed: (path) => path === root }),
    hash,
    bytes: webBytes,
    store: makeStore(storeOps),
    gzip,
    gunzip,
    uuid: randomUuid,
    deviceName: () => device,
    env: {},
    hashCache,
    // HorseMD wrote / moved / deleted this file: never reuse its old hash.
    forgetHash: (path) => { if (path) hashCache.delete(path) }
  }
}
