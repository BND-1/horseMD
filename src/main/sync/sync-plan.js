import { basename, dirname, extname, join } from 'node:path/posix'
import { isSystemJunkPath } from './sync-ignore.js'

const normalizePath = (value) => String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

function asMap(entries) {
  if (!entries) return new Map()
  if (entries instanceof Map) return new Map(entries)
  return new Map(Object.entries(entries).map(([path, entry]) => [normalizePath(path), entry]))
}

const hashOf = (entry) => (entry?.sha256 ? String(entry.sha256) : null)

export function makeConflictPath(path, suffix) {
  const normalized = normalizePath(path)
  const directory = dirname(normalized)
  const extension = extname(normalized)
  const stem = basename(normalized, extension)
  const name = `${stem} (${suffix})${extension}`
  return directory === '.' ? name : join(directory, name)
}

function operation(type, path, details = {}) {
  return { type, path, ...details }
}

// A system file (.DS_Store…, sync-ignore.js) is never uploaded, downloaded or
// deleted locally. One already in the cloud (uploaded before this rule, or by
// an older HorseMD) is removed there — without a trash copy, it is not a note.
// Returns true when the path was handled.
function planSystemFile(operations, path, remoteEntry) {
  if (!isSystemJunkPath(path)) return false
  if (remoteEntry) operations.push(operation('deleteRemote', path, { remote: remoteEntry, systemFile: true }))
  return true
}

// Build a deterministic file-level plan. `previousEntries` represents the
// content hash at the last fully committed sync. A null hash means deletion.
// The engine intentionally never picks a silent winner for divergent changes.
export function buildSyncPlan({ localFiles, remoteFiles, previousEntries, conflictSuffix = 'conflict copy' }) {
  const local = asMap(localFiles)
  const remote = asMap(remoteFiles)
  const previous = asMap(previousEntries)
  const allPaths = new Set([...local.keys(), ...remote.keys(), ...previous.keys()])
  const operations = []

  for (const path of [...allPaths].sort()) {
    const localEntry = local.get(path) || null
    const remoteEntry = remote.get(path) || null
    const previousEntry = previous.get(path) || null
    if (planSystemFile(operations, path, remoteEntry)) continue
    const localHash = hashOf(localEntry)
    const remoteHash = hashOf(remoteEntry)
    const previousHash = hashOf(previousEntry)

    if (!previousEntry) {
      if (localHash && !remoteHash) operations.push(operation('upload', path, { local: localEntry, remote: remoteEntry }))
      else if (!localHash && remoteHash) operations.push(operation('download', path, { remote: remoteEntry }))
      else if (localHash === remoteHash) operations.push(operation('keep', path))
      else {
        operations.push(operation('conflict', path, {
          local: localEntry,
          remote: remoteEntry,
          conflictPath: makeConflictPath(path, conflictSuffix),
          reason: 'initial-divergence'
        }))
      }
      continue
    }

    const localChanged = localHash !== previousHash
    const remoteChanged = remoteHash !== previousHash
    if (!localChanged && !remoteChanged) {
      operations.push(operation('keep', path))
      continue
    }
    if (localChanged && !remoteChanged) {
      operations.push(localHash
        ? operation('upload', path, { local: localEntry, remote: remoteEntry })
        : operation('deleteRemote', path, { previous: previousEntry, remote: remoteEntry }))
      continue
    }
    if (!localChanged && remoteChanged) {
      operations.push(remoteHash
        ? operation('download', path, { remote: remoteEntry })
        : operation('deleteLocal', path, { previous: previousEntry }))
      continue
    }
    if (localHash === remoteHash) {
      operations.push(operation('keep', path))
      continue
    }
    operations.push(operation('conflict', path, {
      local: localEntry,
      remote: remoteEntry,
      conflictPath: makeConflictPath(path, conflictSuffix),
      reason: localHash && remoteHash ? 'both-modified' : 'delete-vs-modify'
    }))
  }

  const summary = operations.reduce((result, item) => {
    if (item.type === 'keep') result.unchanged += 1
    else if (item.type === 'upload') result.upload += 1
    else if (item.type === 'download') result.download += 1
    else if (item.systemFile) { /* system-file cleanup: not a deletion of the user's files */ }
    else if (item.type === 'deleteRemote' || item.type === 'deleteLocal') result.delete += 1
    else if (item.type === 'conflict') result.conflict += 1
    return result
  }, { upload: 0, download: 0, delete: 0, conflict: 0, unchanged: 0 })

  return { operations, summary }
}

