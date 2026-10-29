import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { isSystemJunkPath } from './sync-ignore.js'

const INTERNAL_DIRS = new Set(['.horsemd', '.git', '.obsidian', 'node_modules'])

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isInternalRelativePath(path) {
  return path.split(/[\\/]/).some((segment) => INTERNAL_DIRS.has(segment))
}

// Hashes of files whose size, modification time, change time and file id
// (inode / Windows file index) have not changed since the last scan are
// reused — what Git compares too. Size + mtime alone is not enough: two files
// swapping names can carry each other's size and mtime (seen on Windows),
// while a rename changes the file id at that path and the ctime:
// automatic sync runs every few minutes and used to read every file of the
// folder, images included, each time. Per process, per absolute path.
const hashCache = new Map()
export const clearScanCache = () => hashCache.clear()

// Scan all ordinary files, including attachments, but never follow symlinks or
// include app-control directories. The result uses portable POSIX paths.
export async function scanLocalWorkspace(rootPath, { maxFiles = 20000 } = {}) {
  const files = new Map()
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory() && INTERNAL_DIRS.has(entry.name)) continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      // .DS_Store / Thumbs.db / desktop.ini / ._*: never synced (sync-ignore.js).
      if (isSystemJunkPath(entry.name)) continue
      if (files.size >= maxFiles) throw new Error(`同步文件数量超过上限（${maxFiles}）。`)
      const relativePath = relative(rootPath, fullPath)
      if (!relativePath || relativePath.startsWith(`..${sep}`) || isInternalRelativePath(relativePath)) continue
      const stat = await fs.stat(fullPath)
      const cached = hashCache.get(fullPath)
      const same = cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs &&
        cached.ctimeMs === stat.ctimeMs && cached.ino === stat.ino
      let hash = same ? cached.sha256 : null
      let size = stat.size
      if (!hash) {
        const bytes = await fs.readFile(fullPath)
        hash = sha256(bytes)
        size = bytes.byteLength
        // A file still being written (mtime moving) is hashed again next time.
        if (size === stat.size) hashCache.set(fullPath, { size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, sha256: hash })
      }
      files.set(relativePath.replace(/\\/g, '/'), {
        sha256: hash,
        size,
        mtimeMs: stat.mtimeMs
      })
    }
  }
  await walk(rootPath)
  return files
}

// Empty directories (#: S3 has no directories, so an empty folder only exists
// remotely as a "path/" marker object). Returns the leaf directories with no
// syncable entry at all, as POSIX paths. A folder with files (or with other
// folders) is implied by its contents and needs no marker.
export async function scanLocalEmptyDirs(rootPath) {
  const dirs = new Set()
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    let children = 0
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (INTERNAL_DIRS.has(entry.name)) continue
        children += 1
        await walk(join(dir, entry.name))
      } else if (entry.isFile() && !isSystemJunkPath(entry.name)) {
        // A folder holding only a .DS_Store is an empty folder to sync.
        children += 1
      }
    }
    const relativePath = relative(rootPath, dir)
    if (children === 0 && relativePath && !relativePath.startsWith(`..${sep}`) && !isInternalRelativePath(relativePath)) {
      dirs.add(relativePath.replace(/\\/g, '/'))
    }
  }
  await walk(rootPath)
  return dirs
}
