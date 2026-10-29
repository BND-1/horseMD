// Local version history (docs/cloud-sync-review.md P1): the store, its
// retention, the save / delete / sync hooks and the IPC actions.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, randomBytes } from 'node:crypto'
import { HistoryStore, versionsToKeep, HOUR, DAY } from '../src/main/history/history-store.js'
import { initHistory, historyStore, recordBeforeSave, recordBeforeTrash, registerHistoryIpc, syncHistory } from '../src/main/history/history-service.js'
import { SyncEngine } from '../src/main/sync/sync-engine.js'

const roots = []
const temp = async (name) => { const dir = await fs.mkdtemp(join(tmpdir(), `hm-history-${name}-`)); roots.push(dir); return dir }

class MemoryStore {
  constructor() { this.objects = new Map(); this.revision = 0 }
  async get(path) { const e = this.objects.get(path); return e ? { bytes: Buffer.from(e.bytes), revision: e.revision } : null }
  async put(path, bytes, { revision = null, createOnly = false } = {}) {
    const old = this.objects.get(path)
    if ((createOnly && old) || (revision && old?.revision !== revision)) throw new Error('conflict')
    const next = { bytes: Buffer.from(bytes), revision: String(++this.revision) }
    this.objects.set(path, next)
    return { revision: next.revision }
  }
  async delete(path) { this.objects.delete(path); return true }
  async createDirectory() { return true }
  async removeDirectory() { return true }
}

