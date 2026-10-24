// 数据胶囊 (s3.cstcloud.cn) answers HTTP 429 when a workspace with thousands
// of small files is synced. The providers must slow down and retry instead of
// failing, and a sync stopped half way must resume (the files it already
// uploaded have no manifest entry yet).
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { RequestPacer, retryAfterMs, throttleHint } from '../src/main/sync/request-pacer.js'
import { S3Provider } from '../src/main/sync/s3-provider.js'
import { WebDavProvider } from '../src/main/sync/webdav-provider.js'
import { SyncEngine } from '../src/main/sync/sync-engine.js'

const response = (status, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: new Headers(headers),
  arrayBuffer: async () => new ArrayBuffer(0),
  text: async () => ''
})

// 1. Retry-After is honored, the gap between requests grows, success shrinks it.
{
  const slept = []
  let clock = 0
  const pacer = new RequestPacer({ sleep: async (ms) => { slept.push(ms); clock += ms }, now: () => clock, random: () => 0.5 })
  const answers = [response(429, { 'retry-after': '2' }), response(503), response(200)]
  const result = await pacer.run(async () => answers.shift())
  assert.equal(result.status, 200)
  assert.equal(slept.filter((ms) => ms >= 1000)[0], 2000, 'Retry-After seconds honored')
  assert.ok(slept.includes(1500), 'backoff with jitter when no Retry-After')
  assert.ok(pacer.intervalMs > 0 && pacer.intervalMs <= 500, `gap grew: ${pacer.intervalMs}`)
  assert.equal(retryAfterMs('Wed, 21 Oct 2026 07:28:10 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')), 10000)
  for (let i = 0; i < 60; i += 1) await pacer.run(async () => response(200))
  assert.equal(pacer.intervalMs, 0, 'successes bring the gap back to zero')
}

// 2. Gives up after maxAttempts and returns the throttled answer.
{
  let calls = 0
  const pacer = new RequestPacer({ maxAttempts: 3, lockWaitMs: 0, sleep: async () => {}, random: () => 0 })
  const result = await pacer.run(async () => { calls += 1; return response(429) })
  assert.equal(result.status, 429)
  assert.equal(calls, 3)
  assert.match(throttleHint(429), /请求频率/)
  assert.equal(throttleHint(500), '')
}

// 2b. 数据胶囊's upload lock (measured 2026-10-23): after ~200 PUTs every PUT
//     is 429 for ~20 minutes, no Retry-After. The pacer must outwait it with a
//     few rare probes (not hammer it), report the wait, then keep uploads at
//     least 10 s apart while reads stay unthrottled.
{
  let clock = 0
  const events = []
  let puts = 0
  const pacer = new RequestPacer({
    sleep: async (ms) => { clock += ms },
    now: () => clock,
    random: () => 0.5,
    onThrottle: (event) => events.push(event)
  })
  const lockedUntil = 21 * 60000
  const result = await pacer.run(async () => { puts += 1; return response(clock < lockedUntil ? 429 : 200) }, { write: true })
  assert.equal(result.status, 200, 'the lock was outwaited')
  assert.ok(puts <= 20, `few probes during the lock: ${puts}`)
  assert.ok(events.some((event) => event.locked && event.resumeAt > 0), 'the long wait is reported')
  assert.ok(events.at(-1).resumed, 'the resume is reported')
  const beforeRead = clock
  await pacer.run(async () => response(200))
  assert.ok(clock - beforeRead < 1000, 'reads are not slowed by the upload gap')
  const beforeWrite = clock
  await pacer.run(async () => response(200), { write: true })
  assert.ok(clock - beforeWrite >= 9000, `uploads are spaced after a lock: ${clock - beforeWrite} ms`)
}
// 2c. A lock that outlasts lockWaitMs gives up with the 429.
{
  let clock = 0
  let calls = 0
  const pacer = new RequestPacer({ lockWaitMs: 10 * 60000, sleep: async (ms) => { clock += ms }, now: () => clock, random: () => 0.5 })
  const result = await pacer.run(async () => { calls += 1; return response(429) }, { write: true })
  assert.equal(result.status, 429)
  assert.ok(clock >= 10 * 60000 && clock < 20 * 60000, `gave up after the wait budget: ${clock}`)
  assert.ok(calls < 15, `calls ${calls}`)
}

