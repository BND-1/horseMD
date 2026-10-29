import fs from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { scanLocalEmptyDirs, scanLocalWorkspace, sha256 } from './local-files.js'
import { buildDirPlan, buildDirectionalSyncPlan, buildSyncPlan, DIR_OPERATION_TYPES, DIR_SUMMARY_KEY, makeConflictPath } from './sync-plan.js'
import { readSyncState, writeSyncState } from './sync-state.js'
import { isSyncStopped } from './sync-control.js'
import { isSystemJunkPath } from './sync-ignore.js'
import { conflictSuffixFor } from './conflict-name.js'

const MANIFEST_VERSION = 1
const now = () => new Date().toISOString()
const manifestPath = '.horsemd/manifest.json'
const trashPath = (stamp, path) => `.horsemd/trash/${stamp}/${path}`

function normalizeManifest(input, workspaceId) {
  if (!input) return { version: MANIFEST_VERSION, workspaceId, files: {}, tombstones: {}, dirs: {} }
  if (input.version !== MANIFEST_VERSION || input.workspaceId !== workspaceId) {
    throw new Error('远端同步目录不是当前 HorseMD 工作区。')
  }
  return {
    version: MANIFEST_VERSION,
    workspaceId,
    files: input.files && typeof input.files === 'object' ? input.files : {},
    tombstones: input.tombstones && typeof input.tombstones === 'object' ? input.tombstones : {},
    // Empty folders (S3 "path/" markers / WebDAV collections).
    dirs: input.dirs && typeof input.dirs === 'object' ? input.dirs : {}
  }
}

async function readRemoteManifest(provider, workspaceId) {
  const remote = await provider.get(manifestPath)
  if (!remote) return { manifest: normalizeManifest(null, workspaceId), revision: null, exists: false }
  let parsed
  try {
    parsed = JSON.parse(remote.bytes.toString('utf8'))
  } catch {
    throw new Error('远端同步清单已损坏，已停止同步以保护文件。')
  }
  return { manifest: normalizeManifest(parsed, workspaceId), revision: remote.revision, exists: true }
}

function publicOperation(operation) {
  const { local, remote, previous, ...safe } = operation
  return safe
}

function summaryWithBytes(plan) {
  return plan.operations.reduce((summary, item) => {
    if (item.type === 'upload') summary.uploadBytes += item.local?.size || 0
    if (item.type === 'download') summary.downloadBytes += item.remote?.size || 0
    return summary
  }, { ...plan.summary, uploadBytes: 0, downloadBytes: 0 })
}

function assertSafeRelative(rootPath, relativePath) {
  const target = resolve(rootPath, relativePath)
  const rel = relative(rootPath, target)
  if (!rel || rel.startsWith('..') || resolve(rootPath) === target) throw new Error('同步文件路径无效。')
  return target
}

async function readLocalBytes(rootPath, relativePath) {
  return fs.readFile(assertSafeRelative(rootPath, relativePath))
}

function verifyRemoteBytes(path, expected, bytes) {
  if (expected?.sha256 && sha256(bytes) !== expected.sha256) {
    throw new Error(`远端文件“${path}”已在同步期间变化，请重新同步。`)
  }
}

function hasFiles(value) {
  return Object.keys(value || {}).length > 0
}

function isRemoteReset(remote, state) {
  if (!hasFiles(state.files)) return false
  if (!remote.exists) return true
  // An in-app deletion leaves a tombstone. An empty manifest without one is an
  // external reset/replace, not evidence that this device should delete files.
  return !hasFiles(remote.manifest.files) && !hasFiles(remote.manifest.tombstones)
}

async function writeLocalBytes(rootPath, relativePath, bytes) {
  const target = assertSafeRelative(rootPath, relativePath)
  await fs.mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temp, bytes)
  await fs.rename(temp, target)
}

