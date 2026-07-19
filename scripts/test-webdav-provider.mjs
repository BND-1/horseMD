import assert from 'node:assert/strict'
import { WebDavProvider, parsePropfind } from '../src/main/sync/webdav-provider.js'

const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/dav/HorseMD/</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:getetag>"root"</d:getetag><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/HorseMD/note%20one.md</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:getetag>"abc"</d:getetag><d:getcontentlength>12</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></d:response>
</d:multistatus>`

assert.deepEqual(parsePropfind(xml), [
  { href: '/dav/HorseMD/', etag: 'root', isDirectory: true, size: 0 },
  { href: '/dav/HorseMD/note one.md', etag: 'abc', isDirectory: false, size: 12 }
])

const requests = []
const response = (status, body = '', headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(headers),
  text: async () => body,
  arrayBuffer: async () => Buffer.from(body)
})
const provider = new WebDavProvider({
  endpoint: 'https://dav.example.test/root',
  username: 'alice',
  password: 'secret',
  request: async (url, init) => {
    requests.push({ url, init })
    if (init.method === 'PROPFIND') return response(207, xml)
    if (init.method === 'MKCOL') return response(201)
    if (init.method === 'PUT') return response(201, '', { etag: '"next"' })
    if (init.method === 'GET') return response(200, 'hello', { etag: '"read"' })
    if (init.method === 'DELETE') return response(204)
    throw new Error('Unexpected request')
  }
})

await provider.testConnection()
const stat = await provider.stat('folder/note one.md')
assert.equal(stat.etag, 'root')
assert.equal((await provider.list('folder')).length, 2)
const written = await provider.put('folder/note one.md', Buffer.from('hello'), { revision: 'old' })
assert.equal(written.revision, 'next')
const fetched = await provider.get('folder/note one.md')
assert.equal(fetched.bytes.toString(), 'hello')
assert.equal(fetched.revision, 'read')
await provider.delete('folder/note one.md', { revision: 'read' })

assert.equal(requests[0].init.headers.authorization.startsWith('Basic '), true)
assert.equal(requests.some((item) => item.init.method === 'MKCOL' && /folder$/.test(item.url)), true)
assert.equal(requests.find((item) => item.init.method === 'PUT').init.headers['if-match'], '"old"')
assert.throws(() => new WebDavProvider({ endpoint: 'http://dav.example.test', request: async () => response(200) }), /HTTPS/)

console.log('PASS WebDAV provider: XML, auth, paths, transfer, conditional writes and HTTPS guard')