try {
  // 1. Record / list / read / dedup / throttle / force / pin.
  {
    let clock = Date.UTC(2026, 9, 29, 12)
    const store = new HistoryStore({ root: await temp('store'), now: () => clock })
    const file = join(tmpdir(), 'x', '笔记.md')
    assert.ok(await store.record(file, '版本一', 'save'))
    assert.equal(await store.record(file, '版本一', 'save'), null, 'same content twice in a row is stored once')
    clock += 60000
    assert.equal(await store.record(file, '版本二', 'save', { throttleMs: 120000 }), null, 'throttled')
    assert.ok(await store.record(file, '版本二', 'save', { throttleMs: 120000, force: true }), 'force overrides the throttle')
    clock += 180000
    assert.ok(await store.record(file, '版本三', 'sync-overwrite'))
    const list = await store.list(file)
    assert.deepEqual(list.map((v) => v.reason), ['sync-overwrite', 'save', 'save'])
    assert.equal((await store.read(file, list[1].id)).toString(), '版本二')
    await store.pin(file, list[2].id, true)
    assert.equal((await store.list(file))[2].pinned, true)
    // Case-insensitive disks share one history per file.
    if (process.platform !== 'linux') assert.equal((await store.list(file.toUpperCase())).length, 3)
  }

  // 2. Thinning: all < 1 h, hourly < 1 day, daily < 30 days, weekly up to the
  //    retention, nothing older, pinned always, newest kept.
  {
    const now = Date.UTC(2026, 9, 29, 12)
    const versions = []
    let n = 0
    const add = (age, extra = {}) => versions.push({ id: `v${n++}`, at: now - age, ...extra })
    for (let m = 0; m < 50; m += 5) add(m * 60000) // 10 within the hour
    for (let h = 2; h < 24; h += 1) { add(h * HOUR); add(h * HOUR + 60000) } // 2 per hour, 22 hours
    for (let d = 2; d < 30; d += 1) { add(d * DAY); add(d * DAY + HOUR) } // 2 per day, 28 days
    add(45 * DAY); add(80 * DAY)
    add(400 * DAY, { pinned: true })
    const keep30 = versionsToKeep(versions, { now, retentionDays: 30 })
    const kept = (ages) => versions.filter((v) => keep30.has(v.id) && ages(now - v.at)).length
    assert.equal(kept((a) => a < HOUR), 10)
    assert.ok(kept((a) => a >= HOUR && a < DAY) <= 23 && kept((a) => a >= HOUR && a < DAY) >= 21, 'one per hour')
    assert.ok(kept((a) => a >= DAY && a < 30 * DAY) <= 29 && kept((a) => a >= DAY && a < 30 * DAY) >= 27, 'one per day')
    assert.equal(kept((a) => a > 30 * DAY && a < 100 * DAY), 0, 'older than 30 days dropped')
    assert.ok(keep30.has(`v${n - 1}`), 'pinned kept forever')
    const keep90 = versionsToKeep(versions, { now, retentionDays: 90 })
    assert.equal(versions.filter((v) => keep90.has(v.id) && now - v.at > 30 * DAY && !v.pinned).length, 2, 'weekly up to 90 days')
  }

  // 3. Prune: retention + size cap + unreferenced content.
  {
    let clock = Date.UTC(2026, 9, 29, 12)
    const root = await temp('prune')
    const store = new HistoryStore({ root, now: () => clock, capBytes: 1 << 20 })
    const file = join(tmpdir(), 'p', 'big.md')
    const pinned = await store.record(file, randomBytes(200000).toString('hex'), 'save') // ~400 KB, compresses ~50%
    await store.pin(file, pinned.id, true)
    for (let i = 0; i < 12; i += 1) {
      clock += 2 * HOUR
      await store.record(join(tmpdir(), 'p', `f${i}.md`), randomBytes(100000).toString('hex'), 'save')
    }
    // As in real use, the content dropped by the cap is old (content written
    // in the last minute is never collected — it may belong to a record in
    // flight).
    const age = async () => {
      for (const sub of await fs.readdir(join(root, 'objects'))) {
        for (const name of await fs.readdir(join(root, 'objects', sub))) await fs.utimes(join(root, 'objects', sub, name), new Date(2020, 0, 1), new Date(2020, 0, 1))
      }
    }
    await age()
    await store.prune()
    const usage = await store.usage()
    assert.ok(usage.bytes <= 1 << 20, `under the cap: ${usage.bytes}`)
    assert.equal((await store.list(file)).length, 1, 'pinned version survives the cap')
    assert.equal((await store.list(join(tmpdir(), 'p', 'f11.md'))).length, 1, 'newest survives')
    assert.equal((await store.list(join(tmpdir(), 'p', 'f0.md'))).length, 0, 'oldest dropped first')
    // Retention: 40 days later only the pinned one is left.
    clock += 40 * DAY
    await store.prune()
    assert.equal((await store.usage()).versions, 1)
    // Unreferenced (old) content was collected in the same prune.
    const objects = join(root, 'objects')
    let left = 0
    for (const sub of await fs.readdir(objects)) left += (await fs.readdir(join(objects, sub))).length
    assert.equal(left, 1, 'only the pinned content is left')
  }

  // 4. Deleted files, moves, usage, clear.
  {
    const store = new HistoryStore({ root: await temp('deleted') })
    const dir = join(tmpdir(), 'd')
    await store.recordDeletion(join(dir, 'gone.md'), '删掉的内容', 'delete')
    const [item] = await store.listDeleted()
    assert.equal(item.reason, 'delete')
    assert.equal((await store.readDeleted(item.id)).toString(), '删掉的内容')
    assert.equal((await store.list(join(dir, 'gone.md')))[0].reason, 'delete', 'a deletion is also a version')
    await store.forgetDeleted(item.id)
    assert.equal((await store.listDeleted()).length, 0)
    await store.record(join(dir, 'a', 'one.md'), '1', 'save')
    await store.record(join(dir, 'a', 'sub', 'two.md'), '2', 'save')
    await store.movePath(join(dir, 'a'), join(dir, 'b'))
    assert.equal((await store.list(join(dir, 'b', 'sub', 'two.md'))).length, 1, 'folder move carries history')
    assert.equal((await store.list(join(dir, 'a', 'one.md'))).length, 0)
    await store.movePath(join(dir, 'b', 'one.md'), join(dir, 'b', 'uno.md'))
    assert.equal((await store.list(join(dir, 'b', 'uno.md'))).length, 1, 'file rename carries history')
    assert.ok((await store.usage()).versions >= 3)
    await store.clear()
    assert.equal((await store.usage()).versions, 0)
  }

  // 5. Hooks: save (throttle, big deletion forces), in-app delete, sync.
  {
    const root = await temp('hooks')
    initHistory(join(root, 'history'))
    const work = await temp('work')
    const note = join(work, '笔记.md')
    const long = '很长的一段正文。'.repeat(100)
    await fs.writeFile(note, long)
    await recordBeforeSave(note, long + '加一句')
    await fs.writeFile(note, long + '加一句')
    await recordBeforeSave(note, long + '加两句') // within 5 minutes: throttled
    await fs.writeFile(note, long + '加两句')
    assert.equal((await historyStore().list(note)).length, 1)
    await recordBeforeSave(note, '') // select-all + delete: always kept
    assert.equal((await historyStore().list(note)).length, 2)
    assert.equal((await historyStore().read(note, (await historyStore().list(note))[0].id)).toString(), long + '加两句')
    await recordBeforeTrash(note)
    assert.equal((await historyStore().listDeleted())[0].path, note)

    // Sync: a deletion and an overwrite from the other device land in the
    // history; nothing is written into the user's folder.
    const A = await temp('A'), B = await temp('B')
    const provider = new MemoryStore()
    const ws = randomUUID()
    const engine = (dir, label) => new SyncEngine({ rootPath: dir, userDataPath: join(root, 'state-' + label), workspaceId: ws, provider, deviceName: label, history: syncHistory })
    await fs.writeFile(join(A, 'keep.md'), '旧内容\n'); await fs.writeFile(join(A, 'drop.md'), '要删的\n')
    await engine(A, 'A').execute(); await engine(B, 'B').execute()
    await fs.writeFile(join(B, 'keep.md'), '新内容\n'); await fs.rm(join(B, 'drop.md'))
    await engine(B, 'B').execute(); await engine(A, 'A').execute()
    assert.equal(await fs.readFile(join(A, 'keep.md'), 'utf8'), '新内容\n')
    const overwritten = await historyStore().list(join(A, 'keep.md'))
    assert.equal(overwritten[0].reason, 'sync-overwrite')
    assert.equal((await historyStore().read(join(A, 'keep.md'), overwritten[0].id)).toString(), '旧内容\n')
    const deleted = (await historyStore().listDeleted()).find((i) => i.path === join(A, 'drop.md'))
    assert.equal(deleted?.reason, 'sync-delete')
    await assert.rejects(fs.access(join(A, '.horsemd', 'trash')), 'no trash folder in the user folder any more')

    // IPC: restore a version (current kept first), restore a deleted file
    // next to an existing one.
    const handlers = new Map()
    registerHistoryIpc({ handle: (name, fn) => handlers.set(name, fn) })
    const call = (name, ...args) => handlers.get(name)({}, ...args)
    const { versions } = await call('history:list', join(A, 'keep.md'))
    await call('history:restore', join(A, 'keep.md'), versions[0].id)
    assert.equal(await fs.readFile(join(A, 'keep.md'), 'utf8'), '旧内容\n')
    assert.equal((await call('history:list', join(A, 'keep.md'))).versions[0].reason, 'restore', 'the restore itself can be undone')
    const read = await call('history:read', join(A, 'keep.md'), versions[0].id)
    assert.deepEqual([read.binary, read.content], [false, '旧内容\n'])
    await fs.writeFile(join(A, 'drop.md'), '同名的新文件\n')
    const restored = await call('history:restoreDeleted', deleted.id)
    assert.match(restored.path, /drop \(已恢复 \d{4}-\d{2}-\d{2} \d{4}\)\.md$/)
    assert.equal(await fs.readFile(restored.path, 'utf8'), '要删的\n')
    assert.equal(await fs.readFile(join(A, 'drop.md'), 'utf8'), '同名的新文件\n', 'never overwrites')
    const usage = await call('history:usage')
    assert.ok(usage.versions > 0 && usage.bytes > 0)
    await call('history:configure', { retentionDays: 90 })
    assert.equal(historyStore().retentionDays, 90)
  }

  console.log('PASS history store: record / dedup / throttle / force / pin, thinning + retention + size cap + GC, deleted files, moves, save / delete / sync hooks, restore (undoable), restore deleted without overwriting')
} finally {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true })
}