// 2d. A connection test never waits out a lock: listing works, uploads are
//     throttled → saved with uploadThrottled, after the short retries only.
{
  let clock = 0
  const calls = []
  const s3 = new S3Provider({
    endpoint: 'https://s3.example', bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's',
    request: async (url, init) => { calls.push(init.method); return init.method === 'PUT' ? response(429) : response(200) },
    pacer: new RequestPacer({ sleep: async (ms) => { clock += ms }, now: () => clock, random: () => 0.5 })
  })
  const result = await s3.testConnection()
  assert.deepEqual(result, { ok: true, uploadThrottled: true })
  assert.equal(calls.filter((method) => method === 'PUT').length, 6, 'short retries only')
  assert.ok(clock < 60000, `no long wait: ${clock} ms`)
  let davClock = 0
  const dav = new WebDavProvider({
    endpoint: 'https://dav.example/', username: 'u', password: 'p',
    request: async (url, init) => (init.method === 'PROPFIND' ? response(207) : response(429)),
    pacer: new RequestPacer({ sleep: async (ms) => { davClock += ms }, now: () => davClock, random: () => 0.5 })
  })
  assert.deepEqual(await dav.testConnection(), { ok: true, uploadThrottled: true })
  assert.ok(davClock < 60000, `WebDAV: no long wait: ${davClock} ms`)
}

