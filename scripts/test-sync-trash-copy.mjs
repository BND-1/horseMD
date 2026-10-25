// #161 follow-up.
// 1. System files (.DS_Store, ._*, Thumbs.db, desktop.ini) never sync; one
//    already in the cloud is removed there (no trash copy, not listed or
//    counted as a deletion); a folder holding only a .DS_Store can still be
//    removed when another device deleted it.
// 2. Before a cloud file is deleted / replaced, its trash copy is made with a
//    server-side copy (nothing downloaded) when the copy proves the planned
//    version (ETag); otherwise download + compare + upload as before.
// 3. S3 CopyObject request: x-amz-copy-source / -if-match, signed, encoded.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SyncEngine } from '../src/main/sync/sync-engine.js'
import { buildSyncPlan, buildDirectionalSyncPlan } from '../src/main/sync/sync-plan.js'
import { scanLocalWorkspace, scanLocalEmptyDirs } from '../src/main/sync/local-files.js'
import { isSystemJunkPath } from '../src/main/sync/sync-ignore.js'
import { S3Provider } from '../src/main/sync/s3-provider.js'
import { RequestPacer } from '../src/main/sync/request-pacer.js'

class MemoryProvider {
  constructor({ copy = 'none' } = {}) {
    this.objects = new Map(); this.revision = 0; this.calls = []
    // copy: 'none' (no method), 'ok', 'retag' (copy gets a new ETag),
    // 'unsupported' (throws copyUnsupported)
    if (copy !== 'none') this.copyMode = copy
    else this.copy = undefined
  }
  async get(path) {
    this.calls.push(['get', path])
    const entry = this.objects.get(path)
    return entry ? { bytes: Buffer.from(entry.bytes), revision: entry.revision } : null
  }
  async put(path, bytes, { revision = null, createOnly = false } = {}) {
    this.calls.push(['put', path])
    const old = this.objects.get(path)
    if ((createOnly && old) || (revision && old?.revision !== revision)) throw new Error('conditional write failed')
    const next = { bytes: Buffer.from(bytes), revision: String(++this.revision) }
    this.objects.set(path, next)
    return { revision: next.revision }
  }
  async copy(from, to, { revision = null } = {}) {
    this.calls.push(['copy', from, to])
    if (this.copyMode === 'unsupported') { const e = new Error('no copy'); e.copyUnsupported = true; throw e }
    const old = this.objects.get(from)
    if (!old) return null
    const copyRevision = this.copyMode === 'retag' ? String(++this.revision) : old.revision
    this.objects.set(to, { bytes: Buffer.from(old.bytes), revision: copyRevision })
    return { revision: copyRevision }
  }
  async delete(path, { revision = null } = {}) {
    this.calls.push(['delete', path])
    const old = this.objects.get(path)
    if (revision && old && old.revision !== revision) throw new Error('conditional delete failed')
    this.objects.delete(path)
    return true
  }
  async createDirectory(path) { this.objects.set(`${path}/`, { bytes: Buffer.alloc(0), revision: String(++this.revision) }); return true }
  async removeDirectory(path) { this.objects.delete(`${path}/`); return true }
}

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-sync-trash-copy-'))
const engineFor = (provider, name, workspaceId) => new SyncEngine({
  rootPath: join(root, name), userDataPath: join(root, `${name}-profile`), workspaceId, provider, deviceName: name
})
const trashKeys = (provider) => [...provider.objects.keys()].filter(k => k.startsWith('.horsemd/trash/')).map(k => k.replace(/^\.horsemd\/trash\/[^/]+\//, ''))

try {
  // ── 1. System files ────────────────────────────────────────────────────
  for (const path of ['.DS_Store', 'a/.DS_Store', 'A/.ds_store', 'x/._note.md', 'Thumbs.db', 'b/desktop.ini']) assert.equal(isSystemJunkPath(path), true, path)
  for (const path of ['.gitignore', 'a/.config', 'note.md', 'DS_Store.md', 'a_b._c']) assert.equal(isSystemJunkPath(path), false, path)

  {
    const dir = join(root, 'scan')
    await fs.mkdir(join(dir, 'only-junk'), { recursive: true })
    await fs.mkdir(join(dir, 'notes'), { recursive: true })
    await fs.writeFile(join(dir, '.DS_Store'), 'x')
    await fs.writeFile(join(dir, 'only-junk', '.DS_Store'), 'x')
    await fs.writeFile(join(dir, 'notes', 'a.md'), 'a')
    await fs.writeFile(join(dir, 'notes', '._a.md'), 'x')
    await fs.writeFile(join(dir, '.gitignore'), 'x')
    assert.deepEqual([...(await scanLocalWorkspace(dir)).keys()].sort(), ['.gitignore', 'notes/a.md'])
    assert.deepEqual([...await scanLocalEmptyDirs(dir)], ['only-junk'], 'a folder with only a .DS_Store is an empty folder')
  }

  {
    const remote = { '.DS_Store': { sha256: 'r', revision: '9' }, 'a.md': { sha256: 'a' } }
    const plan = buildSyncPlan({ localFiles: { 'a.md': { sha256: 'a' }, 'b/.DS_Store': { sha256: 'l' } }, remoteFiles: remote, previousEntries: { 'a.md': { sha256: 'a' }, 'c/.DS_Store': { sha256: 'p' } } })
    assert.deepEqual(plan.operations.map(o => [o.type, o.path, Boolean(o.systemFile)]), [
      ['deleteRemote', '.DS_Store', true],
      ['keep', 'a.md', false]
    ])
    assert.equal(plan.summary.delete, 0, 'system-file cleanup is not counted as a deletion')
    const push = buildDirectionalSyncPlan({ localFiles: { 'x/.DS_Store': { sha256: 'l' } }, remoteFiles: remote, strategy: 'pull' })
    assert.deepEqual(push.operations.map(o => [o.type, o.path]), [['deleteRemote', '.DS_Store'], ['download', 'a.md']])
  }

  {
    // Device A uploaded .DS_Store files with an older HorseMD; now its
    // .DS_Store keeps changing. This version never uploads it and removes the
    // cloud copies, without trash copies; B never downloads them.
    const workspaceId = randomUUID()
    const provider = new MemoryProvider({ copy: 'ok' })
    await fs.mkdir(join(root, 'A', 'sub'), { recursive: true })
    await fs.mkdir(join(root, 'B'), { recursive: true })
    await fs.writeFile(join(root, 'A', 'note.md'), '# n\n')
    await fs.writeFile(join(root, 'A', '.DS_Store'), 'finder-1')
    await engineFor(provider, 'A', workspaceId).execute()
    assert.equal(provider.objects.has('.DS_Store'), false, '.DS_Store uploaded')
    // Simulate the older version's upload: in the manifest and the bucket.
    const manifest = JSON.parse((await provider.get('.horsemd/manifest.json')).bytes)
    for (const path of ['.DS_Store', 'sub/.DS_Store']) {
      const put = await provider.put(path, Buffer.from('old-finder'))
      manifest.files[path] = { sha256: 'whatever', size: 10, revision: put.revision }
    }
    await provider.put('.horsemd/manifest.json', Buffer.from(JSON.stringify(manifest)), { revision: (await provider.get('.horsemd/manifest.json')).revision })
    await fs.writeFile(join(root, 'A', '.DS_Store'), 'finder-2')
    const preview = await engineFor(provider, 'A', workspaceId).preview()
    assert.equal(preview.summary.delete, 0)
    assert.deepEqual(preview.operations.filter(o => o.systemFile).map(o => o.path), ['.DS_Store', 'sub/.DS_Store'])
    provider.calls.length = 0
    await engineFor(provider, 'A', workspaceId).execute(preview)
    assert.equal(provider.objects.has('.DS_Store') || provider.objects.has('sub/.DS_Store'), false, 'cloud .DS_Store not removed')
    assert.deepEqual(trashKeys(provider), [], 'system files got trash copies')
    assert.equal(provider.calls.some(([op, path]) => op === 'get' && /DS_Store/.test(path)), false)
    assert.equal(await fs.readFile(join(root, 'A', '.DS_Store'), 'utf8'), 'finder-2', 'local .DS_Store touched')
    await engineFor(provider, 'B', workspaceId).execute()
    await assert.rejects(fs.stat(join(root, 'B', '.DS_Store')), { code: 'ENOENT' })
    assert.equal(await fs.readFile(join(root, 'B', 'note.md'), 'utf8'), '# n\n')
    console.log('ok   system files never sync; cloud copies removed without trash; not counted as deletions')
  }

  {
    // An empty folder deleted on A; on B Finder left a .DS_Store inside it.
    const workspaceId = randomUUID()
    const provider = new MemoryProvider()
    await fs.mkdir(join(root, 'C', 'empty'), { recursive: true })
    await fs.mkdir(join(root, 'D'), { recursive: true })
    await engineFor(provider, 'C', workspaceId).execute()
    await engineFor(provider, 'D', workspaceId).execute()
    assert.ok((await fs.stat(join(root, 'D', 'empty'))).isDirectory())
    await fs.writeFile(join(root, 'D', 'empty', '.DS_Store'), 'finder')
    await fs.rmdir(join(root, 'C', 'empty'))
    await engineFor(provider, 'C', workspaceId).execute()
    await engineFor(provider, 'D', workspaceId).execute()
    await assert.rejects(fs.stat(join(root, 'D', 'empty')), { code: 'ENOENT' }, 'folder with only a .DS_Store was kept')
    // A folder that holds a real file is never removed.
    await fs.mkdir(join(root, 'C', 'keep'), { recursive: true })
    await engineFor(provider, 'C', workspaceId).execute()
    await engineFor(provider, 'D', workspaceId).execute()
    await fs.writeFile(join(root, 'D', 'keep', 'mine.md'), 'mine')
    await fs.rmdir(join(root, 'C', 'keep'))
    await engineFor(provider, 'C', workspaceId).execute()
    await engineFor(provider, 'D', workspaceId).execute()
    assert.equal(await fs.readFile(join(root, 'D', 'keep', 'mine.md'), 'utf8'), 'mine')
    console.log('ok   a folder holding only system files is removed with its folder; real files are kept')
  }

  // ── 2. Trash copy ──────────────────────────────────────────────────────
  for (const mode of ['ok', 'retag', 'unsupported', 'none']) {
    const workspaceId = randomUUID()
    const provider = new MemoryProvider({ copy: mode })
    const name = `T-${mode}`
    await fs.mkdir(join(root, name, 'assets'), { recursive: true })
    await fs.writeFile(join(root, name, 'assets', 'big.png'), Buffer.alloc(4096, 7))
    await fs.writeFile(join(root, name, 'note.md'), 'v1')
    await engineFor(provider, name, workspaceId).execute()
    await fs.rm(join(root, name, 'assets'), { recursive: true })
    provider.calls.length = 0
    await engineFor(provider, name, workspaceId).execute()
    assert.equal(provider.objects.has('assets/big.png'), false, `${mode}: not deleted`)
    assert.deepEqual(trashKeys(provider), ['assets/big.png'], `${mode}: trash copy`)
    const trashed = [...provider.objects.entries()].find(([k]) => k.endsWith('/assets/big.png') && k.startsWith('.horsemd/trash/'))[1]
    assert.deepEqual(trashed.bytes, Buffer.alloc(4096, 7), `${mode}: trash bytes`)
    const downloaded = provider.calls.some(([op, path]) => op === 'get' && path === 'assets/big.png')
    assert.equal(downloaded, mode !== 'ok', `${mode}: download ${downloaded ? 'happened' : 'skipped'}`)
    console.log(`ok   delete with copy=${mode}: trash copy kept, ${downloaded ? 'downloaded to verify' : 'nothing downloaded'}`)
  }

  {
    // The cloud file changed after the plan: the copy reports another ETag;
    // the download check refuses, nothing is deleted.
    const workspaceId = randomUUID()
    const provider = new MemoryProvider({ copy: 'ok' })
    await fs.mkdir(join(root, 'R'), { recursive: true })
    await fs.writeFile(join(root, 'R', 'n.md'), 'v1')
    await engineFor(provider, 'R', workspaceId).execute()
    await fs.rm(join(root, 'R', 'n.md'))
    const preview = await engineFor(provider, 'R', workspaceId).preview()
    await provider.put('n.md', Buffer.from('changed elsewhere'))
    await assert.rejects(engineFor(provider, 'R', workspaceId).execute(preview), /已在同步期间变化/)
    assert.equal((await provider.get('n.md')).bytes.toString(), 'changed elsewhere')
    console.log('ok   a cloud file changed after the plan is never deleted')
  }

  // ── 3. S3 CopyObject request ───────────────────────────────────────────
  {
    const seen = []
    let reply = { status: 200, body: '<CopyObjectResult><ETag>"abc123"</ETag></CopyObjectResult>' }
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        seen.push({ method: req.method, path: decodeURIComponent(new URL(req.url, 'http://x').pathname), source: req.headers['x-amz-copy-source'], ifMatch: req.headers['x-amz-copy-source-if-match'], signed: /x-amz-copy-source/.test(req.headers.authorization || '') })
        res.writeHead(reply.status)
        res.end(reply.body)
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const s3 = new S3Provider({
        endpoint: `http://127.0.0.1:${server.address().port}`, allowInsecure: true, bucket: 'b', region: 'us-east-1',
        accessKeyId: 'k', secretAccessKey: 's', prefix: 'HorseMD/ws', request: (url, init) => fetch(url, init), pacer: new RequestPacer()
      })
      assert.deepEqual(await s3.copy('硬件/爱快 路由/a(1).png', '.horsemd/trash/s/硬件/爱快 路由/a(1).png', { revision: 'abc123' }), { revision: 'abc123' })
      assert.equal(seen[0].method, 'PUT')
      assert.equal(seen[0].path, '/b/HorseMD/ws/.horsemd/trash/s/硬件/爱快 路由/a(1).png')
      assert.equal(seen[0].source, '/b/HorseMD/ws/%E7%A1%AC%E4%BB%B6/%E7%88%B1%E5%BF%AB%20%E8%B7%AF%E7%94%B1/a%281%29.png')
      assert.equal(seen[0].ifMatch, '"abc123"')
      assert.equal(seen[0].signed, true, 'copy headers not signed')
      // 数据胶囊 (measured 2026-10-25): copying a missing key answers 200 with
      // an empty ETag, and it ignores x-amz-copy-source-if-match — so the
      // engine trusts a copy only when its ETag equals the planned one.
      reply = { status: 200, body: '<CopyObjectResult><ETag>""</ETag></CopyObjectResult>' }
      assert.deepEqual(await s3.copy('a', 'b', { revision: 'x' }), { revision: '' })
      reply = { status: 200, body: '<Error><Code>InternalError</Code></Error>' }
      await assert.rejects(s3.copy('a', 'b'), (error) => error.copyUnsupported === true)
      reply = { status: 501, body: '<Error><Code>NotImplemented</Code></Error>' }
      await assert.rejects(s3.copy('a', 'b'), (error) => error.copyUnsupported === true)
      reply = { status: 412, body: '<Error><Code>PreconditionFailed</Code></Error>' }
      await assert.rejects(s3.copy('a', 'b', { revision: 'x' }), (error) => !error.copyUnsupported && /其他设备修改/.test(error.message))
      reply = { status: 404, body: '<Error><Code>NoSuchKey</Code></Error>' }
      assert.equal(await s3.copy('a', 'b'), null)
      console.log('ok   S3 CopyObject: signed x-amz-copy-source(-if-match), encoded key, errors mapped')
    } finally {
      server.close()
    }
  }
  console.log('PASS sync trash copy + system files')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
