// End-to-end encrypted sync through the real desktop SyncService (connections,
// registry, credential store, engine) — several "devices" (own userData +
// own folder) against a REAL Apache WebDAV server (macOS /usr/sbin/httpd,
// Linux apache2 if present), an in-memory S3 server and a real MinIO (when
// installed: brew install minio). The server's disk /
// object store is scanned for every name and content written.
//   node scripts/test-sync-e2ee-service.mjs            (both servers)
//   HM_E2EE_ONLY=s3 | webdav | minio                   (one of them; MinIO runs when installed)
//   HM_E2EE_REMOTE_DAV=http://host:port/               (only that WebDAV server)
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SyncService } from '../src/main/sync-service.js'
import { adoptSyncWorkspace, unregisterSyncWorkspace } from '../src/main/sync-workspaces.js'
import { createKeyFile } from '../src/shared/sync/sync-crypto.js'
import { startMockS3 } from './lib/mock-s3-server.mjs'
import { startMinio } from './lib/minio-server.mjs'
import { startApacheDav, remoteDav } from './lib/apache-dav.mjs'

const PASSWORD = '正确的马 battery staple'
const NEW_PASSWORD = 'n3w-passw0rd-更长'
const SECRET_NAME = '机密计划'
const SECRET_TEXT = 'launch code 4471 绝密正文'

// safeStorage stand-in (the real one needs Electron): reversible, never plain.
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(Buffer.from(text, 'utf8').toString('base64').split('').reverse().join('')),
  decryptString: (buffer) => Buffer.from(buffer.toString().split('').reverse().join(''), 'base64').toString('utf8')
}


// ---------- devices ----------
async function makeDevice(root, name) {
  const userData = join(root, `${name}-userData`)
  const folder = join(root, `${name}-笔记`)
  await fs.mkdir(userData, { recursive: true })
  await fs.mkdir(folder, { recursive: true })
  const service = new SyncService({
    getUserDataPath: () => userData,
    safeStorage: fakeSafeStorage,
    request: fetch,
    traceLog: process.env.HM_E2EE_TRACE ? (entry) => console.log(`    ${name} ${JSON.stringify(entry)}`) : null
  })
  return { name, userData, folder, service, file: (rel) => join(folder, rel) }
}

async function connect(device, server) {
  await adoptSyncWorkspace(device.userData, device.folder)
  const { type, ...config } = server.connection
  return type === 'webdav' ? device.service.addWebDavConnection(config) : device.service.addS3Connection(config)
}

const read = (path) => fs.readFile(path, 'utf8')
const markerOf = async (device) => JSON.parse(await read(join(device.folder, '.horsemd', 'workspace.json')))
const workspaceIdOf = async (device) => (await markerOf(device)).workspaceId
const credentials = async (device) => JSON.parse(await read(join(device.userData, 'sync', 'credentials.json'))).items
const registryEntry = async (device) => (await device.service.entryFor(device.folder))

async function expectReject(promise, pattern, message) {
  await assert.rejects(promise, (error) => {
    assert.match(String(error?.message || error), pattern, message)
    return true
  }, message)
}

