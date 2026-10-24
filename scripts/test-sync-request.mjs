// Sync request wrapper (#161): a request the service never answers — or a
// body that stops arriving — fails after the timeout instead of keeping the
// folder "正在同步" forever; normal and empty (204) responses pass through;
// the trace entry carries method / URL / status / bytes, never credentials.
import assert from 'node:assert/strict'
import http from 'node:http'
import { createSyncRequest, SyncRequestTimeoutError } from '../src/main/sync/sync-request.js'

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/hang')) return // never answers
  if (req.url.startsWith('/stall')) {
    res.writeHead(200, { 'content-length': '100' })
    res.write('only part') // then nothing more
    return
  }
  if (req.url.startsWith('/empty')) { res.writeHead(204); res.end(); return }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => { res.writeHead(200, { etag: '"e1"' }); res.end(`got ${Buffer.concat(chunks).length}`) })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const logs = []
const request = createSyncRequest((url, init) => fetch(url, init), { log: (e) => logs.push(e), baseTimeoutMs: 600 })
try {
  const ok = await request(`${base}/put/a.md`, { method: 'PUT', body: Buffer.from('hello'), headers: { authorization: 'AWS4 secret-signature' } })
  assert.equal(ok.status, 200)
  assert.equal(await ok.text(), 'got 5')
  assert.equal(ok.headers.get('etag'), '"e1"')
  const empty = await request(`${base}/empty`, { method: 'DELETE' })
  assert.equal(empty.status, 204)
  assert.equal(empty.ok, true)

  const t0 = Date.now()
  await assert.rejects(request(`${base}/hang/x.md`, { method: 'GET' }), (error) => {
    assert.ok(error instanceof SyncRequestTimeoutError)
    assert.match(error.message, /没有响应（GET \/hang\/x\.md）/)
    return true
  })
  assert.ok(Date.now() - t0 < 3000, 'gave up near the timeout')
  await assert.rejects(request(`${base}/stall`, { method: 'GET' }), SyncRequestTimeoutError, 'a stalled body times out too')

  // Credentials in the URL never reach the log; headers are not logged.
  await request(`http://user:pass@127.0.0.1:${server.address().port}/put/b.md`, { method: 'PUT', body: 'x' }).catch(() => {})
  const text = JSON.stringify(logs)
  assert.ok(!/secret-signature|pass@|user:/.test(text), text)
  assert.deepEqual(logs[0], { kind: 'sync-request', method: 'PUT', url: `${base}/put/a.md`, bytesOut: 5, ms: logs[0].ms, status: 200, bytesIn: 5 })
  assert.equal(logs.find((e) => e.url.includes('/hang')).error, 'timeout')
} finally {
  server.closeAllConnections?.()
  server.close()
}
console.log('PASS sync request: timeout for no answer / stalled body, 204 passes, trace without credentials')
