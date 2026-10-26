// Automatic sync runs the engine in `safeOnly` mode (hooks/useAutoSync.js →
// sync:run options.safeOnly): the plan is computed right before running;
// uploads and downloads run, a plan with deletions or conflicts (or a cloud
// workspace that was emptied) is refused with { needsConfirmation } and the
// cloud stays untouched, and nothing to do → { idle } with no request that
// writes (no manifest PUT every few minutes).
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SyncEngine } from '../src/main/sync/sync-engine.js'

class MemoryProvider {
  constructor() { this.objects = new Map(); this.revision = 0; this.writes = 0 }
  async get(path) {
    const entry = this.objects.get(path)
    return entry ? { bytes: Buffer.from(entry.bytes), revision: entry.revision } : null
  }
  async put(path, bytes, { revision = null, createOnly = false } = {}) {
    this.writes += 1
    const old = this.objects.get(path)
    if ((createOnly && old) || (revision && old?.revision !== revision)) throw new Error('conditional write failed')
    const next = { bytes: Buffer.from(bytes), revision: String(++this.revision) }
    this.objects.set(path, next)
    return { revision: next.revision }
  }
  async delete(path, { revision = null } = {}) {
    this.writes += 1
    const old = this.objects.get(path)
    if (revision && old?.revision !== revision) throw new Error('conditional delete failed')
    this.objects.delete(path)
    return true
  }
  async createDirectory(path) { this.writes += 1; this.objects.set(`${path}/`, { bytes: Buffer.alloc(0), revision: String(++this.revision) }); return true }
  async removeDirectory(path) { this.writes += 1; this.objects.delete(`${path}/`); return true }
}

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-sync-auto-'))
const workspaceId = randomUUID()
const provider = new MemoryProvider()
const engine = (name) => new SyncEngine({ rootPath: join(root, name), userDataPath: join(root, `${name}-profile`), workspaceId, provider, deviceName: name })
const a = engine('a')
const b = engine('b')
const safe = (e) => e.execute(null, 'merge', { safeOnly: true })
const cloudFiles = () => [...provider.objects.keys()].filter((k) => !k.startsWith('.horsemd/')).sort()

try {
  await fs.mkdir(join(root, 'a'), { recursive: true })
  await fs.mkdir(join(root, 'b'), { recursive: true })
  await fs.writeFile(join(root, 'a', 'one.md'), '# one\n')
  await fs.writeFile(join(root, 'a', 'two.md'), '# two\n')

  // 1. Uploads run.
  const first = await safe(a)
  assert.equal(first.needsConfirmation, undefined)
  assert.equal(first.summary.upload, 2)
  assert.deepEqual(cloudFiles(), ['one.md', 'two.md'])

  // 2. Downloads run (another device).
  const pulled = await safe(b)
  assert.equal(pulled.summary.download, 2)
  assert.equal(await fs.readFile(join(root, 'b', 'one.md'), 'utf8'), '# one\n')

  // 3. Nothing to do: idle, nothing written to the cloud.
  const writes = provider.writes
  assert.deepEqual(await safe(a), { idle: true, summary: (await a.preview('merge')).summary })
  assert.equal(provider.writes, writes, 'an idle automatic sync writes nothing')

  // 4. A local deletion is not run unattended.
  await fs.rm(join(root, 'a', 'two.md'))
  const deletion = await safe(a)
  assert.equal(deletion.needsConfirmation, true)
  assert.equal(deletion.reason, 'changes')
  assert.equal(deletion.summary.delete, 1)
  assert.deepEqual(cloudFiles(), ['one.md', 'two.md'], 'cloud untouched')
  assert.equal(provider.writes, writes)
  // …and an upload next to it waits too (one plan, confirmed as a whole).
  await fs.writeFile(join(root, 'a', 'three.md'), '# three\n')
  assert.equal((await safe(a)).needsConfirmation, true)
  assert.ok(!provider.objects.has('three.md'))
  // The user confirms it (a normal run).
  await a.execute(null, 'merge')
  assert.deepEqual(cloudFiles(), ['one.md', 'three.md'])

  // 5. A conflict is not run unattended.
  // b catches up: two.md deleted in the cloud is a deletion here → confirm.
  assert.equal((await safe(b)).needsConfirmation, true)
  await b.execute(null, 'merge')
  await fs.writeFile(join(root, 'a', 'one.md'), '# one from a\n')
  await fs.writeFile(join(root, 'b', 'one.md'), '# one from b\n')
  await a.execute(null, 'merge')
  const conflict = await safe(b)
  assert.equal(conflict.needsConfirmation, true)
  assert.equal(conflict.summary.conflict, 1)
  assert.equal(await fs.readFile(join(root, 'b', 'one.md'), 'utf8'), '# one from b\n', 'local file untouched')

  // 6. Cloud workspace emptied: refused (a normal run throws here).
  await provider.delete('.horsemd/manifest.json')
  const reset = await safe(a)
  assert.equal(reset.needsConfirmation, true)
  assert.equal(reset.reason, 'remote-reset')
  console.log('PASS sync auto: uploads/downloads run, idle writes nothing, deletions / conflicts / emptied cloud wait for confirmation')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
