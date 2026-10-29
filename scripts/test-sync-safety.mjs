// Sync data safety (docs/cloud-sync-review.md P0): the risks found by
// scripts/audit-sync-safety.mjs, now asserted. Two devices, one object store
// with S3 semantics, the real SyncEngine.
//   R1  files open with unsaved edits are never downloaded over (busyPaths);
//       the save that follows meets the other version as a conflict, both kept
//   R9  a file saved after the scan is never overwritten by the download
//   R3  repeated conflicts on one file never collide or stall a device
//   R5  a save during the upload never makes the other device fail
//   R6  losing the manifest race re-plans (engine tag + SyncService retry)
//   + conflict copy names (device + time, free names), temp files never sync
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SyncEngine } from '../src/main/sync/sync-engine.js'
import { SyncService, busyRelativePaths } from '../src/main/sync-service.js'
import { conflictCopyName, conflictStamp, deviceLabel } from '../src/main/sync/conflict-name.js'
import { isSystemJunkPath } from '../src/main/sync/sync-ignore.js'

class MemoryStore {
  constructor() { this.objects = new Map(); this.revision = 0 }
  async get(path) {
    const entry = this.objects.get(path)
    return entry ? { bytes: Buffer.from(entry.bytes), revision: entry.revision } : null
  }
  async put(path, bytes, { revision = null, createOnly = false } = {}) {
    const old = this.objects.get(path)
    if ((createOnly && old) || (revision && old?.revision !== revision)) throw new Error('远端文件已被其他设备修改，请重新同步。')
    const next = { bytes: Buffer.from(bytes), revision: String(++this.revision) }
    this.objects.set(path, next)
    return { revision: next.revision }
  }
  async delete(path) { this.objects.delete(path); return true }
  async createDirectory(path) { this.objects.set(`${path}/`, { bytes: Buffer.alloc(0), revision: String(++this.revision) }); return true }
  async removeDirectory(path) { this.objects.delete(`${path}/`); return true }
}

const roots = []
async function setup(deviceA = 'Mac', deviceB = 'PC') {
  const root = await fs.mkdtemp(join(tmpdir(), 'hm-sync-safety-'))
  roots.push(root)
  const A = join(root, 'A'), B = join(root, 'B')
  await fs.mkdir(A); await fs.mkdir(B)
  const ws = randomUUID()
  const store = new MemoryStore()
  const engine = (dir, label, busyPaths = []) => new SyncEngine({ rootPath: dir, userDataPath: join(root, 'state-' + label), workspaceId: ws, provider: store, deviceName: label === 'A' ? deviceA : deviceB, busyPaths })
  return { A, B, store, engine, a: (o = {}) => engine(A, 'A', o.busy).execute(null, 'merge', o), b: (o = {}) => engine(B, 'B', o.busy).execute(null, 'merge', o) }
}
const write = (dir, path, text) => fs.mkdir(join(dir, path, '..'), { recursive: true }).then(() => fs.writeFile(join(dir, path), text))
const read = (dir, path) => fs.readFile(join(dir, path), 'utf8').catch(() => null)
async function contents(dir) {
  const out = {}
  const walk = async (d, prefix = '') => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.name === '.horsemd') continue
      if (e.isDirectory()) await walk(join(d, e.name), prefix + e.name + '/')
      else out[prefix + e.name] = await fs.readFile(join(d, e.name), 'utf8')
    }
  }
  await walk(dir)
  return out
}
const allText = async (env) => [...Object.values(await contents(env.A)), ...Object.values(await contents(env.B))].join('\n')
const settle = async (env) => { for (let i = 0; i < 2; i += 1) { await env.a(); await env.b() } }