// Directional recovery is intentionally separate from normal merge planning.
// A user chooses its source explicitly, so the planner never infers deletion
// intent from a missing manifest or an externally cleared remote folder.
export function buildDirectionalSyncPlan({ localFiles, remoteFiles, strategy }) {
  if (!['push', 'pull'].includes(strategy)) throw new Error('同步方向无效。')
  const local = asMap(localFiles)
  const remote = asMap(remoteFiles)
  const allPaths = new Set([...local.keys(), ...remote.keys()])
  const operations = []

  for (const path of [...allPaths].sort()) {
    const localEntry = local.get(path) || null
    const remoteEntry = remote.get(path) || null
    if (planSystemFile(operations, path, remoteEntry)) continue
    const localHash = hashOf(localEntry)
    const remoteHash = hashOf(remoteEntry)
    if (strategy === 'push') {
      if (localHash && remoteHash === localHash) operations.push(operation('keep', path))
      else if (localHash) operations.push(operation('upload', path, {
        local: localEntry,
        remote: remoteEntry,
        preserveRemote: Boolean(remoteEntry)
      }))
      else if (remoteHash) operations.push(operation('deleteRemote', path, { remote: remoteEntry }))
      continue
    }

    if (remoteHash && localHash === remoteHash) operations.push(operation('keep', path))
    else if (remoteHash) operations.push(operation('download', path, {
      local: localEntry,
      remote: remoteEntry,
      preserveLocal: Boolean(localEntry)
    }))
    else if (localHash) operations.push(operation('deleteLocal', path, { local: localEntry }))
  }

  const summary = operations.reduce((result, item) => {
    if (item.type === 'keep') result.unchanged += 1
    else if (item.type === 'upload') result.upload += 1
    else if (item.type === 'download') result.download += 1
    else if (item.systemFile) { /* system-file cleanup: not a deletion of the user's files */ }
    else if (item.type === 'deleteRemote' || item.type === 'deleteLocal') result.delete += 1
    return result
  }, { upload: 0, download: 0, delete: 0, conflict: 0, unchanged: 0 })

  return { operations, summary }
}

// Empty-directory plan (S3 has no directories: an empty folder is a "path/"
// marker object; WebDAV gets a real collection). `local` = empty leaf
// directories on disk, `remote` = the manifest's dirs, `previous` = dirs at
// the last committed sync. Folders that hold files need nothing: they come
// with their files. Deletions only ever remove EMPTY directories.
const asSet = (value) => new Set([...(value instanceof Set ? value : Array.isArray(value) ? value : Object.keys(value || {}))].map(normalizePath).filter(Boolean))
const holdsFile = (dir, paths) => {
  const prefix = `${dir}/`
  for (const path of paths) if (path.startsWith(prefix)) return true
  return false
}

export function buildDirPlan({ localDirs, remoteDirs, previousDirs, localFiles = [], remoteFiles = [], strategy = 'merge' }) {
  const local = asSet(localDirs)
  const remote = asSet(remoteDirs)
  const previous = asSet(previousDirs)
  const filePaths = [...asSet(localFiles), ...asSet(remoteFiles)]
  const operations = []
  for (const path of [...new Set([...local, ...remote, ...previous])].sort()) {
    const inLocal = local.has(path)
    const inRemote = remote.has(path)
    if (inLocal && inRemote) { operations.push(operation('keepDir', path)); continue }
    // A folder that has (or is about to get) files needs no marker.
    const implied = holdsFile(path, filePaths)
    if (strategy === 'push') {
      if (inLocal && !implied) operations.push(operation('createRemoteDir', path))
      else if (inRemote) operations.push(operation('deleteRemoteDir', path))
      continue
    }
    if (strategy === 'pull') {
      if (inRemote) operations.push(operation('createLocalDir', path))
      else if (inLocal) operations.push(operation('deleteLocalDir', path))
      continue
    }
    const wasSynced = previous.has(path)
    if (inLocal) {
      if (!wasSynced && !implied) operations.push(operation('createRemoteDir', path))
      // Synced before, gone remotely: removed on another device — unless it
      // just received files there (then it simply is no longer an empty
      // folder: forget it, delete nothing).
      else if (wasSynced) operations.push(operation(implied ? 'forgetDir' : 'deleteLocalDir', path))
    } else if (inRemote) {
      // Synced before, gone (or no longer empty) here. A folder that now
      // holds files keeps its marker untouched (some services delete
      // "folder/" recursively); only a folder removed here is removed there.
      if (wasSynced) operations.push(operation(implied ? 'forgetDir' : 'deleteRemoteDir', path))
      else operations.push(operation('createLocalDir', path))
    }
  }
  return operations
}

// Counted like files in the summary / confirmation: creating a folder in the
// cloud is an upload, creating it here a download, removing one a delete.
export const DIR_OPERATION_TYPES = new Set(['createRemoteDir', 'createLocalDir', 'deleteRemoteDir', 'deleteLocalDir', 'forgetDir'])
export const DIR_SUMMARY_KEY = {
  createRemoteDir: 'upload',
  createLocalDir: 'download',
  deleteRemoteDir: 'delete',
  deleteLocalDir: 'delete'
}
