// Automatic sync runs the engine in `safeOnly` mode (hooks/useAutoSync.js →
// sync:run options.safeOnly): the plan is computed right before running;
// uploads and downloads run; deletions and conflicts are held (left exactly
// as they were — the next run sees them again) and reported as `held`, or as
// { needsConfirmation } when nothing else is to do; a cloud workspace that
// was emptied runs nothing; nothing to do → { idle } with no request that
// writes (no manifest PUT every few minutes). A held deletion used to hold
// the whole round: other files' new text stayed on one device
// (docs/cloud-sync-review.md R4).
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
  // …but an upload next to it runs; only the deletion waits.
  await fs.writeFile(join(root, 'a', 'three.md'), '# three\n')
  const mixed = await safe(a)
  assert.equal(mixed.needsConfirmation, undefined)
  assert.deepEqual(mixed.held, { delete: 1, conflict: 0 })
  assert.deepEqual(cloudFiles(), ['one.md', 'three.md', 'two.md'], 'three.md uploaded, two.md kept')
  // The held deletion is still a deletion next time (never a "new cloud file"
  // downloaded back).
  const again = await safe(a)
  assert.equal(again.needsConfirmation, true)
  assert.equal(again.summary.delete, 1)
  assert.equal(again.summary.download, 0)
  // The user confirms it (a normal run).
  await a.execute(null, 'merge')
  assert.deepEqual(cloudFiles(), ['one.md', 'three.md'])

  // 5. A conflict is not run unattended.
  // b catches up: three.md downloads; two.md deleted in the cloud is a
  // deletion here → held.
  const catchUp = await safe(b)
  assert.deepEqual(catchUp.held, { delete: 1, conflict: 0 })
  assert.equal(await fs.readFile(join(root, 'b', 'three.md'), 'utf8'), '# three\n')
  assert.equal(await fs.readFile(join(root, 'b', 'two.md'), 'utf8'), '# two\n', 'held deletion leaves the file')
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
  console.log('PASS sync auto: uploads/downloads run, idle writes nothing, deletions / conflicts are held (the rest still syncs; held ones stay pending), emptied cloud waits')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
