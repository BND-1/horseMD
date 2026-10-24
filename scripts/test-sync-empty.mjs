// Empty files and empty folders between two devices. S3 has no directories:
// an empty folder exists remotely only as a zero-byte "path/" marker object
// (what the AWS console, rclone and S3 browsers create), so a sync that only
// uploads files silently loses empty folders. Folders with files need no
// marker. Deleting only ever removes EMPTY folders.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SyncEngine } from '../src/main/sync/sync-engine.js'
import { S3Provider } from '../src/main/sync/s3-provider.js'
import { WebDavProvider } from '../src/main/sync/webdav-provider.js'
import { RequestPacer } from '../src/main/sync/request-pacer.js'

// Object store with S3 semantics: keys only, "dir/" markers are objects.
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

async function tree(dir, prefix = '') {
  const out = []
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.horsemd') continue
    const path = prefix + entry.name
    if (entry.isDirectory()) { out.push(`${path}/`); out.push(...await tree(join(dir, entry.name), `${path}/`)) }
    else out.push(`${path} ${(await fs.stat(join(dir, entry.name))).size}B`)
  }
  return out
}

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-sync-empty-'))
try {
  const A = join(root, 'A')
  const B = join(root, 'B')
  await fs.mkdir(join(A, '空目录'), { recursive: true })
  await fs.mkdir(join(A, '深', '层', '目录'), { recursive: true })
  await fs.mkdir(join(A, '有文件'), { recursive: true })
  await fs.writeFile(join(A, '空文件.md'), '')
  await fs.writeFile(join(A, '有文件', 'a.md'), '# a\n')
  await fs.mkdir(B)
  const store = new MemoryStore()
  const workspaceId = randomUUID()
  const sync = (dir, strategy = 'merge') => new SyncEngine({ rootPath: dir, userDataPath: join(root, `profile-${dir === A ? 'A' : 'B'}`), workspaceId, provider: store, deviceName: dir === A ? 'A' : 'B' }).execute(null, strategy)

  // 1. Empty file and empty folders reach the other device.
  await sync(A)
  assert.ok(store.objects.has('空目录/'), 'S3-style marker for the empty folder')
  assert.ok(store.objects.has('深/层/目录/'), 'only the leaf needs a marker')
  assert.ok(!store.objects.has('深/') && !store.objects.has('深/层/'), 'parents are implied')
  assert.ok(!store.objects.has('有文件/'), 'a folder with files needs no marker')
  assert.equal(store.objects.get('空文件.md').bytes.length, 0)
  await sync(B)
  assert.deepEqual(await tree(B), ['有文件/', '有文件/a.md 4B', '深/', '深/层/', '深/层/目录/', '空文件.md 0B', '空目录/'])
  // Nothing more to do on either side.
  const again = await sync(A)
  assert.deepEqual([again.summary.upload, again.summary.download, again.summary.delete], [0, 0, 0])

  // 2. A file put into the empty folder on B: the marker goes away, the
  //    folder (with its file) stays on A.
  await fs.writeFile(join(B, '空目录', 'new.md'), 'new\n')
  const filled = await sync(B)
  assert.equal(filled.summary.delete, 0, 'a folder that got a file is not a deletion')
  // The marker stays (never DELETE a folder that holds files: some services
  // delete "folder/" recursively); the manifest just stops listing it.
  assert.ok(store.objects.has('空目录/') && store.objects.has('空目录/new.md'))
  const filledA = await sync(A)
  assert.equal(filledA.summary.delete, 0)
  assert.equal(await fs.readFile(join(A, '空目录', 'new.md'), 'utf8'), 'new\n')

  // 3. An empty folder removed on A is removed on B (it is still empty).
  await fs.rmdir(join(A, '深', '层', '目录'))
  const removed = await sync(A)
  assert.equal(removed.summary.delete, 1)
  assert.ok(!store.objects.has('深/层/目录/'))
  // A now has the empty folder 深/层 itself: that one is synced as a folder.
  assert.ok(store.objects.has('深/层/'))
  await sync(B)
  assert.deepEqual((await tree(B)).filter((line) => line.startsWith('深')), ['深/', '深/层/'])

  // 4. Removed on A while B put a file into it: B keeps the folder and file.
  await fs.mkdir(join(A, '待删'))
  await sync(A)
  await sync(B)
  await fs.writeFile(join(B, '待删', 'keep.md'), 'keep\n')
  await fs.rmdir(join(A, '待删'))
  await sync(A)
  await sync(B)
  assert.equal(await fs.readFile(join(B, '待删', 'keep.md'), 'utf8'), 'keep\n', 'never removes a folder that is not empty')
  await sync(A)
  assert.equal(await fs.readFile(join(A, '待删', 'keep.md'), 'utf8'), 'keep\n')

  // 5. Explicit push / pull also carry empty folders.
  const C = join(root, 'C')
  await fs.mkdir(join(C, '推送的空目录'), { recursive: true })
  const pushed = await new SyncEngine({ rootPath: C, userDataPath: join(root, 'profile-C'), workspaceId: randomUUID(), provider: new MemoryStore() })
  const pushStore = pushed.provider
  await pushed.execute(null, 'push')
  assert.ok(pushStore.objects.has('推送的空目录/'))
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

// 6. Real S3 requests: the marker key ends with "/" (URL path), zero bytes.
//    A marker is deleted only after a listing shows nothing else in the
//    folder: 数据胶囊 deletes "folder/" RECURSIVELY (every object under it).
{
  const seen = []
  let inside = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const path = decodeURIComponent(url.pathname)
      seen.push({ method: req.method, path: url.searchParams.get('list-type') ? `${path}?prefix=${url.searchParams.get('prefix')}` : path, size: Buffer.concat(chunks).length, type: req.headers['content-type'] })
      if (url.searchParams.get('list-type')) {
        res.writeHead(200)
        return res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${inside.map((key) => `<Contents><Key>${key}</Key><Size>0</Size></Contents>`).join('')}</ListBucketResult>`)
      }
      res.writeHead(req.method === 'DELETE' ? 204 : 200, { etag: '"1"' })
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const s3 = new S3Provider({
      endpoint: `http://127.0.0.1:${server.address().port}`, allowInsecure: true, bucket: 'b', region: 'us-east-1',
      accessKeyId: 'k', secretAccessKey: 's', prefix: 'HorseMD/ws', request: (url, init) => fetch(url, init), pacer: new RequestPacer()
    })
    await s3.createDirectory('深/层 目录')
    inside = ['HorseMD/ws/深/层 目录/']
    assert.equal(await s3.removeDirectory('深/层 目录'), true)
    await s3.put('空.md', Buffer.alloc(0))
    assert.deepEqual(seen.map(({ method, path, size }) => [method, path, size]), [
      ['PUT', '/b/HorseMD/ws/深/层 目录/', 0],
      ['GET', '/b?prefix=HorseMD/ws/深/层 目录/', 0],
      ['DELETE', '/b/HorseMD/ws/深/层 目录/', 0],
      ['PUT', '/b/HorseMD/ws/空.md', 0]
    ])
    assert.equal(seen[0].type, 'application/x-directory')
    // Something inside (here a file another device just put there): no DELETE.
    seen.length = 0
    inside = ['HorseMD/ws/x/', 'HorseMD/ws/x/keep.md']
    assert.equal(await s3.removeDirectory('x'), false)
    assert.deepEqual(seen.map(({ method }) => method), ['GET'], 'never DELETE a folder that is not empty')
  } finally {
    server.close()
  }
}

