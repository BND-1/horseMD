import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  SYNC_WORKSPACE_DIR,
  SYNC_WORKSPACE_FILE,
  adoptSyncWorkspace,
  readWorkspaceRegistry,
  unregisterSyncWorkspace
} from '../src/main/sync-workspaces.js'

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-sync-workspaces-'))
const userData = join(root, 'profile')
const notes = join(root, 'notes')
const copy = join(root, 'notes-copy')

try {
  await fs.mkdir(join(notes, 'nested'), { recursive: true })
  await fs.writeFile(join(notes, 'nested', 'note.md'), '# Note\n', 'utf8')

  const first = await adoptSyncWorkspace(userData, notes)
  assert.equal(first.name, 'notes')
  assert.equal(first.status, 'local-only')
  assert.match(first.workspaceId, /^[0-9a-f-]{36}$/i)

  const markerPath = join(notes, SYNC_WORKSPACE_DIR, SYNC_WORKSPACE_FILE)
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'))
  assert.equal(marker.workspaceId, first.workspaceId)
  await assert.rejects(fs.stat(join(notes, 'nested', SYNC_WORKSPACE_DIR)), { code: 'ENOENT' })

  const second = await adoptSyncWorkspace(userData, notes)
  assert.equal(second.workspaceId, first.workspaceId)
  let registry = await readWorkspaceRegistry(userData)
  assert.equal(registry.length, 1)
  assert.equal(registry[0].rootPath, notes)

  await fs.cp(notes, copy, { recursive: true })
  await assert.rejects(adoptSyncWorkspace(userData, copy), /副本/)

  await unregisterSyncWorkspace(userData, notes)
  registry = await readWorkspaceRegistry(userData)
  assert.equal(registry.length, 0)
  assert.equal(JSON.parse(await fs.readFile(markerPath, 'utf8')).workspaceId, first.workspaceId)

  await assert.rejects(adoptSyncWorkspace(userData, '/'), /不能作为同步文件夹/)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

console.log('PASS sync workspaces: adopt, stable marker, duplicate protection and unregister')
