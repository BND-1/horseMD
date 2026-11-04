// 云同步 services (lib/sync-providers.js) and the connections they save
// (main/sync/connections.js):
//   - each service form builds the exact WebDAV / S3 config (addresses,
//     regions, client id), and reads a saved connection back;
//   - connections saved before services existed are recognized by address,
//     and one a service form cannot show exactly (another region, a custom
//     client id…) opens in the full form — nothing is rewritten;
//   - `provider` is saved and kept on update; connection types this version
//     does not know (a newer HorseMD's) survive add / update / remove.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  QINIU_REGIONS,
  SYNC_PROVIDERS,
  buildProviderConnection,
  providerById,
  providerFormValues,
  providerOfConnection
} from '../src/renderer/src/lib/sync-providers.js'
import { CredentialStore } from '../src/main/sync/credential-store.js'
import { ConnectionRegistry } from '../src/main/sync/connections.js'

// 1. Service forms → configs (the values the main process stores).
const build = (id, values) => buildProviderConnection(providerById(id), { name: 'n', ...values })
assert.deepEqual(build('jianguoyun', { username: ' me@x.cn ', password: 'p' }), {
  endpoint: 'https://dav.jianguoyun.com/dav/', username: 'me@x.cn', password: 'p', userAgent: '', name: 'n', provider: 'jianguoyun'
})
assert.deepEqual(build('cstcloud', { bucket: 'b1', accessKeyId: 'AK', secretAccessKey: 'SK' }), {
  endpoint: 'https://s3.cstcloud.cn', region: 'us-east-1', bucket: 'b1', accessKeyId: 'AK', secretAccessKey: 'SK', userAgent: 'rclone', name: 'n', provider: 'cstcloud'
})
assert.equal(build('cstcloud', { bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', client: 'Cyberduck' }).userAgent, 'Cyberduck')
assert.deepEqual(build('qiniu', { qiniuRegion: 'cn-south-1', bucket: 'my-notes', accessKeyId: 'AK', secretAccessKey: 'SK' }), {
  endpoint: 'https://s3.cn-south-1.qiniucs.com', region: 'cn-south-1', bucket: 'my-notes', accessKeyId: 'AK', secretAccessKey: 'SK', userAgent: '', name: 'n', provider: 'qiniu'
})
assert.equal(build('qiniu', { bucket: 'b' }).region, 'cn-east-1', 'qiniu default region')
assert.equal(build('qiniu', { qiniuRegion: 'evil.example.com/x', bucket: 'b' }).endpoint, 'https://s3.cn-east-1.qiniucs.com', 'unknown region falls back')
assert.deepEqual(build('r2', { accountId: ' ABC123 ', bucket: 'notes', accessKeyId: 'a', secretAccessKey: 's' }), {
  endpoint: 'https://abc123.r2.cloudflarestorage.com', region: 'auto', bucket: 'notes', accessKeyId: 'a', secretAccessKey: 's', userAgent: '', name: 'n', provider: 'r2'
})
assert.deepEqual(build('nextcloud', { server: 'https://cloud.example.com/', username: 'alex li', password: 'p' }), {
  endpoint: 'https://cloud.example.com/remote.php/dav/files/alex%20li/', username: 'alex li', password: 'p', userAgent: '', name: 'n', provider: 'nextcloud'
})
// The full forms pass their fields through (no service).
assert.deepEqual(buildProviderConnection(providerById('webdav'), { name: ' x ', endpoint: 'https://e' }), { name: 'x', endpoint: 'https://e', provider: '' })

// 2. Round trip: every service reads back what it built.
const samples = {
  jianguoyun: { username: 'me@x.cn' },
  cstcloud: { bucket: 'b1', accessKeyId: 'AK', client: 'rclone' },
  qiniu: { qiniuRegion: 'cn-north-1', bucket: 'b', accessKeyId: 'AK' },
  r2: { accountId: 'abc123', bucket: 'notes', accessKeyId: 'a' },
  nextcloud: { server: 'https://cloud.example.com', username: 'alex li' }
}
for (const provider of SYNC_PROVIDERS.filter((item) => !item.generic)) {
  const config = { type: provider.type, ...buildProviderConnection(provider, { name: 'n', ...samples[provider.id] }) }
  assert.equal(providerOfConnection(config)?.id, provider.id, `${provider.id} not recognized`)
  assert.deepEqual(providerFormValues(provider, config), samples[provider.id], `${provider.id} round trip`)
}
for (const region of QINIU_REGIONS) {
  const config = { type: 's3', ...build('qiniu', { qiniuRegion: region, bucket: 'b', accessKeyId: 'a' }) }
  assert.equal(providerFormValues(providerById('qiniu'), config).qiniuRegion, region)
}

// 3. Older connections (no `provider`): recognized by address; anything a
// service form cannot show keeps the full form.
const legacy = (fields) => ({ id: 'x', name: 'old', ...fields })
assert.equal(providerOfConnection(legacy({ type: 's3', endpoint: 'https://s3.cstcloud.cn', region: 'us-east-1', userAgent: 'rclone/v1.68.0' })).id, 'cstcloud')
assert.deepEqual(providerFormValues(providerById('cstcloud'), legacy({ type: 's3', endpoint: 'https://s3.cstcloud.cn', bucket: 'b', region: 'us-east-1', accessKeyId: 'a', userAgent: 'rclone/v1.68.0' })), { bucket: 'b', accessKeyId: 'a', client: 'rclone/v1.68.0' })
assert.equal(providerFormValues(providerById('cstcloud'), legacy({ type: 's3', endpoint: 'https://s3.cstcloud.cn', region: 'cn-north-1' })), null, 'another region → full form')
assert.equal(providerOfConnection(legacy({ type: 's3', endpoint: 'https://s3.cn-south-1.qiniucs.com', region: 'cn-south-1' })).id, 'qiniu')
assert.equal(providerFormValues(providerById('qiniu'), legacy({ type: 's3', endpoint: 'https://s3.cn-south-1.qiniucs.com', region: 'us-east-1' })), null, 'endpoint/region disagree → full form')
assert.equal(providerFormValues(providerById('qiniu'), legacy({ type: 's3', endpoint: 'https://s3.cn-south-1.qiniucs.com', region: 'cn-south-1', userAgent: 'x' })), null, 'custom client → full form')
assert.equal(providerOfConnection(legacy({ type: 'webdav', endpoint: 'https://dav.jianguoyun.com/dav' })).id, 'jianguoyun')
assert.equal(providerFormValues(providerById('jianguoyun'), legacy({ type: 'webdav', endpoint: 'https://dav.jianguoyun.com/dav/HorseMD/' })), null, 'a sub-folder address → full form')
assert.equal(providerOfConnection(legacy({ type: 'webdav', endpoint: 'https://nas.local:5006/notes/' })).id, 'webdav')
assert.equal(providerOfConnection(legacy({ type: 's3', endpoint: 'https://s3.amazonaws.com' })).id, 's3')
assert.equal(providerFormValues(providerById('nextcloud'), legacy({ type: 'webdav', endpoint: 'https://c.example/remote.php/dav/files/bob/', username: 'alice' })), null, 'user mismatch → full form')
// A saved service whose address was changed in the full form no longer claims it.
assert.equal(providerOfConnection({ type: 's3', provider: 'qiniu', endpoint: 'https://minio.local' }).id, 's3')
// A saved service of the other protocol is ignored.
assert.equal(providerOfConnection({ type: 'webdav', provider: 'qiniu', endpoint: 'https://dav.jianguoyun.com/dav/' }).id, 'jianguoyun')

// 4. Saved connections: provider kept; unknown types survive.
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-sync-providers-'))
try {
  const credentialStore = new CredentialStore({
    userDataPath: root,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(`x:${v}`), decryptString: (v) => v.toString().slice(2) }
  })
  const registry = new ConnectionRegistry({
    userDataPath: root,
    credentialStore,
    createWebDavProvider: () => ({ testConnection: async () => ({ ok: true }) }),
    createS3Provider: () => ({ testConnection: async () => ({ ok: true }) })
  })
  const future = { id: 'gh-1', type: 'github', name: 'GitHub', repo: 'me/notes', credentialId: 'github:gh-1' }
  await fs.mkdir(join(root, 'sync'), { recursive: true })
  await fs.writeFile(join(root, 'sync', 'connections.json'), JSON.stringify({ version: 1, connections: [future] }))
  const qiniu = await registry.addS3(build('qiniu', { qiniuRegion: 'cn-south-1', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }))
  assert.equal(qiniu.provider, 'qiniu')
  const nas = await registry.addWebDav({ name: 'NAS', endpoint: 'https://nas.local/dav/', username: 'u', password: 'p' })
  assert.equal(nas.provider, '')
  assert.equal((await registry.addWebDav({ name: 'x', endpoint: 'https://e/', password: 'p', provider: '../../evil' })).provider, '', 'invalid provider id dropped')
  // Update without `provider` keeps it; '' clears it.
  assert.equal((await registry.update(qiniu.id, { ...build('qiniu', { qiniuRegion: 'cn-south-1', bucket: 'b2', accessKeyId: 'a', secretAccessKey: '' }), provider: undefined })).provider, 'qiniu')
  assert.equal((await registry.update(qiniu.id, { name: 'q', endpoint: 'https://s3.cn-south-1.qiniucs.com', bucket: 'b2', region: 'cn-south-1', accessKeyId: 'a', secretAccessKey: '', provider: '' })).provider, '')
  await registry.remove(nas.id)
  // The unknown connection is still there, byte for byte, and never listed.
  const saved = JSON.parse(await fs.readFile(join(root, 'sync', 'connections.json'), 'utf8')).connections
  assert.deepEqual(saved.find((item) => item.id === 'gh-1'), future, 'an unknown connection type was dropped')
  assert.equal((await registry.list()).some((item) => item.id === 'gh-1'), false)
  await assert.rejects(registry.update('gh-1', { name: 'x' }), /找不到云端连接/)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

console.log('PASS sync providers: 5 service forms build exact WebDAV/S3 configs and read them back; older connections recognized by address, unusual ones keep the full form; provider saved/kept/cleared; unknown connection types survive add/update/remove')
