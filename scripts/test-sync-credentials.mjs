import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CredentialStore } from '../src/main/sync/credential-store.js'
import { ConnectionRegistry } from '../src/main/sync/connections.js'

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-sync-credentials-'))
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`secret:${value}`),
  decryptString: (value) => value.toString().replace(/^secret:/, '')
}
try {
  const credentials = new CredentialStore({ userDataPath: root, safeStorage: fakeSafeStorage })
  await credentials.set('one', { password: 'do-not-leak' })
  assert.deepEqual(await credentials.get('one'), { password: 'do-not-leak' })
  const raw = await fs.readFile(join(root, 'sync', 'credentials.json'), 'utf8')
  assert.equal(raw.includes('do-not-leak'), false)

  const testedPasswords = []
  const testedSecrets = []
  const registry = new ConnectionRegistry({
    userDataPath: root,
    credentialStore: credentials,
    createWebDavProvider: (config) => ({ testConnection: async () => { testedPasswords.push(config.password) } }),
    createS3Provider: (config) => ({ testConnection: async () => { testedSecrets.push(config.secretAccessKey) } })
  })
  const connection = await registry.addWebDav({
    name: 'Nextcloud', endpoint: 'https://cloud.example.test/dav', username: 'alice', password: 'do-not-leak', userAgent: 'HorseMD-test/1.0'
  })
  assert.equal(connection.password, undefined)
  assert.equal(connection.userAgent, 'HorseMD-test/1.0')
  assert.equal((await registry.list()).length, 1)
  const updatedWebDav = await registry.update(connection.id, {
    name: 'Renamed Nextcloud', endpoint: 'https://cloud.example.test/dav-new', username: 'bob', password: '', userAgent: 'HorseMD-test/1.1'
  })
  assert.equal(updatedWebDav.name, 'Renamed Nextcloud')
  assert.equal(updatedWebDav.password, undefined)
  assert.equal(updatedWebDav.userAgent, 'HorseMD-test/1.1')
  assert.deepEqual(testedPasswords, ['do-not-leak', 'do-not-leak'])

  const s3 = await registry.addS3({
    name: 'MinIO', endpoint: 'https://s3.example.test', bucket: 'horsemd', region: 'us-east-1',
    accessKeyId: 'access-one', secretAccessKey: 'secret-one', userAgent: 'HorseMD-test/1.0'
  })
  const updatedS3 = await registry.update(s3.id, {
    name: 'Renamed MinIO', endpoint: 'https://s3.example.test', bucket: 'horsemd', region: 'us-east-1',
    accessKeyId: 'access-two', secretAccessKey: '', userAgent: 'HorseMD-test/1.1'
  })
  assert.equal(updatedS3.accessKeyId, 'access-two')
  assert.equal(updatedS3.userAgent, 'HorseMD-test/1.1')
  assert.equal(updatedS3.secretAccessKey, undefined)
  assert.deepEqual(testedSecrets, ['secret-one', 'secret-one'])
  await registry.update(s3.id, {
    name: 'Renamed MinIO', endpoint: 'https://s3.example.test', bucket: 'horsemd', region: 'us-east-1',
    accessKeyId: 'access-two', secretAccessKey: 'secret-two', userAgent: 'HorseMD-test/1.1'
  })
  assert.deepEqual(testedSecrets, ['secret-one', 'secret-one', 'secret-two'])
  assert.deepEqual(await credentials.get(`s3:${s3.id}`), { secretAccessKey: 'secret-two' })
  const connectionFile = await fs.readFile(join(root, 'sync', 'connections.json'), 'utf8')
  assert.equal(connectionFile.includes('secret-two'), false)
  await registry.remove(connection.id)
  assert.equal(await credentials.get(`webdav:${connection.id}`), null)
  await registry.remove(s3.id)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

console.log('PASS sync credentials: encrypted secret store and password-free connection registry')
