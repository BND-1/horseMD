// End-to-end encrypted sync between two machines through one real WebDAV
// server (the mini's Apache served on its Tailscale address, Windows joining).
// Each step runs on its own machine, state kept in HM_XM_DIR between steps:
//   mini:    HM_XM_DAV=<url> HM_XM_DIR=<dir> node scripts/test-sync-e2ee-cross-machine.mjs create
//   windows: HM_XM_DAV=<url> HM_XM_DIR=<dir> node scripts/test-sync-e2ee-cross-machine.mjs join
//   mini:    HM_XM_DAV=<url> HM_XM_DIR=<dir> node scripts/test-sync-e2ee-cross-machine.mjs check
// Serve the DAV with startApacheDav(root, { host: <tailscale ip>, port }).
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { SyncService } from '../src/main/sync-service.js'
import { adoptSyncWorkspace } from '../src/main/sync-workspaces.js'

const PASSWORD = '跨机器 password 2026'
const step = process.argv[2]
const dav = process.env.HM_XM_DAV
const dir = process.env.HM_XM_DIR
if (!dav || !dir || !['create', 'join', 'check'].includes(step)) throw new Error('HM_XM_DAV, HM_XM_DIR and create | join | check are required')

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(Buffer.from(text, 'utf8').toString('base64').split('').reverse().join('')),
  decryptString: (buffer) => Buffer.from(buffer.toString().split('').reverse().join(''), 'base64').toString('utf8')
}
const userData = join(dir, 'userData')
const folder = join(dir, '笔记')
await fs.mkdir(userData, { recursive: true })
await fs.mkdir(folder, { recursive: true })
const service = new SyncService({ getUserDataPath: () => userData, safeStorage: fakeSafeStorage, request: fetch })
const file = (rel) => join(folder, ...rel.split('/'))
const read = (rel) => fs.readFile(file(rel), 'utf8')
const write = async (rel, text) => { await fs.mkdir(join(file(rel), '..'), { recursive: true }); await fs.writeFile(file(rel), text) }
const connection = async () => {
  await adoptSyncWorkspace(userData, folder)
  return service.addWebDavConnection({ name: 'Cross-machine DAV', endpoint: dav, username: '', password: '', allowInsecure: true })
}

if (step === 'create') {
  await write('日记/十一月.md', '# 十一月\n\n第一行\n第二行\n第三行\n')
  await write('Mac 上写的.md', `来自 ${process.platform}\n`)
  await fs.mkdir(file('空文件夹'), { recursive: true })
  const conn = await connection()
  const bound = await service.bindWorkspace(folder, conn.id, { encryption: { password: PASSWORD } })
  assert.equal(bound.encrypted, true)
  const pushed = await service.run(folder, 'push')
  assert.equal(pushed.summary.upload, 3, JSON.stringify(pushed.summary))
  console.log(`  ✓ ${process.platform}: encrypted workspace created and pushed`)
} else if (step === 'join') {
  const conn = await connection()
  const listed = await service.listRemoteWorkspaces(conn.id)
  assert.equal(listed.length, 1, JSON.stringify(listed))
  assert.equal(listed[0].encrypted, true)
  await assert.rejects(service.joinWorkspace(folder, conn.id, listed[0].workspaceId, { password: 'not the password' }), /加密密码不对/)
  await service.joinWorkspace(folder, conn.id, listed[0].workspaceId, { password: PASSWORD })
  const pulled = await service.run(folder, 'pull')
  assert.equal(pulled.summary.download, 3, JSON.stringify(pulled.summary))
  assert.equal(await read('日记/十一月.md'), '# 十一月\n\n第一行\n第二行\n第三行\n')
  assert.equal(await read('Mac 上写的.md'), '来自 darwin\n')
  assert.ok((await fs.stat(file('空文件夹'))).isDirectory())
  console.log(`  ✓ ${process.platform}: wrong password refused; joined and got both files + the empty folder`)
  await write('日记/十一月.md', '# 十一月\n\n第一行\n第二行\nWindows 改了第三行\n')
  await write('Windows 上写的.md', `来自 ${process.platform}\n`)
  await fs.rm(file('Mac 上写的.md'))
  const merged = await service.run(folder, 'merge', null, { automatic: true })
  assert.equal(merged.needsConfirmation, undefined, JSON.stringify(merged))
  console.log(`  ✓ ${process.platform}: edit + new file + deletion synced back ${JSON.stringify(merged.summary)}`)
} else {
  await write('日记/十一月.md', '# 十一月\n\nMac 改了第一行\n第二行\n第三行\n')
  const merged = await service.run(folder, 'merge', null, { automatic: true })
  assert.equal(merged.merged, 1, JSON.stringify(merged))
  assert.equal(await read('日记/十一月.md'), '# 十一月\n\nMac 改了第一行\n第二行\nWindows 改了第三行\n')
  assert.equal(await read('Windows 上写的.md'), '来自 win32\n')
  await assert.rejects(fs.stat(file('Mac 上写的.md')), /ENOENT/)
  console.log(`  ✓ ${process.platform}: Windows's edit merged with a Mac edit, its new file arrived, its deletion applied`)
  console.log('PASS e2ee cross-machine sync')
}