async function scenario(server, root) {
  const tag = `[${server.kind}]`
  const checks = []
  const ok = (label) => { checks.push(label); if (process.env.HM_E2EE_VERBOSE) console.log(`  … ${tag} ${label}`) }

  const a = await makeDevice(root, 'A')
  const b = await makeDevice(root, 'B')
  await fs.writeFile(a.file(`${SECRET_NAME}.md`), `# ${SECRET_NAME}\n\n${SECRET_TEXT}\n`)
  await fs.mkdir(a.file('私人日记/二〇二六'), { recursive: true })
  await fs.writeFile(a.file('私人日记/二〇二六/十一月.md'), '第一行\n第二行\n第三行\n')
  await fs.mkdir(a.file('空的文件夹'), { recursive: true })
  await fs.writeFile(a.file('image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]))
  const connA = await connect(a, server)
  const workspaceId = await workspaceIdOf(a)

  // 1. A password that is too short never reaches the cloud.
  const before1 = (await server.names()).sort()
  await expectReject(a.service.bindWorkspace(a.folder, connA.id, { encryption: { password: 'short' } }), /至少要 8/, `${tag} short password`)
  assert.deepEqual((await server.names()).sort(), before1, `${tag} short password wrote nothing`)
  ok('short password refused, nothing written')

  // 2. A: new encrypted workspace + first upload.
  const boundA = await a.service.bindWorkspace(a.folder, connA.id, { encryption: { password: PASSWORD } })
  assert.equal(boundA.encrypted, true)
  const pushed = await a.service.run(a.folder, 'push')
  assert.equal(pushed.summary.upload, 4, `${tag} three files + the empty folder uploaded: ${JSON.stringify(pushed.summary)}`)
  ok('A: encrypted workspace created, 3 files + 1 empty folder pushed')

  // 3. Nothing readable in the cloud: names, folders, contents, manifest.
  const leakScan = async (label) => {
    // The encrypted workspace's folder (step 10 adds a plain one on purpose).
    const mine = (name) => name.startsWith(`HorseMD/${workspaceId}`)
    const names = (await server.names()).filter(mine).join('\n')
    for (const word of [SECRET_NAME, '私人日记', '二〇二六', '十一月', '空的文件夹', 'image.png', 'manifest']) {
      assert.ok(!names.includes(word), `${tag} ${label}: "${word}" in a cloud name:\n${names}`)
    }
    for (const [key, bytes] of await server.files()) {
      if (!mine(key)) continue
      if (key.endsWith('.horsemd/encryption.json')) {
        const keyFile = JSON.parse(bytes.toString('utf8'))
        assert.deepEqual(Object.keys(keyFile).sort(), ['check', 'format', 'kdf', 'key', 'version'])
        continue
      }
      assert.match(key, new RegExp(`^HorseMD/${workspaceId}/(o|t/[^/]+)/[0-9a-f]{64}$`), `${tag} ${label}: unexpected object ${key}`)
      assert.equal(bytes.subarray(0, 4).toString(), 'HMX1', `${tag} ${label}: ${key} not sealed`)
      const text = bytes.toString('latin1')
      for (const word of [SECRET_TEXT, 'launch code', '第一行', 'workspaceId', 'files', '"dirs"']) {
        assert.ok(!text.includes(word) && !bytes.includes(Buffer.from(word)), `${tag} ${label}: "${word}" readable in ${key}`)
      }
    }
  }
  await leakScan('after first push')
  ok('cloud: only the key file + opaque o/<hmac> objects, every byte sealed')

  // 4. B finds an encrypted workspace; joining needs the right password and
  //    a wrong one changes nothing on B.
  const connB = await connect(b, server)
  const markerBefore = await markerOf(b)
  const listed = await b.service.listRemoteWorkspaces(connB.id)
  assert.deepEqual(listed, [{ workspaceId, encrypted: true, fileCount: null }], `${tag} listing: ${JSON.stringify(listed)}`)
  await expectReject(b.service.joinWorkspace(b.folder, connB.id, workspaceId), /请输入加密密码/, `${tag} join without password`)
  await expectReject(b.service.joinWorkspace(b.folder, connB.id, workspaceId, { password: 'wrong password!' }), /加密密码不对/, `${tag} wrong password`)
  assert.deepEqual(await markerOf(b), markerBefore, `${tag} a wrong password left B's folder as it was`)
  assert.equal(Object.keys(await credentials(b)).some((id) => id.startsWith('e2ee:')), false, `${tag} no key stored after a wrong password`)
  const joined = await b.service.joinWorkspace(b.folder, connB.id, workspaceId, { password: PASSWORD.normalize('NFD') })
  assert.equal(joined.encrypted, true)
  const pulled = await b.service.run(b.folder, 'pull')
  assert.equal(pulled.summary.download, 4, `${tag} B downloads 3 files + 1 folder: ${JSON.stringify(pulled.summary)}`)
  assert.equal(await read(b.file(`${SECRET_NAME}.md`)), `# ${SECRET_NAME}\n\n${SECRET_TEXT}\n`)
  assert.deepEqual(await fs.readFile(b.file('image.png')), await fs.readFile(a.file('image.png')))
  assert.ok((await fs.stat(b.file('空的文件夹'))).isDirectory(), `${tag} empty folder arrived (manifest dirs)`)
  ok('B: listing says encrypted; no password / wrong password refused and changed nothing; right password (NFD spelling) joins and gets every file + the empty folder')

  // 5. Edits both ways, a three-way merge, a deletion with a cloud trash copy.
  await fs.writeFile(a.file('私人日记/二〇二六/十一月.md'), 'A 改了第一行\n第二行\n第三行\n')
  await fs.writeFile(b.file('私人日记/二〇二六/十一月.md'), '第一行\n第二行\nB 改了第三行\n')
  await a.service.run(a.folder, 'merge', null, { automatic: true })
  const mergeB = await b.service.run(b.folder, 'merge', null, { automatic: true })
  assert.equal(mergeB.merged, 1, `${tag} merged on B: ${JSON.stringify(mergeB)}`)
  await a.service.run(a.folder, 'merge', null, { automatic: true })
  assert.equal(await read(a.file('私人日记/二〇二六/十一月.md')), 'A 改了第一行\n第二行\nB 改了第三行\n')
  await fs.rm(b.file('image.png'))
  await b.service.run(b.folder, 'merge', null, { automatic: true })
  await a.service.run(a.folder, 'merge', null, { automatic: true })
  assert.equal(existsSync(a.file('image.png')), false, `${tag} deletion reached A`)
  assert.ok((await server.names()).some((name) => /\/t\/[^/]+\/[0-9a-f]{64}$/.test(name)), `${tag} trash copy under t/`)
  await leakScan('after merge + delete')
  ok('both-side edits merged through the encrypted cloud; a deletion reached A and left a t/<stamp>/<hmac> trash copy')

  // 6. Password change on A: same key, B keeps syncing without a prompt; a
  //    third device joins only with the new password.
  await expectReject(a.service.changeEncryptionPassword(a.folder, 'not the password', NEW_PASSWORD), /加密密码不对/, `${tag} wrong old password`)
  await expectReject(a.service.changeEncryptionPassword(a.folder, PASSWORD, '1234567'), /至少要 8/, `${tag} short new password`)
  await a.service.changeEncryptionPassword(a.folder, PASSWORD, NEW_PASSWORD)
  await fs.writeFile(a.file('改密码之后.md'), 'after the password change\n')
  await a.service.run(a.folder, 'merge', null, { automatic: true })
  const afterChangeB = await b.service.run(b.folder, 'merge', null, { automatic: true })
  assert.ok(!afterChangeB.needsConfirmation, `${tag} B not asked after a password change: ${JSON.stringify(afterChangeB)}`)
  assert.equal(await read(b.file('改密码之后.md')), 'after the password change\n')
  const c = await makeDevice(root, 'C')
  const connC = await connect(c, server)
  await expectReject(c.service.joinWorkspace(c.folder, connC.id, workspaceId, { password: PASSWORD }), /加密密码不对/, `${tag} old password no longer joins`)
  await c.service.joinWorkspace(c.folder, connC.id, workspaceId, { password: NEW_PASSWORD })
  await c.service.run(c.folder, 'pull')
  assert.equal(await read(c.file(`${SECRET_NAME}.md`)), `# ${SECRET_NAME}\n\n${SECRET_TEXT}\n`)
  ok('password change: wrong old / short new refused; B kept syncing without a prompt; C joins with the new password only')

  // 7. This device lost its key (key store cleared): the sync stops, asks,
  //    writes nothing; a wrong password is refused; the right one resumes.
  const items = await credentials(c)
  delete items[`e2ee:${workspaceId}`]
  await fs.writeFile(join(c.userData, 'sync', 'credentials.json'), JSON.stringify({ version: 1, items }, null, 2))
  const before7 = await server.files()
  await fs.writeFile(c.file('C 的新笔记.md'), 'from C\n')
  const locked = await c.service.run(c.folder, 'merge', null, { automatic: true })
  assert.deepEqual([locked.needsConfirmation, locked.reason], [true, 'e2ee-locked'], `${tag} locked: ${JSON.stringify(locked)}`)
  assert.equal((await c.service.preview(c.folder)).status, 'e2ee-locked')
  assert.deepEqual([...(await server.files()).keys()].sort(), [...before7.keys()].sort(), `${tag} a locked run wrote nothing`)
  await expectReject(c.service.unlockWorkspace(c.folder, PASSWORD), /加密密码不对/, `${tag} unlock with the old password`)
  await c.service.unlockWorkspace(c.folder, NEW_PASSWORD)
  const resumed = await c.service.run(c.folder, 'merge', null, { automatic: true })
  assert.equal(resumed.summary?.upload, 1, `${tag} C resumed: ${JSON.stringify(resumed)}`)
  ok('lost key: run + preview stop with e2ee-locked and write nothing; the old password is refused; the new one resumes')

  // 8. Another device replaced the key (a fresh key file, other names): A
  //    stops with e2ee-key-changed and writes nothing.
  const keyPath = `HorseMD/${workspaceId}/.horsemd/encryption.json`
  const original = (await server.files()).get(keyPath)
  const { keyFile: stranger } = await createKeyFile('a stranger key 123', { iterations: 1000 })
  await server.write(keyPath, Buffer.from(JSON.stringify(stranger)))
  const before8 = await server.files()
  await fs.writeFile(a.file('密钥被换之后.md'), 'should wait\n')
  const changed = await a.service.run(a.folder, 'merge', null, { automatic: true })
  assert.deepEqual([changed.needsConfirmation, changed.reason], [true, 'e2ee-key-changed'], `${tag} key changed: ${JSON.stringify(changed)}`)
  assert.deepEqual([...(await server.files()).keys()].sort(), [...before8.keys()].sort(), `${tag} key-changed run wrote nothing`)
  await server.write(keyPath, original)
  const backA = await a.service.run(a.folder, 'merge', null, { automatic: true })
  assert.ok(!backA.needsConfirmation && backA.summary.upload === 1, `${tag} A resumes once the key is back: ${JSON.stringify(backA)}`)
  ok('replaced key in the cloud: e2ee-key-changed, nothing written; the original key file back → syncing again')

  // 9. A folder whose registry says "not encrypted" but whose cloud copy is
  //    (a copied folder with the same marker): never writes plain text.
  const d = await makeDevice(root, 'D')
  await fs.mkdir(join(d.folder, '.horsemd'), { recursive: true })
  await fs.writeFile(join(d.folder, '.horsemd', 'workspace.json'), JSON.stringify(await markerOf(a)))
  await fs.writeFile(d.file('明文不该上传.md'), 'plain text must never upload\n')
  const connD = await connect(d, server)
  await d.service.bindWorkspace(d.folder, connD.id)
  assert.notEqual((await registryEntry(d)).encrypted, true)
  const plainTry = await d.service.run(d.folder, 'merge', null, { automatic: true })
  assert.deepEqual([plainTry.needsConfirmation, plainTry.reason], [true, 'e2ee-locked'], `${tag} plain folder on encrypted cloud: ${JSON.stringify(plainTry)}`)
  assert.equal((await server.names()).some((name) => name.includes('明文')), false)
  const manualPush = await d.service.run(d.folder, 'push')
  assert.equal(manualPush.reason, 'e2ee-locked', `${tag} even a manual push stops`)
  await leakScan('after the plain-text folder tried')
  ok('a folder registered without encryption on an encrypted cloud copy stops (e2ee-locked), even for a manual push; nothing in plain text')

  // 10. Turning encryption on for a folder that synced before in plain text
  //     is refused (its plain files would stay next to the sealed ones).
  const e = await makeDevice(root, 'E')
  await fs.writeFile(e.file('明文笔记.md'), 'plain\n')
  const connE = await connect(e, server)
  await e.service.bindWorkspace(e.folder, connE.id)
  await e.service.run(e.folder, 'push')
  await expectReject(e.service.bindWorkspace(e.folder, connE.id, { encryption: { password: PASSWORD } }), /不加密地同步过/, `${tag} plain → encrypted refused`)
  ok('a folder already synced in plain text cannot be switched to encryption')

  // 11. The cloud was emptied (key file gone): e2ee-key-missing; a password
  //     writes the key file again with THIS device's key, the plan becomes
  //     the usual remote-reset choice, and B — same key — needs no password.
  await server.remove(`HorseMD/${workspaceId}`)
  const missing = await a.service.run(a.folder, 'merge', null, { automatic: true })
  assert.deepEqual([missing.needsConfirmation, missing.reason], [true, 'e2ee-key-missing'], `${tag} key missing: ${JSON.stringify(missing)}`)
  assert.equal((await server.names()).filter((name) => name.includes(workspaceId)).length, 0, `${tag} key-missing run wrote nothing`)
  await expectReject(a.service.unlockWorkspace(a.folder, 'short'), /至少要 8/, `${tag} short password on re-create`)
  await a.service.unlockWorkspace(a.folder, 'brand new password')
  assert.equal((await a.service.preview(a.folder)).status, 'remote-reset')
  await a.service.run(a.folder, 'push')
  const bAfterReset = await b.service.run(b.folder, 'merge', null, { automatic: true })
  assert.notEqual(bAfterReset.reason, 'e2ee-key-changed', `${tag} B keeps its key: ${JSON.stringify(bAfterReset)}`)
  assert.ok(!String(bAfterReset.reason || '').startsWith('e2ee-'), `${tag} B not asked for a password`)
  await leakScan('after re-creating the key')
  ok('emptied cloud: e2ee-key-missing, nothing written; a new password re-wraps the SAME key (A re-uploads, B is not asked)')

  // 12. Stop syncing: the key leaves the device.
  await b.service.forgetWorkspaceKey(b.folder)
  await unregisterSyncWorkspace(b.userData, b.folder)
  assert.equal(Object.keys(await credentials(b)).some((id) => id.startsWith('e2ee:')), false, `${tag} key removed`)
  ok('stop syncing removes the stored key')

  for (const label of checks) console.log(`  ✓ ${tag} ${label}`)
}

const only = process.env.HM_E2EE_ONLY || ''
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-e2ee-service-'))
let ran = 0
try {
  // HM_E2EE_REMOTE_DAV=<url>: only that server (an empty WebDAV root on
  // another machine, e.g. the mini's Apache for the Windows run).
  if (process.env.HM_E2EE_REMOTE_DAV) {
    await scenario(remoteDav(process.env.HM_E2EE_REMOTE_DAV), join(root, 'remote-run'))
    ran += 1
  } else {
  if (only === '' || only === 'webdav') {
    const apache = await startApacheDav(join(root, 'apache'))
    if (!apache) console.log('  - Apache DAV not installed: WebDAV run skipped')
    else {
      try { await scenario(apache, join(root, 'webdav-run')); ran += 1 } catch (error) {
        if (process.env.HM_E2EE_TRACE) console.log((await apache.accessLog()).split('\n').slice(-30).join('\n'))
        throw error
      } finally { await apache.stop() }
    }
  }
  if (only === '' || only === 's3') {
    const s3 = await startMockS3()
    try { await scenario(s3, join(root, 's3-run')); ran += 1 } finally { await s3.stop() }
  }
  if (only === '' || only === 'minio') {
    const minio = await startMinio(join(root, 'minio'))
    if (!minio) console.log('  - MinIO not installed: real S3 run skipped')
    else {
      try { await scenario({ ...minio, kind: 'minio' }, join(root, 'minio-run')); ran += 1 } finally { await minio.stop() }
    }
  }
  }
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
assert.ok(ran > 0, 'no server ran')
console.log(`PASS e2ee sync service: ${ran} server(s) — create, join, merge, delete, password change, lost / replaced / missing key, plain-text guards, leak scans`)