try {
  // R1 — A has the file open with unsaved edits; B's version is not written
  // over it. A then saves: next sync keeps both versions.
  {
    const env = await setup()
    await write(env.A, '笔记.md', '原文\n'); await env.a(); await env.b()
    await write(env.B, '笔记.md', '原文\nB 的修改\n'); await env.b()
    const auto = await env.a({ automatic: true, busy: ['笔记.md'] })
    assert.deepEqual(auto.deferred, ['笔记.md'])
    assert.equal(await read(env.A, '笔记.md'), '原文\n', 'open file with unsaved edits overwritten')
    await write(env.A, '笔记.md', '原文\nA 的修改\n') // the save
    await env.a() // a confirmed (manual) run: the conflict keeps both
    await settle(env)
    const text = await allText(env)
    assert.ok(text.includes('B 的修改') && text.includes('A 的修改'), `R1 both versions kept: ${text}`)
    assert.deepEqual(Object.keys(await contents(env.A)).sort(), Object.keys(await contents(env.B)).sort())
    // The relative path conversion used by SyncService.
    assert.deepEqual(busyRelativePaths('/w/notes', ['/w/notes/a/b.md', '/w/other.md', 'rel.md']), ['a/b.md'])
  }

  // R9 — saved after the scan, before the download writes: kept; the next
  // run turns it into a conflict with both versions.
  {
    const env = await setup()
    await write(env.A, 'n.md', '原文\n'); await env.a(); await env.b()
    await write(env.B, 'n.md', '原文\nB 的修改\n'); await env.b()
    const engine = env.engine(env.A, 'A')
    const preview = await engine.preview('merge')
    await write(env.A, 'n.md', '原文\nA 刚保存的内容\n')
    const run = await engine.execute(preview, 'merge')
    assert.deepEqual(run.deferred, ['n.md'])
    assert.equal(await read(env.A, 'n.md'), '原文\nA 刚保存的内容\n', 'R9 download overwrote a fresh save')
    await settle(env)
    const text = await allText(env)
    assert.ok(text.includes('A 刚保存的内容') && text.includes('B 的修改'), 'R9 both versions kept')
  }
  // R9 — a local deletion planned from the cloud never removes a file
  // edited after the scan.
  {
    const env = await setup()
    await write(env.A, 'd.md', '旧\n'); await env.a(); await env.b()
    await fs.rm(join(env.B, 'd.md')); await env.b()
    const engine = env.engine(env.A, 'A')
    const preview = await engine.preview('merge')
    await write(env.A, 'd.md', '刚写的\n')
    await engine.execute(preview, 'merge')
    assert.equal(await read(env.A, 'd.md'), '刚写的\n')
    await settle(env)
    assert.ok((await allText(env)).includes('刚写的'))
  }

  // R3 — three conflicts in a row on one file: every run completes, every
  // version survives, copies are named after the device and time.
  {
    const env = await setup('Mac', 'PC')
    await write(env.A, 'x.md', '0\n'); await env.a(); await env.b()
    for (const round of [1, 2, 3]) {
      await write(env.A, 'x.md', `A${round}\n`); await write(env.B, 'x.md', `B${round}\n`)
      await env.a()
      const b = await env.b()
      assert.equal(b.conflicts, 1, `round ${round} is a conflict`)
      await env.a()
    }
    await settle(env)
    const text = await allText(env)
    for (const v of ['A3', 'B1', 'B2', 'B3']) assert.ok(text.includes(v), `R3 ${v} kept`)
    const copies = Object.keys(await contents(env.B)).filter((n) => n.includes('冲突副本'))
    assert.equal(copies.length, 3)
    for (const name of copies) assert.match(name, /^x \(冲突副本 PC \d{4}-\d{2}-\d{2} \d{4}( \d+)?\)\.md$/)
  }

  // R5 — saved after the scan, before the upload reads it: the manifest
  // records what was uploaded; the other device downloads it without error.
  {
    const env = await setup()
    await write(env.A, 'a.md', '1\n'); await env.a(); await env.b()
    await write(env.A, 'a.md', '2\n')
    const engine = env.engine(env.A, 'A')
    const preview = await engine.preview('merge')
    await write(env.A, 'a.md', '3（同步过程中保存）\n')
    await engine.execute(preview, 'merge')
    await env.b()
    assert.equal(await read(env.B, 'a.md'), '3（同步过程中保存）\n', 'R5 other device fails / stale')
    const again = await env.a()
    assert.equal(again.summary?.upload ?? 0, 0, 'nothing left to upload')
  }

  // R6 — both devices at once: the engine tags the lost manifest race, and
  // SyncService re-plans instead of reporting a failure.
  {
    const env = await setup()
    await write(env.A, 'a.md', '1\n'); await env.a(); await env.b()
    await write(env.A, 'a.md', 'A\n'); await write(env.B, 'b.md', 'B\n')
    const results = await Promise.allSettled([env.a(), env.b()])
    const lost = results.find((r) => r.status === 'rejected')
    assert.ok(lost, 'one run lost the race')
    assert.equal(lost.reason.manifestChanged, true, 'lost race tagged')
    await settle(env)
    assert.equal(await read(env.A, 'b.md'), 'B\n')
    assert.equal(await read(env.B, 'a.md'), 'A\n')

    const service = new SyncService({ getUserDataPath: () => tmpdir(), safeStorage: null, request: async () => { throw new Error('no network') } })
    let calls = 0
    service.engineFor = async () => ({
      execute: async () => {
        calls += 1
        if (calls < 3) { const error = new Error('race'); error.manifestChanged = true; throw error }
        return { summary: { upload: 1 } }
      }
    })
    const result = await service.run('/tmp/x', 'merge')
    assert.equal(calls, 3)
    assert.equal(result.summary.upload, 1)
    calls = -10
    await assert.rejects(service.run('/tmp/y', 'merge'), /race/, 'gives up after 3 attempts')
  }

  // Conflict copy names and temp files.
  {
    assert.equal(deviceLabel('Mac-mini.local'), 'Mac-mini')
    assert.equal(deviceLabel('DESKTOP-AB(1)'), 'DESKTOP-AB 1')
    assert.equal(deviceLabel(''), 'HorseMD')
    assert.match(conflictStamp(new Date(2026, 9, 29, 14, 32)), /^2026-10-29 1432$/)
    assert.equal(conflictCopyName('/a/笔记.md', 's'), '/a/笔记 (s).md')
    assert.equal(conflictCopyName('C:\\a\\b.md', 's'), 'C:\\a\\b (s).md')
    assert.ok(isSystemJunkPath('.笔记.md.123.lk2.hmtmp'))
    assert.ok(isSystemJunkPath('a.md.42.1b4e28ba-2fa1-11d2-883f-0016d3cca427.tmp'))
    assert.ok(!isSystemJunkPath('notes.tmp'))
    // A temp file present during a scan is never uploaded.
    const env = await setup()
    await write(env.A, 'ok.md', 'x\n')
    await write(env.A, '.ok.md.99.abc.hmtmp', 'half written')
    await env.a()
    assert.deepEqual([...env.store.objects.keys()].filter((k) => !k.startsWith('.horsemd/')), ['ok.md'])
  }

  console.log('PASS sync safety: unsaved open files and fresh saves never overwritten (R1/R9), repeated conflicts keep every version (R3), saving mid-upload is safe (R5), lost manifest race re-plans (R6), device-named copies, temp files never sync')
} finally {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true })
}
