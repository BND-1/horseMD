import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { isAbsoluteWatchPath, isRestrictedWatchRoot } from './watchers.js'

export const SYNC_WORKSPACE_DIR = '.horsemd'
export const SYNC_WORKSPACE_FILE = 'workspace.json'
const REGISTRY_VERSION = 1
const MARKER_VERSION = 1

const normalizePath = (path) => resolve(path).replace(/[\\/]+$/, '')
const markerPathFor = (rootPath) => join(rootPath, SYNC_WORKSPACE_DIR, SYNC_WORKSPACE_FILE)
const registryPathFor = (userDataPath) => join(userDataPath, 'sync', 'workspace-registry.json')

function isWorkspaceId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)
}

function normalizeEntry(entry) {
  if (!entry || !isWorkspaceId(entry.workspaceId) || typeof entry.rootPath !== 'string') return null
  const rootPath = normalizePath(entry.rootPath)
  if (!isAbsoluteWatchPath(rootPath) || isRestrictedWatchRoot(rootPath)) return null
  return {
    workspaceId: entry.workspaceId,
    rootPath,
    connectionId: typeof entry.connectionId === 'string' ? entry.connectionId : null,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString()
  }
}

function displayEntry(entry) {
  return {
    ...entry,
    name: basename(entry.rootPath) || entry.rootPath,
    status: 'local-only'
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw new Error(`Could not read HorseMD sync metadata: ${error?.message || error}`)
  }
}

async function writeJsonAtomically(path, value) {
  const dir = dirname(path)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temp, path)
}

export async function readWorkspaceRegistry(userDataPath) {
  const raw = await readJson(registryPathFor(userDataPath), { version: REGISTRY_VERSION, workspaces: [] })
  const entries = Array.isArray(raw?.workspaces) ? raw.workspaces.map(normalizeEntry).filter(Boolean) : []
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

async function writeWorkspaceRegistry(userDataPath, entries) {
  await writeJsonAtomically(registryPathFor(userDataPath), {
    version: REGISTRY_VERSION,
    workspaces: entries
  })
}

async function validateRoot(rootPath) {
  if (typeof rootPath !== 'string' || !isAbsoluteWatchPath(rootPath)) {
    throw new Error('请选择一个有效的本地文件夹。')
  }
  const normalized = normalizePath(rootPath)
  if (isRestrictedWatchRoot(normalized)) throw new Error('这个位置不能作为同步文件夹。')
  let stat
  try {
    stat = await fs.stat(normalized)
  } catch {
    throw new Error('所选文件夹不存在或无法访问。')
  }
  if (!stat.isDirectory()) throw new Error('请选择文件夹，而不是文件。')
  return normalized
}

async function readMarker(rootPath) {
  const marker = await readJson(markerPathFor(rootPath), null)
  if (!marker) return null
  if (!isWorkspaceId(marker.workspaceId)) throw new Error('这个文件夹的 HorseMD 同步标记无效。')
  return marker
}

async function createMarker(rootPath) {
  const dir = join(rootPath, SYNC_WORKSPACE_DIR)
  const path = markerPathFor(rootPath)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const marker = {
    version: MARKER_VERSION,
    workspaceId: randomUUID(),
    createdAt: new Date().toISOString()
  }
  try {
    await fs.writeFile(path, JSON.stringify(marker, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    return marker
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return readMarker(rootPath)
  }
}

async function writeMarker(rootPath, marker) {
  await writeJsonAtomically(markerPathFor(rootPath), marker)
}

export async function adoptSyncWorkspace(userDataPath, rootPath) {
  const normalizedRoot = await validateRoot(rootPath)
  const registry = await readWorkspaceRegistry(userDataPath)
  const rootKey = normalizedRoot.toLowerCase()
  const existingAtPath = registry.find((entry) => entry.rootPath.toLowerCase() === rootKey)
  const marker = (await readMarker(normalizedRoot)) || (await createMarker(normalizedRoot))

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
  await writeWorkspaceRegistry(userDataPath, next)
  return displayEntry(entry)
}

export async function unregisterSyncWorkspace(userDataPath, rootPath) {
  const normalizedRoot = await validateRoot(rootPath)
  const registry = await readWorkspaceRegistry(userDataPath)
  const next = registry.filter((entry) => entry.rootPath.toLowerCase() !== normalizedRoot.toLowerCase())
  await writeWorkspaceRegistry(userDataPath, next)
  // Keep the folder marker. It identifies the folder if the user adds it again
  // on this or another device; unregistering must never modify user files.
  return true
}

export async function bindSyncWorkspace(userDataPath, rootPath, connectionId) {
  const normalizedRoot = await validateRoot(rootPath)
  const registry = await readWorkspaceRegistry(userDataPath)
  const index = registry.findIndex((entry) => entry.rootPath.toLowerCase() === normalizedRoot.toLowerCase())
  if (index < 0) throw new Error('请先将这个文件夹添加为 HorseMD 同步文件夹。')
  registry[index] = { ...registry[index], connectionId, updatedAt: new Date().toISOString() }
  await writeWorkspaceRegistry(userDataPath, registry)
  return displayEntry(registry[index])
}

export async function joinSyncWorkspace(userDataPath, rootPath, remoteWorkspaceId) {
  if (!isWorkspaceId(remoteWorkspaceId)) throw new Error('远端工作区身份无效。')
  const normalizedRoot = await validateRoot(rootPath)
  const registry = await readWorkspaceRegistry(userDataPath)
  const rootKey = normalizedRoot.toLowerCase()
  const index = registry.findIndex((entry) => entry.rootPath.toLowerCase() === rootKey)
  if (index < 0) throw new Error('请先将这个文件夹添加为 HorseMD 同步文件夹。')
  const duplicate = registry.find((entry) => entry.workspaceId === remoteWorkspaceId && entry.rootPath.toLowerCase() !== rootKey)
  if (duplicate) throw new Error(`“${duplicate.rootPath}”已使用这个远端工作区。`)
  const marker = await readMarker(normalizedRoot)
  await writeMarker(normalizedRoot, { version: MARKER_VERSION, workspaceId: remoteWorkspaceId, createdAt: marker?.createdAt || new Date().toISOString() })
  registry[index] = { ...registry[index], workspaceId: remoteWorkspaceId, updatedAt: new Date().toISOString() }
  await writeWorkspaceRegistry(userDataPath, registry)
  return displayEntry(registry[index])
}

export function registerSyncWorkspaceIpc(ipcMain, { getUserDataPath, isTrustedSender }) {
  const trusted = (event) => {
    if (isTrustedSender?.(event)) return
    throw new Error('Untrusted renderer.')
  }

  ipcMain.handle('sync:workspaceList', async (event) => {
    trusted(event)
    const entries = await readWorkspaceRegistry(getUserDataPath())
    return entries.map(displayEntry)
  })
  ipcMain.handle('sync:workspaceAdopt', async (event, rootPath) => {
    trusted(event)
    return adoptSyncWorkspace(getUserDataPath(), rootPath)
  })
  ipcMain.handle('sync:workspaceRemove', async (event, rootPath) => {
    trusted(event)
    return unregisterSyncWorkspace(getUserDataPath(), rootPath)
  })
}
