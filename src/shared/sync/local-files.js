import { isSystemJunkPath } from './sync-ignore.js'

// Local scan of a sync root, on any platform. The platform's `fs.scan(root)`
// walks the folder (never following symlinks, not descending into
// INTERNAL_DIRS) and lists every file and folder; this module decides what
// syncs and hashes the files.

export const INTERNAL_DIRS = new Set(['.horsemd', '.git', '.obsidian', 'node_modules'])

export function isInternalRelativePath(path) {
  return path.split(/[\\/]/).some((segment) => INTERNAL_DIRS.has(segment))
}

// Hashes of files whose `cacheKey` has not changed since the last scan are
// reused. The desktop key is size + modification time + change time + file
// id (inode / Windows file index) — what Git compares too. Size + mtime alone
// is not enough: two files swapping names can carry each other's size and
// mtime (seen on Windows), while a rename changes the file id at that path
// and the ctime. Automatic sync runs every few minutes and used to read every
// file of the folder, images included, each time. A platform without a stable
// key (no `cacheKey`) hashes every file on every scan.
// One cache per platform (per process), keyed by the file's full path.
export const createHashCache = () => new Map()

// Files that sync: ordinary files (attachments too), POSIX relative paths →
// { sha256, size, mtimeMs }. `platform`: { fs: { scan, readBytes }, hash: { sha256 } }.
// `entries`: a listing already made by platform.fs.scan(rootPath).
export async function scanLocalWorkspace(platform, rootPath, { maxFiles = 20000, cache = null, entries = null } = {}) {
  const files = new Map()
  const list = entries || await platform.fs.scan(rootPath)
  for (const entry of list) {
    if (entry.kind !== 'file') continue
    const name = entry.rel.split('/').pop()
    // .DS_Store / Thumbs.db / desktop.ini / ._*: never synced (sync-ignore.js).
    if (isSystemJunkPath(name)) continue
    if (files.size >= maxFiles) throw new Error(`同步文件数量超过上限（${maxFiles}）。`)
    if (!entry.rel || isInternalRelativePath(entry.rel)) continue
    const key = entry.abs ?? entry.rel
    const cached = cache && entry.cacheKey != null ? cache.get(key) : null
    let hash = cached && cached.cacheKey === entry.cacheKey ? cached.sha256 : null
    let size = entry.size
    if (!hash) {
      const bytes = await platform.fs.readBytes(entry.abs)
      hash = await platform.hash.sha256(bytes)
      size = bytes.byteLength
      // A file still being written (size moving) is hashed again next time.
      if (cache && entry.cacheKey != null && size === entry.size) cache.set(key, { cacheKey: entry.cacheKey, sha256: hash })
    }
    files.set(entry.rel, { sha256: hash, size, mtimeMs: entry.mtimeMs })
  }
  return files
}

// Empty directories (S3 has no directories, so an empty folder only exists
// remotely as a "path/" marker object). Returns the leaf directories with no
// syncable entry at all, as POSIX paths. A folder with files (or with other
// folders) is implied by its contents and needs no marker. A folder holding
// only a .DS_Store is an empty folder to sync.
export async function scanLocalEmptyDirs(platform, rootPath, { entries = null } = {}) {
  const list = entries || await platform.fs.scan(rootPath)
  const children = new Map()
  const parentOf = (rel) => {
    const cut = rel.lastIndexOf('/')
    return cut < 0 ? '' : rel.slice(0, cut)
  }
  for (const entry of list) {
    if (entry.kind === 'dir') {
      if (!children.has(entry.rel)) children.set(entry.rel, 0)
    } else if (entry.kind !== 'file' || isSystemJunkPath(entry.rel.split('/').pop())) {
      continue
    }
    const parent = parentOf(entry.rel)
    children.set(parent, (children.get(parent) || 0) + 1)
  }
  const dirs = new Set()
  for (const entry of list) {
    if (entry.kind !== 'dir') continue
    if (children.get(entry.rel) === 0 && entry.rel && !isInternalRelativePath(entry.rel)) dirs.add(entry.rel)
  }
  return dirs
}
