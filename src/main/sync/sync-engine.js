import fs from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { scanLocalWorkspace, sha256 } from './local-files.js'
import { buildDirectionalSyncPlan, buildSyncPlan, makeConflictPath } from './sync-plan.js'
import { readSyncState, writeSyncState } from './sync-state.js'

const MANIFEST_VERSION = 1
const now = () => new Date().toISOString()
const manifestPath = '.horsemd/manifest.json'
const trashPath = (stamp, path) => `.horsemd/trash/${stamp}/${path}`

function normalizeManifest(input, workspaceId) {
  if (!input) return { version: MANIFEST_VERSION, workspaceId, files: {}, tombstones: {} }
  if (input.version !== MANIFEST_VERSION || input.workspaceId !== workspaceId) {
    throw new Error('远端同步目录不是当前 HorseMD 工作区。')
  }
  return {
    version: MANIFEST_VERSION,
    workspaceId,
    files: input.files && typeof input.files === 'object' ? input.files : {},
    tombstones: input.tombstones && typeof input.tombstones === 'object' ? input.tombstones : {}
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

async function archiveRemoteToTrash(provider, item, stamp) {
  const existing = await provider.get(item.path)
  if (!existing) return
  verifyRemoteBytes(item.path, item.remote || item.previous, existing.bytes)
  await provider.put(trashPath(stamp, item.path), existing.bytes, { createOnly: true })
}

export class SyncEngine {
  constructor({ userDataPath, provider, rootPath, workspaceId, deviceName = 'this device', onProgress = null }) {
    this.userDataPath = userDataPath
    this.provider = provider
    this.rootPath = rootPath
    this.workspaceId = workspaceId
    this.deviceName = deviceName
    this.onProgress = onProgress
  }

  async preview(strategy = 'merge') {
    if (!['merge', 'push', 'pull'].includes(strategy)) throw new Error('同步方向无效。')
    const [localFiles, state, remote] = await Promise.all([
      scanLocalWorkspace(this.rootPath),
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
        conflictSuffix: `来自 ${this.deviceName} 的冲突副本`
      })
      : buildDirectionalSyncPlan({ localFiles, remoteFiles: remote.manifest.files, strategy })
    return {
      status: 'ready',
      strategy,
      localFiles,
      state,
      remote,
      plan,
      summary: summaryWithBytes(plan),
      operations: plan.operations.map(publicOperation)
    }
  }

  async execute(preview = null, strategy = 'merge') {
    const prepared = preview || await this.preview(strategy)
    if (prepared.status !== 'ready') {
      throw new Error('云端工作区已被清空或替换。请明确选择上传本地或下载云端，HorseMD 不会自动删除本地文件。')
    }
    const { localFiles, state, remote, plan } = prepared
    const manifest = structuredClone(remote.manifest)
    const stamp = now().replace(/[:.]/g, '-')
    const files = new Map(localFiles)
    const total = plan.operations.filter((item) => item.type !== 'keep').length
    let completed = 0

    const progress = (item) => {
      completed += 1
      this.onProgress?.({ completed, total, type: item.type, path: item.path })
    }
    for (const item of plan.operations) {
      if (item.type === 'keep') continue
      if (item.type === 'upload') {
        if (item.preserveRemote) await archiveRemoteToTrash(this.provider, item, stamp)
        const bytes = await readLocalBytes(this.rootPath, item.path)
        let uploaded
        try {
          uploaded = await this.provider.put(item.path, bytes, {
            revision: item.remote?.revision || null,
            createOnly: !item.remote
          })
        } catch (error) {
          // A reset remote may have lost its manifest while retaining ordinary
          // objects. This path is available only after an explicit push; retain
          // the untracked object before replacing it with the local source.
          if (prepared.strategy !== 'push' || item.remote) throw error
          const untracked = await this.provider.get(item.path)
          if (!untracked) throw error
          await this.provider.put(trashPath(stamp, item.path), untracked.bytes, { createOnly: true })
          uploaded = await this.provider.put(item.path, bytes, { revision: untracked.revision })
        }
        manifest.files[item.path] = { ...item.local, revision: uploaded.revision, updatedAt: now() }
        delete manifest.tombstones[item.path]
      } else if (item.type === 'download') {
        if (item.preserveLocal) await moveLocalToTrash(this.rootPath, item.path, stamp)
        const remoteFile = await this.provider.get(item.path)
        if (!remoteFile) throw new Error(`远端文件“${item.path}”在同步中消失，请重新同步。`)
        verifyRemoteBytes(item.path, item.remote, remoteFile.bytes)
        await writeLocalBytes(this.rootPath, item.path, remoteFile.bytes)
        files.set(item.path, { ...item.remote, sha256: sha256(remoteFile.bytes) })
      } else if (item.type === 'deleteRemote') {
        const existing = await this.provider.get(item.path)
        if (existing) {
          verifyRemoteBytes(item.path, item.remote || item.previous, existing.bytes)
          await this.provider.put(trashPath(stamp, item.path), existing.bytes, { createOnly: true })
          await this.provider.delete(item.path, { revision: existing.revision })
        }
        delete manifest.files[item.path]
        manifest.tombstones[item.path] = { deletedAt: now() }
        files.delete(item.path)
      } else if (item.type === 'deleteLocal') {
        await moveLocalToTrash(this.rootPath, item.path, stamp)
        files.delete(item.path)
      } else if (item.type === 'conflict') {
        // The remote original becomes canonical. The local modification is kept
        // as a normal conflict copy on both sides, never silently discarded.
        if (item.local && item.remote) {
          const localBytes = await readLocalBytes(this.rootPath, item.path)
          const remoteBytes = await this.provider.get(item.path)
          if (!remoteBytes) throw new Error(`远端冲突文件“${item.path}”在同步中消失。`)
          verifyRemoteBytes(item.path, item.remote, remoteBytes.bytes)
          const localConflict = makeConflictPath(item.path, `来自 ${this.deviceName} 的冲突副本`)
          await writeLocalBytes(this.rootPath, localConflict, localBytes)
          const uploadedConflict = await this.provider.put(localConflict, localBytes, { createOnly: true })
          await writeLocalBytes(this.rootPath, item.path, remoteBytes.bytes)
          files.set(item.path, { ...item.remote, sha256: sha256(remoteBytes.bytes) })
          files.set(localConflict, { sha256: sha256(localBytes), size: localBytes.byteLength, mtimeMs: Date.now() })
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
          const localConflict = makeConflictPath(item.path, `来自 ${this.deviceName} 的冲突副本`)
          await writeLocalBytes(this.rootPath, localConflict, localBytes)
          const uploadedConflict = await this.provider.put(localConflict, localBytes, { createOnly: true })
          await moveLocalToTrash(this.rootPath, item.path, stamp)
          files.delete(item.path)
          files.set(localConflict, { sha256: sha256(localBytes), size: localBytes.byteLength, mtimeMs: Date.now() })
          manifest.files[localConflict] = {
            sha256: sha256(localBytes), size: localBytes.byteLength, revision: uploadedConflict.revision, updatedAt: now()
          }
        }
      }
      progress(item)
    }

    const nextState = {
      version: 1,
      workspaceId: this.workspaceId,
      files: Object.fromEntries([...files].map(([path, entry]) => [path, { sha256: entry.sha256 }]))
    }
    // The manifest is committed last. If another device changed it, conditional
    // write fails before local state advances, so the next run re-plans safely.
    await this.provider.put(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), {
      revision: remote.revision,
      createOnly: !remote.exists,
      contentType: 'application/json'
    })
    await writeSyncState(this.userDataPath, nextState)
    return { summary: summaryWithBytes(plan), conflicts: plan.summary.conflict }
  }
}
