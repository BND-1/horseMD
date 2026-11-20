// Sync folders (workspaces), shared by desktop and phones. The registry is a
// private document of the platform (sync/workspace-registry.json); each folder
// carries its identity in <folder>/.horsemd/workspace.json, so the same folder
// is the same workspace on every device.
// `platform` (docs/mobile-cloud-sync-architecture.md §6): store, fs, paths
// (normalizeRoot / isRootAllowed / isRestrictedRoot / basename / join), bytes,
// uuid. The desktop's root rules are absolute non-system folders
// (workspace-watch-policy.js); a phone accepts its library root ("HorseMD").

export const SYNC_WORKSPACE_DIR = '.horsemd'
export const SYNC_WORKSPACE_FILE = 'workspace.json'
const REGISTRY_VERSION = 1
const MARKER_VERSION = 1
const REGISTRY = 'sync/workspace-registry.json'

const markerPathFor = (platform, rootPath) => platform.paths.join(rootPath, SYNC_WORKSPACE_DIR, SYNC_WORKSPACE_FILE)

function isWorkspaceId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)
}

function normalizeEntry(platform, entry) {
  if (!entry || !isWorkspaceId(entry.workspaceId) || typeof entry.rootPath !== 'string') return null
  const rootPath = platform.paths.normalizeRoot(entry.rootPath)
  if (!platform.paths.isRootAllowed(rootPath) || platform.paths.isRestrictedRoot(rootPath)) return null
  return {
    workspaceId: entry.workspaceId,
    rootPath,
    connectionId: typeof entry.connectionId === 'string' ? entry.connectionId : null,
    // End-to-end encrypted in the cloud (sync-crypto.js); the key is in the
    // credential store, never here.
    ...(entry.encrypted === true ? { encrypted: true } : {}),
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString()
  }
}

export function displayEntry(platform, entry) {
  return {
    ...entry,
    name: platform.paths.basename(entry.rootPath) || entry.rootPath,
    status: 'local-only'
  }
}

const metadataError = (error) => new Error(`Could not read HorseMD sync metadata: ${error?.message || error}`)

async function readRegistryJson(platform) {
  try {
    const text = await platform.store.readText(REGISTRY)
    return text == null ? { version: REGISTRY_VERSION, workspaces: [] } : JSON.parse(text)
  } catch (error) {
    throw metadataError(error)
  }
}

async function readFolderJson(platform, path) {
  try {
    return JSON.parse(platform.bytes.toText(await platform.fs.readBytes(path)))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw metadataError(error)
  }
}

const jsonBytes = (platform, value) => platform.bytes.fromText(JSON.stringify(value, null, 2) + '\n')

export async function readWorkspaceRegistry(platform) {
  const raw = await readRegistryJson(platform)
  const entries = Array.isArray(raw?.workspaces) ? raw.workspaces.map((entry) => normalizeEntry(platform, entry)).filter(Boolean) : []
  const seenIds = new Set()
  const seenPaths = new Set()
  return entries.filter((entry) => {
    const key = entry.rootPath.toLowerCase()
    if (seenIds.has(entry.workspaceId) || seenPaths.has(key)) return false
    seenIds.add(entry.workspaceId)
    seenPaths.add(key)
    return true
  })
}

async function writeWorkspaceRegistry(platform, entries) {
  await platform.store.writeText(REGISTRY, JSON.stringify({
    version: REGISTRY_VERSION,
    workspaces: entries
  }, null, 2) + '\n', { private: true })
}

async function validateRoot(platform, rootPath) {
  if (typeof rootPath !== 'string' || !platform.paths.isRootAllowed(rootPath)) {
    throw new Error('请选择一个有效的本地文件夹。')
  }
  const normalized = platform.paths.normalizeRoot(rootPath)
  if (platform.paths.isRestrictedRoot(normalized)) throw new Error('这个位置不能作为同步文件夹。')
  let stat
  try {
    stat = await platform.fs.stat(normalized)
  } catch {
    throw new Error('所选文件夹不存在或无法访问。')
  }
  if (!stat.isDirectory) throw new Error('请选择文件夹，而不是文件。')
  return normalized
}

async function readMarker(platform, rootPath) {
  const marker = await readFolderJson(platform, markerPathFor(platform, rootPath))
  if (!marker) return null
  if (!isWorkspaceId(marker.workspaceId)) throw new Error('这个文件夹的 HorseMD 同步标记无效。')
  return marker
}

async function createMarker(platform, rootPath) {
  const dir = platform.paths.join(rootPath, SYNC_WORKSPACE_DIR)
  const path = markerPathFor(platform, rootPath)
  await platform.fs.mkdirp(dir, { private: true })
  const marker = {
    version: MARKER_VERSION,
    workspaceId: platform.uuid(),
    createdAt: new Date().toISOString()
  }
  try {
    await platform.fs.writeNew(path, jsonBytes(platform, marker), { private: true })
    return marker
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return readMarker(platform, rootPath)
  }
}

