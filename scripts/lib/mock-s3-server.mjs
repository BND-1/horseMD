// An in-memory S3 server for sync tests (path-style, like S3Provider):
// GET / PUT / DELETE / HEAD, If-None-Match / If-Match, ListObjectsV2 with a
// delimiter, CopyObject. ETag = MD5 of the bytes, as AWS.
import { createHash } from 'node:crypto'
import http from 'node:http'

// S3 (path-style): GET/PUT/DELETE/HEAD, conditional writes, ListObjectsV2
// with delimiter, CopyObject. ETag = MD5 of the bytes (like AWS).
export async function startMockS3() {
  const objects = new Map() // key (no bucket) → Buffer
  const md5 = (bytes) => createHash('md5').update(bytes).digest('hex')
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url, 'http://x')
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean)
    const key = parts.slice(1).join('/')
    const reply = (status, headers = {}, value = '') => res.writeHead(status, headers).end(value)
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || ''
      const delimiter = url.searchParams.get('delimiter')
      const contents = []
      const common = new Set()
      for (const [name, bytes] of [...objects].sort()) {
        if (!name.startsWith(prefix)) continue
        const rest = name.slice(prefix.length)
        const cut = delimiter ? rest.indexOf(delimiter) : -1
        if (cut >= 0) common.add(prefix + rest.slice(0, cut + 1))
        else contents.push(`<Contents><Key>${name}</Key><ETag>"${md5(bytes)}"</ETag><Size>${bytes.length}</Size></Contents>`)
      }
      return reply(200, { 'content-type': 'application/xml' }, `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents.join('')}${[...common].map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`)
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!key) return reply(200)
      const bytes = objects.get(key)
      if (!bytes) return reply(404, { 'content-type': 'application/xml' }, req.method === 'HEAD' ? '' : '<Error><Code>NoSuchKey</Code></Error>')
      return reply(200, { etag: `"${md5(bytes)}"`, 'content-length': bytes.length }, req.method === 'HEAD' ? '' : bytes)
    }
    if (req.method === 'PUT') {
      const source = req.headers['x-amz-copy-source']
      if (source) {
        const from = decodeURIComponent(String(source)).replace(/^\/+/, '').split('/').slice(1).join('/')
        const bytes = objects.get(from)
        if (!bytes) return reply(404, {}, '<Error><Code>NoSuchKey</Code></Error>')
        objects.set(key, Buffer.from(bytes))
        return reply(200, { 'content-type': 'application/xml' }, `<CopyObjectResult><ETag>"${md5(bytes)}"</ETag></CopyObjectResult>`)
      }
      const old = objects.get(key)
      if (req.headers['if-none-match'] === '*' && old) return reply(412)
      if (req.headers['if-match'] && (!old || req.headers['if-match'] !== `"${md5(old)}"`)) return reply(412)
      objects.set(key, body)
      return reply(200, { etag: `"${md5(body)}"` })
    }
    if (req.method === 'DELETE') {
      objects.delete(key)
      return reply(204)
    }
    return reply(405)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    kind: 's3',
    connection: { type: 's3', name: 'Mock S3', endpoint: `http://127.0.0.1:${server.address().port}`, bucket: 'notes', region: 'us-east-1', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test', allowInsecure: true },
    files: async () => new Map(objects),
    names: async () => [...objects.keys()],
    remove: async (key) => { for (const name of [...objects.keys()]) if (name === key || name.startsWith(key + '/')) objects.delete(name) },
    write: async (key, bytes) => { objects.set(key, Buffer.from(bytes)) },
    // Kept-alive client connections would hold close() open forever.
    stop: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.() })
  }
}