async function moveLocalToTrash(rootPath, relativePath, stamp) {
  const source = assertSafeRelative(rootPath, relativePath)
  const target = join(rootPath, '.horsemd', 'trash', stamp, relativePath)
  try {
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.rename(source, target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

// An empty folder, or one holding only system files (.DS_Store…, which are
// never synced): Finder writes a .DS_Store into a folder just by showing it,
// and the folder would then never go away.
async function removeEmptyLocalDir(target) {
  try {
    await fs.rmdir(target)
  } catch (error) {
    if (!['ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error
    const entries = await fs.readdir(target, { withFileTypes: true })
    if (!entries.length || !entries.every((entry) => entry.isFile() && isSystemJunkPath(entry.name))) throw error
    for (const entry of entries) await fs.unlink(join(target, entry.name))
    await fs.rmdir(target)
  }
}

const isDeletion = (item) => (item.type === 'deleteLocal' || item.type === 'deleteRemote' ? 1 : 0)


// Is the local file still what the plan saw? A file saved after the scan
// (sync can wait minutes for a throttled service) must never be overwritten
// or removed by this run. `plannedSha` null = the plan saw no file there.
async function localStillAsPlanned(rootPath, relativePath, plannedSha) {
  let bytes
  try {
    bytes = await fs.readFile(assertSafeRelative(rootPath, relativePath))
  } catch (error) {
    if (error?.code === 'ENOENT') return !plannedSha
    throw error
  }
  return Boolean(plannedSha) && sha256(bytes) === plannedSha
}

// Operations an automatic (safeOnly) run leaves for the user: deletions of
// the user's files and conflicts. Everything else runs.
const isHeldInSafeMode = (item) => (
  (item.type === 'deleteRemote' && !item.systemFile) ||
  item.type === 'deleteLocal' ||
  item.type === 'conflict' ||
  item.type === 'deleteRemoteDir' ||
  item.type === 'deleteLocalDir'
)
// Operations that write or remove the local file at item.path.
const touchesLocalFile = (item) => ['download', 'deleteLocal', 'conflict'].includes(item.type)

// After a file deleted on another device is moved out of its folder: the
// folders it leaves empty go too, deepest first, up to (never including) the
// workspace root. Otherwise a renamed or deleted folder stayed here empty,
// the next sync took it for a new empty folder and sent it back to the cloud
// and every device. Only empty folders (or system files only) are removed;
// one that still holds anything stops the walk. A folder the cloud keeps as
// an empty folder is created again by the folder step that runs afterwards.
async function removeEmptiedParents(rootPath, relativePath) {
  const parts = String(relativePath).replace(/\\/g, '/').split('/').filter(Boolean)
  for (let depth = parts.length - 1; depth > 0; depth -= 1) {
    const dir = parts.slice(0, depth).join('/')
    if (dir === '.horsemd' || dir.startsWith('.horsemd/')) return
    try {
      await removeEmptyLocalDir(assertSafeRelative(rootPath, dir))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      return
    }
  }
}

// The cloud side of the same: folders whose last file this run deleted there.
// WebDAV folders are real collections, and some S3 services (数据胶囊)
// create a "folder/" object for every folder a key passes through, so a
// renamed folder stayed in the cloud, empty. Deepest first; a folder that
// still lists anything (removeDirectory checks right before deleting) or is
// kept as an empty folder is left alone. Best effort: a failure here never
// fails the sync, it only leaves an empty folder behind as before.
async function removeEmptiedRemoteParents(provider, deletedPaths, manifest, keepDirs) {
  if (typeof provider.removeDirectory !== 'function') return
  const candidates = new Set()
  for (const path of deletedPaths) {
    const parts = String(path).split('/').filter(Boolean)
    for (let depth = parts.length - 1; depth > 0; depth -= 1) candidates.add(parts.slice(0, depth).join('/'))
  }
  const remaining = Object.keys(manifest.files)
  const holdsFile = (dir) => remaining.some((path) => path.startsWith(`${dir}/`))
  const ordered = [...candidates].sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b))
  for (const dir of ordered) {
    if (dir === '.horsemd' || dir.startsWith('.horsemd/')) continue
    if (keepDirs.has(dir) || manifest.dirs[dir] || holdsFile(dir)) continue
    try {
      await provider.removeDirectory(dir)
    } catch (error) {
      if (isSyncStopped(error)) throw error
    }
  }
}

// Before a cloud file is deleted or replaced, a copy goes to the cloud trash
// (.horsemd/trash/<stamp>/…), and the file must still be the version this
// sync planned for. Returns { revision } of the file, or null when it is gone.
// - Server-side copy first (S3 CopyObject, as rclone's --backup-dir does):
//   nothing is downloaded. Accepted only when the copy reports the planned
//   ETag; a provider without copy, or a copy that cannot prove the version,
//   falls back to download + compare + upload.
// - #161: 七牛 never answered the GET of one image, so deleting a folder
//   locally stopped the sync at its backup.
async function backupRemoteToTrash(provider, path, expected, stamp) {
  const target = trashPath(stamp, path)
  let copied = false
  if (typeof provider.copy === 'function' && expected?.revision) {
    let result
    try {
      result = await provider.copy(path, target, { revision: expected.revision })
    } catch (error) {
      if (!error?.copyUnsupported) throw error
      result = undefined
    }
    if (result === null) return null
    if (result?.revision && result.revision === expected.revision) return { revision: expected.revision }
    copied = result !== undefined
  }
  const existing = await provider.get(path)
  if (!existing) return null
  verifyRemoteBytes(path, expected, existing.bytes)
  // A copy whose ETag could not prove the version (some services re-tag
  // copies) is replaced by the bytes just verified.
  await provider.put(target, existing.bytes, copied ? {} : { createOnly: true })
  return { revision: existing.revision }
}

async function archiveRemoteToTrash(provider, item, stamp) {
  await backupRemoteToTrash(provider, item.path, item.remote || item.previous, stamp)
}

export class SyncEngine {
  constructor({ userDataPath, provider, rootPath, workspaceId, deviceName = 'this device', onProgress = null, control = null, busyPaths = [] }) {
    this.userDataPath = userDataPath
    this.provider = provider
    this.rootPath = rootPath
    this.workspaceId = workspaceId
    this.deviceName = deviceName
    this.onProgress = onProgress
    // Optional SyncControl: pause / resume / stop between files.
    this.control = control
    // Relative paths of files open with unsaved edits in the editor: this run
    // never downloads over, deletes or conflict-replaces them (the save that
    // follows would overwrite the other device's version). Lower-cased:
    // macOS / Windows disks are case-insensitive.
    this.busyPaths = new Set([...busyPaths].map((path) => String(path).replace(/\\/g, '/').toLowerCase()))
  }

  isBusy(path) {
    return this.busyPaths.has(String(path).toLowerCase())
  }

  // A free conflict-copy path: neither on disk, in the cloud manifest, nor
  // handed out earlier in this run (case-insensitive).
  async freeConflictPath(path, suffix, taken) {
    for (let n = 1; n < 100; n += 1) {
      const candidate = makeConflictPath(path, n === 1 ? suffix : `${suffix} ${n}`)
      if (taken.has(candidate.toLowerCase())) continue
      taken.add(candidate.toLowerCase())
      try {
        await fs.access(assertSafeRelative(this.rootPath, candidate))
        continue
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      return candidate
    }
    throw new Error(`“${path}”的冲突副本太多，请先整理后再同步。`)
  }

  // Writes the conflict copy locally and to the cloud under a free name; a
  // name taken in the cloud by an object the manifest does not list moves on
  // to the next name. Returns { path, revision }.
  async writeConflictCopy(path, bytes, taken) {
    const suffix = conflictSuffixFor(this.deviceName)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = await this.freeConflictPath(path, suffix, taken)
      let uploaded
      try {
        uploaded = await this.provider.put(candidate, bytes, { createOnly: true })
      } catch (error) {
        if (isSyncStopped(error)) throw error
        let existing = null
        try { existing = await this.provider.get(candidate) } catch (readError) { throw isSyncStopped(readError) ? readError : error }
        if (!existing) throw error
        continue
      }
      await writeLocalBytes(this.rootPath, candidate, bytes)
      return { path: candidate, revision: uploaded.revision }
    }
    throw new Error(`无法为“${path}”保存冲突副本，请重新同步。`)
  }

  async preview(strategy = 'merge') {
    if (!['merge', 'push', 'pull'].includes(strategy)) throw new Error('同步方向无效。')
    const [localFiles, localDirs, state, remote] = await Promise.all([
      scanLocalWorkspace(this.rootPath),
      scanLocalEmptyDirs(this.rootPath),
      readSyncState(this.userDataPath, this.workspaceId),
      readRemoteManifest(this.provider, this.workspaceId)
    ])
    if (strategy === 'merge' && isRemoteReset(remote, state)) {
      return {
        status: 'remote-reset',
        strategy,
        localFiles,
        state,
        remote,
        plan: null,
        summary: { upload: 0, download: 0, delete: 0, conflict: 0, unchanged: 0, uploadBytes: 0, downloadBytes: 0 },
        operations: []
      }
    }
    const plan = strategy === 'merge'
      ? buildSyncPlan({
        localFiles,
        remoteFiles: remote.manifest.files,
        previousEntries: state.files,
        conflictSuffix: conflictSuffixFor(this.deviceName)
      })
      : buildDirectionalSyncPlan({ localFiles, remoteFiles: remote.manifest.files, strategy })
    // Deletions run before everything else. On a case-insensitive disk
    // (macOS, Windows) a case-only rename — notes/ → Notes/ — is a download of
    // "Notes/a.md" plus a delete of "notes/a.md": the same file. Download
    // first wrote into it and the delete then moved the only copy to the
    // trash; the next sync sent that deletion to the cloud and every device
    // (it only worked when the new name sorted after the old one). Same on a
    // case-insensitive WebDAV server for upload + deleteRemote.
    plan.operations.sort((a, b) => isDeletion(b) - isDeletion(a))
    // Empty folders run after the files (a folder that just received a file
    // is no longer empty and is never removed).
    // Files that still exist once the file operations are done: a folder
    // whose last file is being deleted becomes an empty folder to keep.
    const remainingFiles = new Set([...localFiles.keys(), ...Object.keys(remote.manifest.files)])
    for (const item of plan.operations) if (item.type === 'deleteRemote' || item.type === 'deleteLocal') remainingFiles.delete(item.path)
    const dirOperations = buildDirPlan({
      localDirs,
      remoteDirs: remote.manifest.dirs,
      previousDirs: state.dirs,
      localFiles: [...remainingFiles],
      strategy
    })
    for (const item of dirOperations) {
      plan.operations.push(item)
      if (DIR_SUMMARY_KEY[item.type]) plan.summary[DIR_SUMMARY_KEY[item.type]] += 1
    }
    return {
      status: 'ready',
      strategy,
      localFiles,
      localDirs,
      state,
      remote,
      plan,
      summary: summaryWithBytes(plan),
      operations: plan.operations.map(publicOperation)
    }
  }

  // One empty-folder operation. `dirs` collects the folders known on both
  // sides for the final state; `previousDirs` is updated in step for a
  // stopped run's partial commit.
  async syncDirectory(item, manifest, dirs, previousDirs) {
    if (item.type === 'createRemoteDir') {
      await this.provider.createDirectory(item.path)
      manifest.dirs[item.path] = { updatedAt: now() }
      dirs.add(item.path); previousDirs.add(item.path)
    } else if (item.type === 'createLocalDir') {
      await fs.mkdir(assertSafeRelative(this.rootPath, item.path), { recursive: true })
      dirs.add(item.path); previousDirs.add(item.path)
    } else if (item.type === 'deleteRemoteDir') {
      await this.provider.removeDirectory(item.path)
      delete manifest.dirs[item.path]
      dirs.delete(item.path); previousDirs.delete(item.path)
    } else if (item.type === 'forgetDir') {
      // No longer an empty folder (it holds files): stop tracking, touch nothing.
      delete manifest.dirs[item.path]
      dirs.delete(item.path); previousDirs.delete(item.path)
    } else if (item.type === 'deleteLocalDir') {
      try {
        // rmdir, never recursive: a folder that received anything stays.
        await removeEmptyLocalDir(assertSafeRelative(this.rootPath, item.path))
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error
      }
      dirs.delete(item.path); previousDirs.delete(item.path)
    }
  }

  // `safeOnly` (automatic sync): the plan is the one computed here, right
  // before running — never one the window previewed minutes ago. A plan
  // that deletes or has a conflict is not run ({ needsConfirmation }), and
  // one with nothing to do returns { idle } without touching the cloud (no
  // manifest PUT every few minutes; 数据胶囊 limits PUTs).
  async execute(preview = null, strategy = 'merge', { safeOnly = false } = {}) {
    const prepared = preview || await this.preview(strategy)
    if (safeOnly && prepared.status !== 'ready') return { needsConfirmation: true, reason: prepared.status, summary: prepared.summary }
    if (prepared.status !== 'ready') {
      throw new Error('云端工作区已被清空或替换。请明确选择上传本地或下载云端，HorseMD 不会自动删除本地文件。')
    }
    const { localFiles, state, remote, plan } = prepared
    // Paths this run leaves exactly as they were (state entry, manifest
    // entry, local file): automatic runs hold deletions and conflicts for the
    // user; files open with unsaved edits, or saved after the scan, are
    // deferred. The next run sees them again (a deferred download becomes a
    // conflict once the local file has changed).
    const held = { delete: 0, conflict: 0 }
    const untouched = new Set()
    const untouchedDirs = new Set()
    const deferred = []
    const skip = (item) => {
      if (DIR_OPERATION_TYPES.has(item.type)) untouchedDirs.add(item.path)
      else untouched.add(item.path)
    }
    if (safeOnly) {
      for (const item of plan.operations) {
        if (!isHeldInSafeMode(item)) continue
        item.held = true
        skip(item)
        if (item.type === 'conflict') held.conflict += 1
        else held.delete += 1
      }
    }
    for (const item of plan.operations) {
      if (item.held || !touchesLocalFile(item) || !this.isBusy(item.path)) continue
      item.deferred = true
      skip(item)
      deferred.push(item.path)
    }
    const runnable = (item) => !item.held && !item.deferred && !['keep', 'keepDir', 'forgetDir'].includes(item.type)
    const extra = { ...(held.delete || held.conflict ? { held } : {}), ...(deferred.length ? { deferred } : {}) }
    if (safeOnly && !plan.operations.some(runnable)) {
      return held.delete || held.conflict
        ? { needsConfirmation: true, reason: 'changes', summary: prepared.summary, ...extra }
        : { idle: true, summary: prepared.summary, ...extra }
    }
    // Empty folders present on both sides after this run.
    const dirs = new Set(plan.operations.filter((item) => item.type === 'keepDir').map((item) => item.path))
    const previousDirs = new Set(state.dirs || [])
    const manifest = structuredClone(remote.manifest)
    const stamp = now().replace(/[:.]/g, '-')
    const files = new Map(localFiles)
    const total = plan.operations.filter(runnable).length
    // Conflict-copy names already in use (lower-cased).
    const takenNames = new Set([...localFiles.keys(), ...Object.keys(remote.manifest.files)].map((path) => path.toLowerCase()))
    let completed = 0
    this.onProgress?.({ completed, total })

    // Paths whose local and remote sides are known to agree after this run
    // (for a stopped run's partial commit).
    const settled = new Set(plan.operations.filter((item) => item.type === 'keep').map((item) => item.path))
    const progress = (item) => {
      completed += 1
      settled.add(item.path)
      this.onProgress?.({ completed, total, type: item.type, path: item.path })
    }
    // Remote folders emptied by this run's deletions, cleaned once right
    // after the deletions (they run first) — before any upload: on a
    // case-insensitive server, Notes/a.md uploaded while the emptied notes/
    // still existed landed in notes/ (old case kept on the server).
    const deletedRemote = []
    const keepDirs = new Set(plan.operations.filter((item) => ['keepDir', 'createRemoteDir'].includes(item.type)).map((item) => item.path))
    let remotePruned = false
    const pruneRemote = async () => {
      if (remotePruned) return
      remotePruned = true
      if (deletedRemote.length) await removeEmptiedRemoteParents(this.provider, deletedRemote, manifest, keepDirs)
    }
    try {
    for (const item of plan.operations) {
      if (item.type === 'keep' || item.type === 'keepDir' || item.held || item.deferred) continue
      await this.control?.checkpoint()
      // Saved after the scan? Then this run leaves the file alone (R9 in
      // docs/cloud-sync-review.md: the download used to overwrite it).
      if (touchesLocalFile(item) && !item.preserveLocal &&
        !(await localStillAsPlanned(this.rootPath, item.path, localFiles.get(item.path)?.sha256 || null))) {
        item.deferred = true
        skip(item)
        deferred.push(item.path)
        extra.deferred = deferred
        completed += 1
        this.onProgress?.({ completed, total, type: item.type, path: item.path, deferred: true })
        continue
      }
      if (!isDeletion(item)) await pruneRemote()
      if (DIR_OPERATION_TYPES.has(item.type)) {
        await this.syncDirectory(item, manifest, dirs, previousDirs)
        if (item.type !== 'forgetDir') progress(item)
        continue
      }
      if (item.type === 'upload') {
        if (item.preserveRemote) await archiveRemoteToTrash(this.provider, item, stamp)
        const bytes = await readLocalBytes(this.rootPath, item.path)
        // The manifest records the bytes actually uploaded: a save after the
        // scan made it record the scanned hash, and the other device then
        // failed every download of the file ("已在同步期间变化", R5).
        const uploadedSha = sha256(bytes)
        let uploaded
        try {
          uploaded = await this.provider.put(item.path, bytes, {
            revision: item.remote?.revision || null,
            createOnly: !item.remote
          })
        } catch (error) {
          if (isSyncStopped(error)) throw error
          let untracked = null
          try { untracked = await this.provider.get(item.path) } catch (readError) { throw isSyncStopped(readError) ? readError : error }
          if (!untracked) throw error
          if (sha256(untracked.bytes) === sha256(bytes)) {
            // An interrupted sync (e.g. stopped by HTTP 429) uploaded this file
            // but never wrote the manifest. Same bytes: adopt the object, so a
            // retry resumes instead of failing on every uploaded file.
            // Same for a modified file: the object already holds these bytes,
            // only the manifest still names the older revision.
            uploaded = { revision: untracked.revision }
          } else if (item.remote) {
            throw error
          } else {
            // A reset remote may have lost its manifest while retaining ordinary
            // objects. This path is available only after an explicit push; retain
            // the untracked object before replacing it with the local source.
            if (prepared.strategy !== 'push') throw error
            await this.provider.put(trashPath(stamp, item.path), untracked.bytes, { createOnly: true })
            uploaded = await this.provider.put(item.path, bytes, { revision: untracked.revision })
          }
        }
        manifest.files[item.path] = { ...item.local, sha256: uploadedSha, size: bytes.byteLength, revision: uploaded.revision, updatedAt: now() }
        delete manifest.tombstones[item.path]
        files.set(item.path, { ...(files.get(item.path) || item.local), sha256: uploadedSha, size: bytes.byteLength })
      } else if (item.type === 'download') {
        if (item.preserveLocal) await moveLocalToTrash(this.rootPath, item.path, stamp)
        const remoteFile = await this.provider.get(item.path)
        if (!remoteFile) throw new Error(`远端文件“${item.path}”在同步中消失，请重新同步。`)
        verifyRemoteBytes(item.path, item.remote, remoteFile.bytes)
        await writeLocalBytes(this.rootPath, item.path, remoteFile.bytes)
        files.set(item.path, { ...item.remote, sha256: sha256(remoteFile.bytes) })
      } else if (item.type === 'deleteRemote' && item.systemFile) {
        // A .DS_Store (…) in the cloud: removed without a trash copy. Never
        // fails the sync — if it cannot be removed now, it stays listed and
        // the next sync tries again.
        let removed = false
        try {
          removed = await this.provider.delete(item.path, { revision: item.remote?.revision || null })
        } catch (error) {
          if (isSyncStopped(error)) throw error
        }
        if (removed) {
          delete manifest.files[item.path]
          manifest.tombstones[item.path] = { deletedAt: now() }
        }
      } else if (item.type === 'deleteRemote') {
        const existing = await backupRemoteToTrash(this.provider, item.path, item.remote || item.previous, stamp)
        if (existing) await this.provider.delete(item.path, { revision: existing.revision })
        delete manifest.files[item.path]
        manifest.tombstones[item.path] = { deletedAt: now() }
        files.delete(item.path)
        deletedRemote.push(item.path)
      } else if (item.type === 'deleteLocal') {
        await moveLocalToTrash(this.rootPath, item.path, stamp)
        await removeEmptiedParents(this.rootPath, item.path)
        files.delete(item.path)
      } else if (item.type === 'conflict') {
        // The remote original becomes canonical. The local modification is kept
        // as a normal conflict copy on both sides, never silently discarded.
        if (item.local && item.remote) {
          const localBytes = await readLocalBytes(this.rootPath, item.path)
          const remoteBytes = await this.provider.get(item.path)
          if (!remoteBytes) throw new Error(`远端冲突文件“${item.path}”在同步中消失。`)
          verifyRemoteBytes(item.path, item.remote, remoteBytes.bytes)
          const copy = await this.writeConflictCopy(item.path, localBytes, takenNames)
          const localConflict = copy.path
          const uploadedConflict = copy
          // The local file must still be the bytes copied just now.
          if (sha256(await readLocalBytes(this.rootPath, item.path)) !== sha256(localBytes)) {
            throw new Error(`“${item.path}”在同步中又被修改，请重新同步。`)
          }
          await writeLocalBytes(this.rootPath, item.path, remoteBytes.bytes)
          files.set(item.path, { ...item.remote, sha256: sha256(remoteBytes.bytes) })
          files.set(localConflict, { sha256: sha256(localBytes), size: localBytes.byteLength, mtimeMs: Date.now() })
          settled.add(localConflict)
          manifest.files[localConflict] = {
            sha256: sha256(localBytes), size: localBytes.byteLength, revision: uploadedConflict.revision, updatedAt: now()
          }
        } else if (item.remote) {
          const remoteBytes = await this.provider.get(item.path)
          if (!remoteBytes) throw new Error(`远端冲突文件“${item.path}”在同步中消失。`)
          verifyRemoteBytes(item.path, item.remote, remoteBytes.bytes)
          await writeLocalBytes(this.rootPath, item.path, remoteBytes.bytes)
          files.set(item.path, { ...item.remote, sha256: sha256(remoteBytes.bytes) })
        } else if (item.local) {
          const localBytes = await readLocalBytes(this.rootPath, item.path)
          const copy = await this.writeConflictCopy(item.path, localBytes, takenNames)
          const localConflict = copy.path
          const uploadedConflict = copy
          await moveLocalToTrash(this.rootPath, item.path, stamp)
          files.delete(item.path)
          files.set(localConflict, { sha256: sha256(localBytes), size: localBytes.byteLength, mtimeMs: Date.now() })
          settled.add(localConflict)
          manifest.files[localConflict] = {
            sha256: sha256(localBytes), size: localBytes.byteLength, revision: uploadedConflict.revision, updatedAt: now()
          }
        }
      }
      progress(item)
    }
    await pruneRemote()
    } catch (error) {
      if (!isSyncStopped(error)) throw error
      // Stopped by the user: record what was completed, so the next sync
      // continues from here. Unfinished paths keep their previous state and
      // manifest entries (exactly as before this run).
      let recorded = false
      if (completed > 0) {
        if (this.control) this.control.finalizing = true
        const partial = { ...state.files }
        for (const path of settled) {
          const entry = files.get(path)
          if (entry?.sha256) partial[path] = { sha256: entry.sha256 }
          else delete partial[path]
        }
        // Short retries only (a stop usually happens during an upload lock).
        // The local state is written only after the manifest: the two must
        // agree, or the next sync would take this device's new files for
        // remote changes. Without them the next sync still resumes (identical
        // objects are adopted).
        try {
          const written = await this.provider.put(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), {
            revision: remote.revision,
            createOnly: !remote.exists,
            contentType: 'application/json',
            quick: true
          })
          if (!written?.throttled) {
            await writeSyncState(this.userDataPath, { version: 1, workspaceId: this.workspaceId, files: partial, dirs: [...previousDirs] })
            recorded = true
          }
        } catch { /* the next sync resumes from the objects themselves */ }
      }
      return { stopped: true, recorded, completed, total, summary: summaryWithBytes(plan), conflicts: plan.summary.conflict }
    }

    const nextFiles = Object.fromEntries([...files].map(([path, entry]) => [path, { sha256: entry.sha256 }]))
    for (const path of untouched) {
      if (state.files[path]) nextFiles[path] = state.files[path]
      else delete nextFiles[path]
    }
    for (const path of untouchedDirs) {
      if (previousDirs.has(path)) dirs.add(path)
      else dirs.delete(path)
    }
    const nextState = {
      version: 1,
      workspaceId: this.workspaceId,
      files: nextFiles,
      dirs: [...dirs].sort()
    }
    // The manifest is committed last. If another device changed it, conditional
    // write fails before local state advances, so the next run re-plans safely.
    try {
      await this.provider.put(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), {
        revision: remote.revision,
        createOnly: !remote.exists,
        contentType: 'application/json'
      })
    } catch (error) {
      if (isSyncStopped(error)) throw error
      // Another device committed first (both synced at once). Tagged so the
      // caller re-plans and runs again right away instead of showing an
      // error (R6); the objects uploaded here are adopted on the next run.
      let latest = null
      try { latest = await readRemoteManifest(this.provider, this.workspaceId) } catch { /* report the original error */ }
      if (latest && latest.revision !== remote.revision) {
        const changed = new Error('云端同步清单已被另一台设备更新，请重新同步。')
        changed.manifestChanged = true
        throw changed
      }
      throw error
    }
    await writeSyncState(this.userDataPath, nextState)
    return { summary: summaryWithBytes(plan), conflicts: plan.summary.conflict, ...extra }
  }
}
