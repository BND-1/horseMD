// Automatic sync (hooks/useAutoSync.js → sync:run options.automatic,
// docs/cloud-sync-review.md P2): the plan is computed right before running
// and everything runs — deletions and conflicts too (what they replace is
// kept in the local version history) — except the brakes: an emptied cloud
// and a mass deletion (> 50 % of the tracked files and ≥ 10, or ≥ 100; moves
// do not count) return { needsConfirmation } and touch nothing. Both devices
// editing a Markdown file merge (the last-synced content is the ancestor);
// the same lines → conflict copy. Nothing to do → { idle } with no write.
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
const auto = (e) => e.execute(null, 'merge', { automatic: true })
const cloudFiles = () => [...provider.objects.keys()].filter((k) => !k.startsWith('.horsemd/') && !k.endsWith('/')).sort()
const read = (side, path) => fs.readFile(join(root, side, path), 'utf8')

try {
  await fs.mkdir(join(root, 'a'), { recursive: true })
  await fs.mkdir(join(root, 'b'), { recursive: true })
  await fs.writeFile(join(root, 'a', 'one.md'), '# one\n')
  await fs.writeFile(join(root, 'a', 'two.md'), '# two\n')

  // 1. Uploads, 2. downloads.
  assert.equal((await auto(a)).summary.upload, 2)
  assert.equal((await auto(b)).summary.download, 2)

  // 3. Nothing to do: idle, nothing written to the cloud.
  const writes = provider.writes
  const idle = await auto(a)
  assert.equal(idle.idle, true)
  assert.equal(provider.writes, writes, 'an idle automatic sync writes nothing')

  // 4. A deletion runs unattended (it is recoverable from the history).
  await fs.rm(join(root, 'a', 'two.md'))
  const deletion = await auto(a)
  assert.equal(deletion.needsConfirmation, undefined)
  assert.equal(deletion.summary.delete, 1)
  assert.deepEqual(cloudFiles(), ['one.md'])
  await auto(b)
  await assert.rejects(fs.access(join(root, 'b', 'two.md')), 'deletion reached the other device')

  // 5. Both devices edit one Markdown file in different places: merged,
  //    both edits on both devices, no conflict copy.
  const text = ['# 笔记', '', '第一段', '', '第二段', '', '第三段', ''].join('\n')
  await fs.writeFile(join(root, 'a', 'note.md'), text)
  await auto(a); await auto(b)
  await fs.writeFile(join(root, 'a', 'note.md'), text.replace('第一段', '第一段 A 改'))
  await fs.writeFile(join(root, 'b', 'note.md'), text.replace('第三段', '第三段 B 改'))
  await auto(a)
  const mergedRun = await auto(b)
  assert.equal(mergedRun.merged, 1)
  assert.equal(mergedRun.conflicts, 0)
  await auto(a)
  const both = text.replace('第一段', '第一段 A 改').replace('第三段', '第三段 B 改')
  assert.equal(await read('a', 'note.md'), both)
  assert.equal(await read('b', 'note.md'), both)
  assert.ok(!cloudFiles().some((name) => name.includes('冲突副本')))

  //    The same line: a conflict copy, both texts kept.
  await fs.writeFile(join(root, 'a', 'note.md'), both.replace('第二段', '第二段 A'))
  await fs.writeFile(join(root, 'b', 'note.md'), both.replace('第二段', '第二段 B'))
  await auto(a)
  const conflictRun = await auto(b)
  assert.equal(conflictRun.merged, 0)
  assert.equal(conflictRun.conflicts, 1)
  await auto(a)
  const all = (await fs.readdir(join(root, 'a'))).filter((n) => n.endsWith('.md'))
  const texts = await Promise.all(all.map((n) => read('a', n)))
  assert.ok(texts.some((t) => t.includes('第二段 A')) && texts.some((t) => t.includes('第二段 B')), 'both versions kept')

  // 6. Mass deletion: 15 of 20 tracked files at once → the brake; nothing
  //    touched; a normal (confirmed) run applies it.
  await fs.mkdir(join(root, 'a', 'batch'), { recursive: true })
  for (let i = 0; i < 17; i += 1) await fs.writeFile(join(root, 'a', 'batch', `n${i}.md`), `# ${i}\n`)
  await auto(a); await auto(b)
  for (let i = 0; i < 15; i += 1) await fs.rm(join(root, 'a', 'batch', `n${i}.md`))
  const before = cloudFiles().length
  const brake = await auto(a)
  assert.equal(brake.needsConfirmation, true)
  assert.equal(brake.reason, 'mass-delete')
  assert.equal(brake.deletions, 15)
  assert.equal(cloudFiles().length, before, 'cloud untouched')
  await a.execute(null, 'merge')
  assert.equal(cloudFiles().length, before - 15)
  await auto(b)

  //    Renaming a folder of many files is a move, not a mass deletion.
  await fs.rename(join(root, 'a', 'batch'), join(root, 'a', 'renamed'))
  const moved = await auto(a)
  assert.equal(moved.needsConfirmation, undefined, 'a folder rename never trips the brake')
  assert.ok(cloudFiles().some((name) => name.startsWith('renamed/')))

  // 7. Cloud workspace emptied: refused (a normal run throws here).
  await provider.delete('.horsemd/manifest.json')
  const reset = await auto(a)
  assert.equal(reset.needsConfirmation, true)
  assert.equal(reset.reason, 'remote-reset')
  console.log('PASS sync auto: uploads / downloads / deletions run, idle writes nothing, edits in different places merge, the same lines → conflict copy, mass deletion brakes (moves do not), emptied cloud waits')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
