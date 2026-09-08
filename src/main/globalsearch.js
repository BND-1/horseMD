// Workspace-wide content search IPC (issue #120: 全局搜索). The pure matching
// logic lives in globalsearch-core.js; this module owns the filesystem side:
// enumerating markdown files per workspace root (reusing the tree scanner so
// the search scope is exactly what the sidebar shows), reading contents with
// an mtime-validated cache, and answering `search:workspace` requests.
//
// Guards: only absolute, non-restricted roots are scanned (the same
// isRestrictedWatchRoot rule the chokidar watchers use — never recurse into
// /dev, /System/Volumes, … from a relative path resolved against `/`).
// Results are capped by SEARCH_LIMITS; the renderer additionally drops stale
// responses (latest-request-only on its side).
import fs from 'node:fs/promises'
import { listMarkdownFiles } from './filesystem.js'
import { isRestrictedWatchRoot } from './watchers.js'
import { SEARCH_LIMITS, searchFiles } from './globalsearch-core.js'

const FILE_LIST_TTL_MS = 15_000
const CONTENT_CACHE_MAX_ENTRIES = 800
const CONTENT_CACHE_MAX_BYTES = 64 * 1024 * 1024
const READ_BATCH = 16

// root → { at, files } — the scanned file list is reused across keystrokes.
const fileListCache = new Map()
// path → { mtimeMs, size, content } — survives until evicted or invalidated.
const contentCache = new Map()
let contentCacheBytes = 0

const sanitizeRoots = (roots) =>
  Array.isArray(roots)
    ? [...new Set(roots.filter((root) => typeof root === 'string' && !isRestrictedWatchRoot(root)))]
    : []

async function listFilesForRoot(root, showHidden, markdownPattern) {
  const cached = fileListCache.get(root)
  if (cached && Date.now() - cached.at < FILE_LIST_TTL_MS) return cached.files
  const files = await listMarkdownFiles(root, { showHidden, markdownPattern })
  fileListCache.set(root, { at: Date.now(), files })
  return files
}

function cachePut(path, stat, content) {
  const previous = contentCache.get(path)
  if (previous) {
    contentCacheBytes -= previous.content.length
    contentCache.delete(path)
  }
  contentCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, content })
  contentCacheBytes += content.length
  // Evict oldest-inserted entries (Map preserves insertion order) until both
  // caps are back under their limits.
  while (
    (contentCache.size > CONTENT_CACHE_MAX_ENTRIES || contentCacheBytes > CONTENT_CACHE_MAX_BYTES) &&
    contentCache.size > 0
  ) {
    const oldest = contentCache.keys().next().value
    const entry = contentCache.get(oldest)
    contentCacheBytes -= entry ? entry.content.length : 0
    contentCache.delete(oldest)
  }
}

async function readCached(file) {
  let stat
  try {
    stat = await fs.stat(file.path)
  } catch {
    return '' // moved/deleted between scan and read — skip it
  }
  if (stat.size > SEARCH_LIMITS.maxFileSize) return ''
  const cached = contentCache.get(file.path)
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    // Refresh insertion order so actively-searched files survive eviction.
    contentCache.delete(file.path)
    contentCache.set(file.path, cached)
    return cached.content
  }
  let content
  try {
    content = await fs.readFile(file.path, 'utf8')
  } catch {
    return ''
  }
  cachePut(file.path, stat, content)
  return content
}

export async function searchWorkspace({ roots, query, showHidden }, { markdownPattern }) {
  const safeRoots = sanitizeRoots(roots)
  if (!safeRoots.length || typeof query !== 'string' || !query.trim()) {
    return { ok: true, terms: [], files: [], truncated: false, matchTotal: 0, scanned: 0 }
  }

  const entries = []
  const scanned = { count: 0 }
  for (const root of safeRoots) {
    const files = await listFilesForRoot(root, Boolean(showHidden), markdownPattern)
    scanned.count += files.length
    for (let index = 0; index < files.length; index += READ_BATCH) {
      const batch = files.slice(index, index + READ_BATCH)
      const contents = await Promise.all(batch.map((file) => readCached(file)))
      batch.forEach((file, i) => {
        if (contents[i]) entries.push({ ...file, content: contents[i] })
      })
    }
  }

  const { terms, files, truncated, matchTotal } = searchFiles(entries, query)
  return { ok: true, terms, files, truncated, matchTotal, scanned: scanned.count }
}

export function registerGlobalSearchIpc(ipcMain, { markdownPattern }) {
  ipcMain.handle('search:workspace', (_event, request) =>
    searchWorkspace(request || {}, { markdownPattern })
  )
}