// 7. WebDAV: MKCOL for parents and the folder; a collection is deleted only
//    while PROPFIND shows it empty (DELETE on a collection is recursive).
{
  const calls = []
  let children = 0
  const multistatus = (count) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${Array.from({ length: count + 1 }, (_, i) => `<d:response><d:href>/dav/x/${i ? `f${i}` : ''}</d:href><d:propstat><d:prop><d:resourcetype>${i ? '' : '<d:collection/>'}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`
  const dav = new WebDavProvider({
    endpoint: 'https://dav.example/dav/', username: 'u', password: 'p',
    request: async (url, init) => {
      calls.push(`${init.method} ${decodeURIComponent(new URL(url).pathname)}`)
      if (init.method === 'PROPFIND') return { status: 207, ok: true, headers: new Headers(), text: async () => multistatus(children) }
      return { status: init.method === 'MKCOL' ? 201 : 204, ok: true, headers: new Headers(), text: async () => '' }
    },
    pacer: new RequestPacer({ sleep: async () => {} })
  })
  await dav.createDirectory('深/层')
  assert.deepEqual(calls.splice(0), ['MKCOL /dav/深', 'MKCOL /dav/深/层'])
  children = 1
  assert.equal(await dav.removeDirectory('x'), false)
  assert.deepEqual(calls.splice(0), ['PROPFIND /dav/x'], 'not empty: no DELETE')
  children = 0
  assert.equal(await dav.removeDirectory('x'), true)
  assert.deepEqual(calls.splice(0), ['PROPFIND /dav/x', 'DELETE /dav/x/'])
}

console.log('PASS sync empty: empty files and empty folders sync both ways (S3 "path/" markers, WebDAV collections), only empty folders are removed')
