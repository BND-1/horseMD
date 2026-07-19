import { basename, dirname, extname, join } from 'node:path/posix'

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
    else if (item.type === 'deleteRemote' || item.type === 'deleteLocal') result.delete += 1
    return result
  }, { upload: 0, download: 0, delete: 0, conflict: 0, unchanged: 0 })

  return { operations, summary }
}
