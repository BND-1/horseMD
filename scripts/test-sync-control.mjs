// Pause / continue / stop a running sync (Settings › Sync). A stop records
// what was completed (manifest + local state agree), so the next sync handles
// only the rest; a stop also ends a throttling wait at once. A sync that was
// interrupted (network, 429) after uploading MODIFIED files resumes too.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SyncEngine } from '../src/main/sync/sync-engine.js'
import { SyncControl, isSyncStopped } from '../src/main/sync/sync-control.js'
import { RequestPacer } from '../src/main/sync/request-pacer.js'
import { S3Provider } from '../src/main/sync/s3-provider.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class MemoryProvider {
  constructor() { this.objects = new Map(); this.revision = 0; this.puts = []; this.failAfter = Infinity; this.delayMs = 0 }
  async get(path) {
    const entry = this.objects.get(path)
    return entry ? { bytes: Buffer.from(entry.bytes), revision: entry.revision } : null
  }
  async put(path, bytes, { revision = null, createOnly = false } = {}) {
    if (this.delayMs) await sleep(this.delayMs)
    if (this.puts.length >= this.failAfter) throw new Error('S3 上传失败（HTTP 429 SlowDown）。')
    const old = this.objects.get(path)
    if ((createOnly && old) || (revision && old?.revision !== revision)) throw new Error('远端文件已被其他设备修改，请重新同步。')
    this.puts.push(path)
    const next = { bytes: Buffer.from(bytes), revision: String(++this.revision) }
    this.objects.set(path, next)
    return { revision: next.revision }
  }
  async delete(path) { this.objects.delete(path); return true }
}

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-sync-control-'))
try {
  const local = join(root, 'notes')
  await fs.mkdir(local, { recursive: true })
  for (let i = 0; i < 30; i += 1) await fs.writeFile(join(local, `note-${String(i).padStart(2, '0')}.md`), `# ${i}\n`)
  const provider = new MemoryProvider()
  const workspaceId = randomUUID()
  const profile = join(root, 'profile')
  const engine = (control = null, onProgress = null) => new SyncEngine({ rootPath: local, userDataPath: profile, workspaceId, provider, deviceName: 'Mac', control, onProgress })
  const manifest = () => JSON.parse(provider.objects.get('.horsemd/manifest.json').bytes)

  // 1. Stop after 10 files: those are recorded; the next run uploads the rest.
  {
    const control = new SyncControl()
    const result = await engine(control, (p) => { if (p.completed === 10) control.stop() }).execute()
    assert.equal(result.stopped, true)
    assert.equal(result.recorded, true)
    assert.equal(result.completed, 10)
    assert.equal(Object.keys(manifest().files).length, 10, 'manifest has the completed files')
    const state = JSON.parse(await fs.readFile(join(profile, 'sync', 'state', `${workspaceId}.json`), 'utf8'))
    assert.equal(Object.keys(state.files).length, 10, 'local state agrees with the manifest')
    provider.puts = []
    const next = await engine().execute()
    assert.equal(next.stopped, undefined)
    assert.equal(next.conflicts, 0)
    assert.equal(provider.puts.filter((path) => path.endsWith('.md')).length, 20, 'only the rest is uploaded')
    assert.equal(Object.keys(manifest().files).length, 30)
  }

  // 2. Modified files: stop half way, continue — no conflict, no error.
  {
    for (let i = 0; i < 8; i += 1) await fs.writeFile(join(local, `note-${String(i).padStart(2, '0')}.md`), `# ${i} edited\n`)
    const control = new SyncControl()
    const stopped = await engine(control, (p) => { if (p.completed === 3) control.stop() }).execute()
    assert.equal(stopped.completed, 3)
    provider.puts = []
    const next = await engine().execute()
    assert.equal(next.conflicts, 0)
    assert.equal(provider.puts.filter((path) => path.endsWith('.md')).length, 5)
    assert.equal(manifest().files['note-07.md'].sha256.length, 64)
  }

  // 3. An interrupted run (429 thrown) after uploading MODIFIED files: the
  //    next run adopts the objects that already hold the new bytes.
  {
    for (let i = 10; i < 16; i += 1) await fs.writeFile(join(local, `note-${i}.md`), `# ${i} edited again\n`)
    provider.puts = []
    provider.failAfter = 3
    await assert.rejects(engine().execute(), /HTTP 429/)
    provider.failAfter = Infinity
    const next = await engine().execute()
    assert.equal(next.conflicts, 0, 'resumed without a conflict')
    const remote = JSON.parse(provider.objects.get('.horsemd/manifest.json').bytes)
    assert.equal((await provider.get('note-12.md')).bytes.toString(), '# 12 edited again\n')
    assert.equal(remote.files['note-12.md'].revision, provider.objects.get('note-12.md').revision)
  }

  // 4. Pause holds between files; continue finishes. The pause is reported
  //    as requested first, then as holding once the file in flight is done.
  {
    for (let i = 20; i < 30; i += 1) await fs.writeFile(join(local, `note-${i}.md`), `# ${i} paused run\n`)
    const events = []
    const control = new SyncControl({ onChange: (event) => events.push(event) })
    provider.puts = []
    const running = engine(control, (p) => { if (p.completed === 4) control.pause() }).execute()
    await sleep(150)
    const whilePaused = provider.puts.length
    await sleep(200)
    assert.equal(provider.puts.length, whilePaused, 'nothing uploaded while paused')
    assert.equal(whilePaused, 4)
    assert.deepEqual(events.slice(0, 2), [{ paused: true }, { paused: true, holding: true }], 'requested, then holding')
    control.resume()
    const done = await running
    assert.equal(done.stopped, undefined)
    assert.equal(provider.puts.filter((path) => path.endsWith('.md')).length, 10)
  }

  // 5. Stop while paused ends the run.
  {
    await fs.writeFile(join(local, 'note-29.md'), '# 29 once more\n')
    await fs.writeFile(join(local, 'note-28.md'), '# 28 once more\n')
    const control = new SyncControl()
    const running = engine(control, (p) => { if (p.completed === 1) control.pause() }).execute()
    await sleep(100)
    control.stop()
    const result = await running
    assert.equal(result.stopped, true)
    assert.equal(result.completed, 1)
  }

  // 6. A stop during a long throttling wait (数据胶囊's upload lock) ends the
  //    wait at once instead of after minutes.
  {
    const control = new SyncControl()
    const pacer = new RequestPacer({ baseDelayMs: 10, maxAttempts: 2, lockProbeMs: 120000, lockWaitMs: 3600000 })
    pacer.sleep = (ms) => control.sleep(ms)
    const s3 = new S3Provider({
      endpoint: 'https://s3.example', bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's',
      request: async (url, init) => ({ status: init.method === 'PUT' ? 429 : 404, ok: false, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' }),
      pacer
    })
    const started = Date.now()
    setTimeout(() => control.stop(), 300)
    await assert.rejects(s3.put('a.md', Buffer.from('x')), (error) => isSyncStopped(error))
    assert.ok(Date.now() - started < 2000, `stopped within the wait: ${Date.now() - started} ms`)
  }
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
console.log('PASS sync control: pause holds, stop records progress, the next sync continues, stop ends a throttling wait')
