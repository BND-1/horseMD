import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SyncEngine } from '../src/main/sync/sync-engine.js'

class MemoryProvider {
  constructor() { this.objects = new Map(); this.revision = 0 }
  async get(path) {
    const entry = this.objects.get(path)
    return entry ? { bytes: Buffer.from(entry.bytes), revision: entry.revision } : null
  }
  async put(path, bytes, { revision = null, createOnly = false } = {}) {
    const old = this.objects.get(path)
    if ((createOnly && old) || (revision && old?.revision !== revision)) throw new Error('conditional write failed')
    const next = { bytes: Buffer.from(bytes), revision: String(++this.revision) }
    this.objects.set(path, next)
    return { revision: next.revision }
  }
  async delete(path, { revision = null } = {}) {
    const old = this.objects.get(path)
    if (revision && old?.revision !== revision) throw new Error('conditional delete failed')
    this.objects.delete(path)
    return true
  }
}

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-sync-engine-'))
const userDataA = join(root, 'profile-a')
const userDataB = join(root, 'profile-b')
const localA = join(root, 'a')
const localB = join(root, 'b')
const workspaceId = randomUUID()
const provider = new MemoryProvider()

const makeEngine = (rootPath, userDataPath, deviceName) => new SyncEngine({
  rootPath, userDataPath, workspaceId, provider, deviceName
})

try {
  await fs.mkdir(join(localA, 'assets'), { recursive: true })
  await fs.mkdir(localB, { recursive: true })
  await fs.writeFile(join(localA, 'note.md'), '# First\n')
  await fs.writeFile(join(localA, 'assets', 'photo.bin'), Buffer.from([7, 8, 9]))

  const first = await makeEngine(localA, userDataA, 'Mac').preview()
  assert.deepEqual(first.summary, { upload: 2, download: 0, delete: 0, conflict: 0, unchanged: 0, uploadBytes: 11, downloadBytes: 0 })
  await makeEngine(localA, userDataA, 'Mac').execute(first)
  assert.equal((await provider.get('note.md')).bytes.toString(), '# First\n')

  const second = await makeEngine(localB, userDataB, 'Phone').preview()
  assert.equal(second.summary.download, 2)
  await makeEngine(localB, userDataB, 'Phone').execute(second)
  assert.equal(await fs.readFile(join(localB, 'note.md'), 'utf8'), '# First\n')
  assert.deepEqual(await fs.readFile(join(localB, 'assets', 'photo.bin')), Buffer.from([7, 8, 9]))

  await fs.writeFile(join(localA, 'note.md'), '# From A\n')
  await makeEngine(localA, userDataA, 'Mac').execute()
  await fs.writeFile(join(localB, 'note.md'), '# From B\n')
  const conflict = await makeEngine(localB, userDataB, 'Phone').preview()
  assert.equal(conflict.summary.conflict, 1)
  await makeEngine(localB, userDataB, 'Phone').execute(conflict)
  assert.equal(await fs.readFile(join(localB, 'note.md'), 'utf8'), '# From A\n')
  assert.equal(await fs.readFile(join(localB, 'note (来自 Phone 的冲突副本).md'), 'utf8'), '# From B\n')
  assert.equal((await provider.get('note (来自 Phone 的冲突副本).md')).bytes.toString(), '# From B\n')

  await fs.rm(join(localA, 'assets', 'photo.bin'))
  await makeEngine(localA, userDataA, 'Mac').execute()
  const deletion = await makeEngine(localB, userDataB, 'Phone').preview()
  assert.equal(deletion.summary.delete, 1)
  await makeEngine(localB, userDataB, 'Phone').execute(deletion)
  await assert.rejects(fs.stat(join(localB, 'assets', 'photo.bin')), { code: 'ENOENT' })
  assert.equal((await provider.get('assets/photo.bin')), null)
  assert.equal([...provider.objects.keys()].some((path) => path.includes('/assets/photo.bin') && path.startsWith('.horsemd/trash/')), true)

  // A missing remote manifest after a successful baseline is not a deletion
  // event. Normal merge blocks, while an explicit local-to-cloud recovery is
  // allowed and reconstructs the remote workspace.
  await provider.delete('.horsemd/manifest.json')
  const reset = await makeEngine(localA, userDataA, 'Mac').preview()
  assert.equal(reset.status, 'remote-reset')
  assert.equal(reset.operations.length, 0)
  await assert.rejects(makeEngine(localA, userDataA, 'Mac').execute(reset), /不会自动删除本地文件/)
  const recoverPush = await makeEngine(localA, userDataA, 'Mac').preview('push')
  assert.equal(recoverPush.status, 'ready')
  assert.ok(recoverPush.summary.upload > 0)
  await makeEngine(localA, userDataA, 'Mac').execute(recoverPush)
  assert.ok(await provider.get('.horsemd/manifest.json'))

  // Pull protects local-only and replaced files before making the cloud state
  // authoritative for this one explicit recovery operation.
  await fs.writeFile(join(localB, 'note.md'), '# Local replacement\n')
  await fs.writeFile(join(localB, 'only-local.md'), '# Keep me in trash\n')
  const pull = await makeEngine(localB, userDataB, 'Phone').preview('pull')
  assert.equal(pull.status, 'ready')
  assert.ok(pull.summary.download >= 1)
  assert.ok(pull.summary.delete >= 1)
  await makeEngine(localB, userDataB, 'Phone').execute(pull)
  assert.equal(await fs.readFile(join(localB, 'note.md'), 'utf8'), '# From A\n')
  assert.equal([...await fs.readdir(join(localB, '.horsemd', 'trash'), { recursive: true })].some((path) => String(path).endsWith('only-local.md')), true)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

console.log('PASS sync engine: merge, directional recovery, remote reset guard and trash protection')
