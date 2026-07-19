import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const INTERNAL_DIRS = new Set(['.horsemd', '.git', '.obsidian', 'node_modules'])

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isInternalRelativePath(path) {
  return path.split(/[\\/]/).some((segment) => INTERNAL_DIRS.has(segment))
}

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
      if (files.size >= maxFiles) throw new Error(`同步文件数量超过上限（${maxFiles}）。`)
      const relativePath = relative(rootPath, fullPath)
      if (!relativePath || relativePath.startsWith(`..${sep}`) || isInternalRelativePath(relativePath)) continue
      const [bytes, stat] = await Promise.all([fs.readFile(fullPath), fs.stat(fullPath)])
      files.set(relativePath.replace(/\\/g, '/'), {
        sha256: sha256(bytes),
        size: bytes.byteLength,
        mtimeMs: stat.mtimeMs
      })
    }
  }
  await walk(rootPath)
  return files
}
