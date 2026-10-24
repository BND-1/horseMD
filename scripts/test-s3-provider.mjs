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
// Bucket-level requests never append the prefix to the path (with a prefix,
// `GET /bucket/prefix?list-type=2` reads an object: 404 NoSuchKey, found on
// 数据胶囊); the prefix goes in the query.
for (const call of calls.filter((call) => call.url.includes('list-type=2'))) {
  assert.equal(new URL(call.url).pathname, '/notes', `listing is bucket-level: ${call.url}`)
  assert.match(new URL(call.url).searchParams.get('prefix') || '', /^HorseMD\/test\//)
}

// Listing follows IsTruncated (a folder of more than 1000 files).
{
  const pages = []
  const paged = new S3Provider({ endpoint: 'https://s3.example.test', bucket: 'notes', region: 'us-east-1', accessKeyId: 'AKID', secretAccessKey: 'SECRET', prefix: 'HorseMD/test', request: async (url) => {
    const token = new URL(url).searchParams.get('continuation-token')
    pages.push(token)
    if (!token) return reply(200, '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken><Contents><Key>HorseMD/test/a.md</Key></Contents><Contents><Key>HorseMD/test/b.md</Key></Contents></ListBucketResult>')
    if (token === 't1') return reply(200, '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken><Contents><Key>HorseMD/test/c.md</Key></Contents></ListBucketResult>')
    return reply(200, '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>HorseMD/test/d.md</Key></Contents></ListBucketResult>')
  } })
  const listed = await paged.list('')
  assert.deepEqual(listed.map((item) => item.href), ['a.md', 'b.md', 'c.md', 'd.md'], 'all pages listed')
  assert.deepEqual(pages, [null, 't1', 't2'], 'continuation tokens followed')
}

// 401 (数据胶囊: key bound to another client) names the User-Agent setting.
{
  const denied = new S3Provider({ endpoint: 'https://s3.example.test', bucket: 'notes', region: 'us-east-1', accessKeyId: 'AKID', secretAccessKey: 'SECRET', request: async () => reply(401) })
  await assert.rejects(() => denied.testConnection(), /User-Agent/)
}
console.log('PASS S3 provider: SigV4, prefix isolation, conditional writes, bucket-level listing with paging, User-Agent hint on 401')
