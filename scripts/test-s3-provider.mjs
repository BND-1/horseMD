import assert from 'node:assert/strict'
import { S3Provider } from '../src/main/sync/s3-provider.js'

const calls = []
const reply = (status, body = '', headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), text: async () => body, arrayBuffer: async () => Buffer.from(body) })
const provider = new S3Provider({ endpoint: 'https://s3.example.test', bucket: 'notes', region: 'us-east-1', accessKeyId: 'AKID', secretAccessKey: 'SECRET', prefix: 'HorseMD/test', userAgent: 'HorseMD-test/1.0', request: async (url, init) => {
  calls.push({ url, init })
  if (init.method === 'GET' && url.includes('list-type=2')) return reply(200, '<ListBucketResult><CommonPrefixes><Prefix>HorseMD/test/child/</Prefix></CommonPrefixes></ListBucketResult>')
  if (init.method === 'GET') return reply(200, 'hello', { etag: '"read"' })
  if (init.method === 'PUT') return reply(200, '', { etag: '"write"' })
  return reply(204)
} })

await provider.testConnection()
assert.equal((await provider.list('')).some((item) => item.href === 'child/' && item.isDirectory), true)
assert.equal((await provider.get('note.md')).bytes.toString(), 'hello')
assert.equal((await provider.put('note.md', Buffer.from('x'), { createOnly: true })).revision, 'write')
await provider.delete('note.md', { revision: 'write' })
await provider.put('中文 文件.md', Buffer.from('unicode'), { createOnly: true })
await provider.put('括号(测试).md', Buffer.from('reserved'), { createOnly: true })
assert.equal(calls.every((call) => /^AWS4-HMAC-SHA256 /.test(call.init.headers.authorization)), true)
assert.equal(calls.every((call) => call.init.headers['user-agent'] === 'HorseMD-test/1.0'), true)
assert.equal(calls.some((call) => /notes\/HorseMD\/test\/note\.md/.test(call.url)), true)
assert.equal(calls.some((call) => /\.connection-check\//.test(call.url)), true)
assert.equal(calls.some((call) => /%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6\.md/.test(call.url)), true)
assert.equal(calls.some((call) => /%E6%8B%AC%E5%8F%B7%28%E6%B5%8B%E8%AF%95%29\.md/.test(call.url)), true)
console.log('PASS S3 provider: SigV4, prefix isolation, conditional writes and ListObjectsV2')
