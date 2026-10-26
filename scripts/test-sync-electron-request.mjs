// #161: 七牛 sends `content-disposition: attachment; filename="<key>"` with the
// key's Chinese characters as raw UTF-8. Electron's net.fetch throws on such a
// header inside its own listener and never settles, so every Chinese-named
// download timed out. Sync requests now go through net.request
// (src/main/sync/electron-request.js). Runs in a bare Electron main process
// against a raw local HTTP server that sends exactly that header, plus:
// empty-body PUT keeps Content-Length: 0, 204, PROPFIND, abort before the
// headers and in the middle of the body, a connection dropped mid-body, and no HTTP-cache reuse.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import electronPath from 'electron'

const seen = []
const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const head = buffer.subarray(0, end).toString('latin1')
    const [line, ...rest] = head.split('\r\n')
    const [method, path] = line.split(' ')
    const headers = Object.fromEntries(rest.map((h) => [h.slice(0, h.indexOf(':')).toLowerCase(), h.slice(h.indexOf(':') + 1).trim()]))
    const length = Number(headers['content-length'] || 0)
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length).toString()
    buffer = buffer.subarray(end + 4 + length)
    seen.push({ method, path, headers, body })
    const send = (status, extra, payload = '') => socket.write(Buffer.concat([
      Buffer.from(`HTTP/1.1 ${status}\r\n`, 'latin1'),
      ...extra.map((h) => Buffer.concat([Buffer.isBuffer(h) ? h : Buffer.from(h, 'latin1'), Buffer.from('\r\n')])),
      Buffer.from(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n`, 'latin1'),
      Buffer.from(payload)
    ]))
    if (path.startsWith('/qiniu/')) {
      // The exact shape 七牛 sends: raw UTF-8 inside the quoted filename.
      const name = decodeURIComponent(path.slice('/qiniu/'.length))
      send('200 OK', [Buffer.from(`Content-Disposition: attachment; filename="notes/${name}"; filename*=utf-8''notes%2F${encodeURIComponent(name)}`, 'utf8'), 'ETag: "abc"'], `body of ${name}`)
    } else if (path === '/put') send('200 OK', ['ETag: "p1"'], '')
    else if (path === '/empty') send('204 No Content', [])
    else if (path === '/propfind') send('207 Multi-Status', ['Content-Type: application/xml'], '<multistatus/>')
    else if (path === '/cached') send('200 OK', ['Cache-Control: max-age=3600', 'ETag: "c1"'], `hit ${seen.filter((s) => s.path === '/cached').length}`)
    else if (path === '/hang') { /* never answers */ }
    // (A Content-Type, as S3 always sends: without one Chromium sniffs and
    // holds the headers back until the body is complete.)
    else if (path === '/stall') socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 100\r\n\r\nonly part')
    else if (path === '/cut') { socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 100\r\n\r\nonly part'); setTimeout(() => socket.destroy(), 200) }
    else send('404 Not Found', [])
  })
  socket.on('error', () => {})
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const root = await mkdtemp(join(tmpdir(), 'horsemd-electron-request-'))
const resultFile = join(root, 'result.json')
const moduleUrl = pathToFileURL(join(process.cwd(), 'src/main/sync/electron-request.js')).href
const syncRequestUrl = pathToFileURL(join(process.cwd(), 'src/main/sync/sync-request.js')).href
const main = join(root, 'main.mjs')
await writeFile(main, `
import { app, net } from 'electron'
import { writeFileSync } from 'node:fs'
import { createElectronRequest } from ${JSON.stringify(moduleUrl)}
import { createSyncRequest } from ${JSON.stringify(syncRequestUrl)}
const base = ${JSON.stringify(base)}
const uncaught = []
process.on('uncaughtException', (e) => uncaught.push(String(e && e.message || e)))
app.whenReady().then(async () => {
  const out = {}
  setInterval(() => writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ ...out, partial: true, uncaught })), 200)
  const request = createElectronRequest(net)
  const settle = (p, ms) => Promise.race([p.then((r) => ({ settled: true, status: r.status })), new Promise((r) => setTimeout(() => r({ settled: false }), ms))]).catch((e) => ({ settled: true, error: String(e.message) }))
  try {
    const r = await request(base + '/qiniu/' + encodeURIComponent('欢迎.md'), { method: 'GET', headers: { 'x-amz-date': '20261026T000000Z' } })
    out.qiniu = { status: r.status, body: await r.text(), etag: r.headers.get('etag'), disposition: r.headers.get('content-disposition') }
    // The old path, for the record: net.fetch on the same response.
    out.netFetch = await settle(net.fetch(base + '/qiniu/' + encodeURIComponent('欢迎.md')), 3000)
    const put = await request(base + '/put', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(0) })
    out.emptyPut = { status: put.status, etag: put.headers.get('etag') }
    const put5 = await request(base + '/put', { method: 'PUT', body: Buffer.from('hello') })
    out.put5 = { status: put5.status }
    const del = await request(base + '/empty', { method: 'DELETE' })
    out.del = { status: del.status, ok: del.ok, body: await del.text() }
    const pf = await request(base + '/propfind', { method: 'PROPFIND', headers: { depth: '1' }, body: '<propfind/>' })
    out.propfind = { status: pf.status, body: await pf.text() }
    const c1 = await (await request(base + '/cached')).text()
    const c2 = await (await request(base + '/cached')).text()
    out.cached = [c1, c2]
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    out.abortHeaders = await request(base + '/hang', { signal: controller.signal }).then(() => 'resolved', (e) => e.name)
    const c3 = new AbortController()
    const stall = await request(base + '/stall', { signal: c3.signal })
    setTimeout(() => c3.abort(), 300)
    out.abortBody = await stall.arrayBuffer().then(() => 'resolved', (e) => e.name)
    out.cut = await request(base + '/cut').then((r) => r.arrayBuffer()).then(() => 'resolved', (e) => 'rejected')
    // Through the sync wrapper: a timeout while the body stalls.
    const wrapped = createSyncRequest(request, { baseTimeoutMs: 600 })
    out.syncTimeout = await wrapped(base + '/stall', { method: 'GET' }).then(() => 'resolved', (e) => e.name)
    out.syncQiniu = await (await wrapped(base + '/qiniu/' + encodeURIComponent('图片.png'), { method: 'GET' })).text()
  } catch (e) {
    out.error = String(e && e.stack || e)
  }
  out.uncaught = uncaught
  writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(out))
  app.exit(0)
})
`)

try {
  const child = spawn(electronPath, [main, `--user-data-dir=${join(root, 'profile')}`], { stdio: 'ignore' })
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 60000))
  ])
  if (!exited) child.kill('SIGKILL')
  assert.ok(exited, `Electron did not finish: ${await readFile(resultFile, 'utf8').catch(() => 'no result')}`)
  const out = JSON.parse(await readFile(resultFile, 'utf8'))
  assert.equal(out.error, undefined, out.error)

  // The 七牛 response: settles, body and ETag intact, header kept as bytes.
  assert.equal(out.qiniu.status, 200)
  assert.equal(out.qiniu.body, 'body of 欢迎.md')
  assert.equal(out.qiniu.etag, '"abc"')
  assert.equal(Buffer.from(out.qiniu.disposition, 'latin1').toString('utf8'), `attachment; filename="notes/欢迎.md"; filename*=utf-8''notes%2F${encodeURIComponent('欢迎.md')}`)
  assert.equal(out.syncQiniu, 'body of 图片.png')
  console.log(`net.fetch on the same response: ${out.netFetch.settled ? 'settled' : 'never settled (Electron bug, #161)'}`)

  assert.deepEqual(out.emptyPut, { status: 200, etag: '"p1"' })
  const puts = seen.filter((s) => s.path === '/put')
  assert.equal(puts[0].headers['content-length'], '0', 'empty PUT announces Content-Length: 0')
  assert.equal(puts[0].headers['content-type'], 'application/octet-stream')
  assert.equal(puts[1].body, 'hello')
  assert.deepEqual(out.del, { status: 204, ok: true, body: '' })
  assert.deepEqual(out.propfind, { status: 207, body: '<multistatus/>' })
  assert.equal(seen.find((s) => s.method === 'PROPFIND').headers.depth, '1')
  assert.deepEqual(out.cached, ['hit 1', 'hit 2'], 'never served from the HTTP cache')
  assert.equal(seen.find((s) => s.path.startsWith('/qiniu/')).headers['x-amz-date'], '20261026T000000Z')
  assert.equal(out.abortHeaders, 'AbortError')
  assert.equal(out.abortBody, 'AbortError')
  assert.equal(out.cut, 'rejected', 'a connection dropped mid-body fails the read')
  assert.equal(out.syncTimeout, 'SyncRequestTimeoutError')
  // net.fetch's own uncaught error may show up here; ours must not.
  assert.ok(out.uncaught.every((m) => /ByteString/.test(m)), `unexpected uncaught errors: ${out.uncaught.join(' | ')}`)
  console.log('PASS sync Electron request: 七牛 non-ASCII header, empty PUT, 204, PROPFIND, abort, no cache')
} finally {
  server.close()
  await rm(root, { recursive: true, force: true })
}