// 3. A sync that stopped half way resumes: already uploaded identical files
//    are adopted, nothing is reported as a conflict, the manifest completes.
class MemoryProvider {
  constructor() { this.objects = new Map(); this.revision = 0; this.failAfter = Infinity; this.puts = 0 }
  async get(path) {
    const entry = this.objects.get(path)
    return entry ? { bytes: Buffer.from(entry.bytes), revision: entry.revision } : null
  }
  async put(path, bytes, { revision = null, createOnly = false } = {}) {
    if (this.puts >= this.failAfter) throw new Error('S3 上传失败（HTTP 429 SlowDown）。')
    this.puts += 1
    const old = this.objects.get(path)
    if ((createOnly && old) || (revision && old?.revision !== revision)) throw new Error('远端文件已被其他设备修改，请重新同步。')
    const next = { bytes: Buffer.from(bytes), revision: String(++this.revision) }
    this.objects.set(path, next)
    return { revision: next.revision }
  }
  async delete(path) { this.objects.delete(path); return true }
}

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-sync-throttle-'))
try {
  const local = join(root, 'notes')
  await fs.mkdir(local, { recursive: true })
  for (let i = 0; i < 30; i += 1) await fs.writeFile(join(local, `note-${i}.md`), `# ${i}\n`)
  const provider = new MemoryProvider()
  const workspaceId = randomUUID()
  const engine = () => new SyncEngine({ rootPath: local, userDataPath: join(root, 'profile'), workspaceId, provider, deviceName: 'Mac' })
  provider.failAfter = 12
  await assert.rejects(engine().execute(), /HTTP 429/)
  assert.equal(provider.objects.has('.horsemd/manifest.json'), false, 'interrupted run wrote no manifest')
  provider.failAfter = Infinity
  const resumed = await engine().execute()
  assert.equal(resumed.conflicts, 0)
  const manifest = JSON.parse((await provider.get('.horsemd/manifest.json')).bytes)
  assert.equal(Object.keys(manifest.files).length, 30, 'every file is in the manifest')
  // A different remote object under the same name is still refused on merge.
  await fs.writeFile(join(local, 'other.md'), 'local\n')
  provider.objects.set('other.md', { bytes: Buffer.from('remote\n'), revision: 'x' })
  await assert.rejects(engine().execute(), /其他设备/)

  // 4. End to end: real HTTP, a fake S3 that allows 8 requests per second and
  //    answers 429 beyond that (like 数据胶囊). 40 files must all arrive.
  const stamps = []
  const store = new Map()
  let throttled = 0
  const server = http.createServer((req, res) => {
    const now = Date.now()
    while (stamps.length && now - stamps[0] > 1000) stamps.shift()
    if (stamps.length >= 8) {
      throttled += 1
      res.writeHead(429, { 'content-type': 'application/xml' })
      return res.end('<Error><Code>SlowDown</Code></Error>')
    }
    stamps.push(now)
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const key = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && store.has(key)) { res.writeHead(412); return res.end() }
        store.set(key, Buffer.concat(chunks))
        res.writeHead(200, { etag: `"${store.size}"` })
        return res.end()
      }
      if (req.method === 'GET') {
        if (!store.has(key)) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>') }
        res.writeHead(200, { etag: '"1"' })
        return res.end(store.get(key))
      }
      res.writeHead(204); res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const e2e = join(root, 'e2e')
    await fs.mkdir(e2e)
    for (let i = 0; i < 40; i += 1) await fs.writeFile(join(e2e, `n${i}.md`), `${i}\n`)
    const s3 = new S3Provider({
      endpoint: `http://127.0.0.1:${server.address().port}`, allowInsecure: true,
      bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's',
      prefix: 'HorseMD/ws', request: (url, init) => fetch(url, init),
      pacer: new RequestPacer({ baseDelayMs: 200, maxDelayMs: 2000 })
    })
    const started = Date.now()
    await new SyncEngine({ rootPath: e2e, userDataPath: join(root, 'profile-e2e'), workspaceId: randomUUID(), provider: s3 }).execute()
    const uploaded = [...store.keys()].filter((key) => /\/n\d+\.md$/.test(key)).length
    assert.equal(uploaded, 40, 'all files uploaded despite throttling')
    assert.ok(throttled > 0, 'the fake server did throttle')
    console.log(`  e2e: 40 files, ${throttled} answers were 429, ${Date.now() - started} ms`)
    // 4b. A quota like 数据胶囊's (scaled down): 15 PUTs, then every PUT is
    //     429 for 1.5 s; GETs always pass. The sync finishes and reports the wait.
    let quotaPuts = 0
    let lockedUntil = 0
    const quotaStore = new Map()
    const quota = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const key = decodeURIComponent(new URL(req.url, 'http://x').pathname)
        if (req.method === 'PUT') {
          if (Date.now() < lockedUntil) { res.writeHead(429); return res.end('<Error><Code>SlowDown</Code></Error>') }
          quotaPuts += 1
          if (quotaPuts % 15 === 0) lockedUntil = Date.now() + 1500
          quotaStore.set(key, Buffer.concat(chunks))
          res.writeHead(200, { etag: `"${quotaStore.size}"` })
          return res.end()
        }
        if (req.method === 'GET') {
          if (!quotaStore.has(key)) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>') }
          res.writeHead(200, { etag: '"1"' })
          return res.end(quotaStore.get(key))
        }
        res.writeHead(204); res.end()
      })
    })
    await new Promise((resolve) => quota.listen(0, '127.0.0.1', resolve))
    try {
      const dir = join(root, 'quota')
      await fs.mkdir(dir)
      for (let i = 0; i < 25; i += 1) await fs.writeFile(join(dir, `q${i}.md`), `${i}\n`)
      const seen = []
      const pacer = new RequestPacer({ baseDelayMs: 20, maxDelayMs: 50, maxAttempts: 3, lockProbeMs: 400, lockWaitMs: 10000, lockedWriteGapMs: 30, onThrottle: (event) => seen.push(event) })
      const quotaS3 = new S3Provider({
        endpoint: `http://127.0.0.1:${quota.address().port}`, allowInsecure: true,
        bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's',
        prefix: 'HorseMD/ws', request: (url, init) => fetch(url, init), pacer
      })
      const progress = []
      await new SyncEngine({ rootPath: dir, userDataPath: join(root, 'profile-quota'), workspaceId: randomUUID(), provider: quotaS3, onProgress: (event) => progress.push(event) }).execute()
      assert.equal([...quotaStore.keys()].filter((key) => /\/q\d+\.md$/.test(key)).length, 25, 'all files uploaded through the lock')
      assert.ok(seen.some((event) => event.locked), 'the lock was waited out')
      assert.ok(seen.some((event) => event.resumed), 'and reported as resumed')
      assert.equal(progress[0].completed, 0)
      assert.equal(progress.at(-1).completed, progress.at(-1).total)
    } finally {
      quota.close()
    }
    // WebDAV goes through the same pacer.
    let calls = 0
    const dav = new WebDavProvider({
      endpoint: 'https://dav.example/', username: 'u', password: 'p',
      request: async () => (calls += 1) < 3 ? response(429) : response(200, { etag: '"e"' }),
      pacer: new RequestPacer({ sleep: async () => {} })
    })
    assert.ok(await dav.get('a.md'))
    assert.equal(calls, 3)
  } finally {
    server.close()
  }
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

console.log('PASS sync throttle: 429/503 retried with Retry-After or backoff, requests slow down, an interrupted sync resumes')
