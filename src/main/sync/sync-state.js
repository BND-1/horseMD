import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const STATE_VERSION = 1

const statePathFor = (userDataPath, workspaceId) =>
  join(userDataPath, 'sync', 'state', `${workspaceId}.json`)

export async function readSyncState(userDataPath, workspaceId) {
  try {
    const raw = JSON.parse(await fs.readFile(statePathFor(userDataPath, workspaceId), 'utf8'))
    if (raw?.version !== STATE_VERSION || raw.workspaceId !== workspaceId || !raw.files) throw new Error('invalid')
    return { version: STATE_VERSION, workspaceId, files: raw.files }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.message === 'invalid') {
      return { version: STATE_VERSION, workspaceId, files: {} }
    }
    throw error
  }
}

export async function writeSyncState(userDataPath, state) {
  const path = statePathFor(userDataPath, state.workspaceId)
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temp, JSON.stringify({ ...state, version: STATE_VERSION }, null, 2) + '\n', {
    encoding: 'utf8', mode: 0o600
  })
  await fs.rename(temp, path)
}