async function writeMarker(platform, rootPath, marker) {
  await platform.fs.writeAtomic(markerPathFor(platform, rootPath), jsonBytes(platform, marker), { private: true })
}

export async function adoptSyncWorkspace(platform, rootPath) {
  const normalizedRoot = await validateRoot(platform, rootPath)
  const registry = await readWorkspaceRegistry(platform)
  const rootKey = normalizedRoot.toLowerCase()
  const existingAtPath = registry.find((entry) => entry.rootPath.toLowerCase() === rootKey)
  const marker = (await readMarker(platform, normalizedRoot)) || (await createMarker(platform, normalizedRoot))

  if (existingAtPath && existingAtPath.workspaceId !== marker.workspaceId) {
    throw new Error('这个文件夹的同步身份已变化。请先停止管理后再重新添加。')
  }

  const duplicate = registry.find(
    (entry) => entry.workspaceId === marker.workspaceId && entry.rootPath.toLowerCase() !== rootKey
  )
  if (duplicate) {
    throw new Error(`该文件夹是“${duplicate.rootPath}”的副本，不能同时作为同一个同步工作区。`)
  }

  const now = new Date().toISOString()
  const entry = {
    workspaceId: marker.workspaceId,
    rootPath: normalizedRoot,
    createdAt: existingAtPath?.createdAt || marker.createdAt || now,
    updatedAt: now
  }
  const next = [...registry.filter((item) => item.rootPath.toLowerCase() !== rootKey), entry]
  await writeWorkspaceRegistry(platform, next)
  return displayEntry(platform, entry)
}

export async function unregisterSyncWorkspace(platform, rootPath) {
  const normalizedRoot = await validateRoot(platform, rootPath)
  const registry = await readWorkspaceRegistry(platform)
  const next = registry.filter((entry) => entry.rootPath.toLowerCase() !== normalizedRoot.toLowerCase())
  await writeWorkspaceRegistry(platform, next)
  // Keep the folder marker. It identifies the folder if the user adds it again
  // on this or another device; unregistering must never modify user files.
  return true
}

export async function bindSyncWorkspace(platform, rootPath, connectionId, { encrypted = false } = {}) {
  const normalizedRoot = await validateRoot(platform, rootPath)
  const registry = await readWorkspaceRegistry(platform)
  const index = registry.findIndex((entry) => entry.rootPath.toLowerCase() === normalizedRoot.toLowerCase())
  if (index < 0) throw new Error('请先将这个文件夹添加为 HorseMD 同步文件夹。')
  const { encrypted: _old, ...rest } = registry[index]
  registry[index] = { ...rest, connectionId, ...(encrypted ? { encrypted: true } : {}), updatedAt: new Date().toISOString() }
  await writeWorkspaceRegistry(platform, registry)
  return displayEntry(platform, registry[index])
}

// Mark a sync folder as end-to-end encrypted (its key was just unlocked).
export async function markSyncWorkspaceEncrypted(platform, rootPath) {
  const registry = await readWorkspaceRegistry(platform)
  const index = registry.findIndex((entry) => entry.rootPath.toLowerCase() === String(rootPath).replace(/[\\/]+$/, '').toLowerCase())
  if (index < 0) throw new Error('请先将这个文件夹添加为 HorseMD 同步文件夹。')
  if (registry[index].encrypted) return displayEntry(platform, registry[index])
  registry[index] = { ...registry[index], encrypted: true, updatedAt: new Date().toISOString() }
  await writeWorkspaceRegistry(platform, registry)
  return displayEntry(platform, registry[index])
}

export async function joinSyncWorkspace(platform, rootPath, remoteWorkspaceId) {
  if (!isWorkspaceId(remoteWorkspaceId)) throw new Error('远端工作区身份无效。')
  const normalizedRoot = await validateRoot(platform, rootPath)
  const registry = await readWorkspaceRegistry(platform)
  const rootKey = normalizedRoot.toLowerCase()
  const index = registry.findIndex((entry) => entry.rootPath.toLowerCase() === rootKey)
  if (index < 0) throw new Error('请先将这个文件夹添加为 HorseMD 同步文件夹。')
  const duplicate = registry.find((entry) => entry.workspaceId === remoteWorkspaceId && entry.rootPath.toLowerCase() !== rootKey)
  if (duplicate) throw new Error(`“${duplicate.rootPath}”已使用这个远端工作区。`)
  const marker = await readMarker(platform, normalizedRoot)
  await writeMarker(platform, normalizedRoot, { version: MARKER_VERSION, workspaceId: remoteWorkspaceId, createdAt: marker?.createdAt || new Date().toISOString() })
  registry[index] = { ...registry[index], workspaceId: remoteWorkspaceId, updatedAt: new Date().toISOString() }
  await writeWorkspaceRegistry(platform, registry)
  return displayEntry(platform, registry[index])
}

export async function listSyncWorkspaces(platform) {
  return (await readWorkspaceRegistry(platform)).map((entry) => displayEntry(platform, entry))
}
