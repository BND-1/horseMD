// End-to-end encrypted sync workspaces (src/shared/sync/sync-crypto.js,
// encrypted-provider.js; docs/official-sync-design.md §4): the key file,
// passwords, names, sealing, and two devices running the real engine through
// EncryptedProvider — the cloud never holds a file name or file content.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SyncEngine } from '../src/main/sync/sync-engine.js'
import { nodeBytes } from '../src/main/sync/node-platform.js'
import {
  createKeyFile, unlockKeyFile, rewrapKeyFile, parseKeyFile, workspaceCipher,
  WrongPasswordError, NotEncryptedDataError, KeyChangedError, keyCheckFor, KEY_FILE, DEFAULT_ITERATIONS
} from '../src/shared/sync/sync-crypto.js'
import { EncryptedProvider, readKeyFile, writeKeyFile } from '../src/shared/sync/encrypted-provider.js'

class MemoryProvider {
  constructor() { this.objects = new Map(); this.revision = 0 }
  async testConnection() { return { ok: true } }
  async get(path) {
    const entry = this.objects.get(path)
    return entry ? { bytes: Buffer.from(entry.bytes), revision: entry.revision } : null
  }
  async put(path, bytes, { revision = null, createOnly = false } = {}) {
    const old = this.objects.get(path)
    if ((createOnly && old) || (revision && old?.revision !== revision)) {
      const error = new Error('conditional write failed'); error.status = 412; throw error
    }
    const next = { bytes: Buffer.from(bytes), revision: String(++this.revision) }
    this.objects.set(path, next)
    return { revision: next.revision }
  }
  async copy(from, to, { revision = null } = {}) {
    const old = this.objects.get(from)
    if (!old || (revision && old.revision !== revision)) return null
    const next = { bytes: Buffer.from(old.bytes), revision: String(++this.revision) }
    this.objects.set(to, next)
    return { revision: next.revision }
  }
  async delete(path, { revision = null } = {}) {
    const old = this.objects.get(path)
    if (revision && old?.revision !== revision) throw new Error('conditional delete failed')
    this.objects.delete(path)
    return true
  }
  async createDirectory(path) { this.objects.set(`${path}/`, { bytes: Buffer.alloc(0), revision: String(++this.revision) }); return true }
  async removeDirectory(path) { this.objects.delete(`${path}/`); return true }
  async list() { return [] }
}

const FAST = { iterations: 1000 }

// 1. Key file: create, unlock, wrong password, rewrap, damage, newer format.
{
  const { keyFile, master } = await createKeyFile('正确的密码 horse', FAST)
  assert.equal(master.byteLength, 32)
  const json = JSON.stringify(keyFile)
  assert.ok(!json.includes('正确的密码'), 'the password is never stored')
  assert.deepEqual(await unlockKeyFile(json, '正确的密码 horse'), master)
  // NFC vs NFD spelling of the same password (macOS IME vs Windows) unlock alike.
  const { keyFile: accented, master: m2 } = await createKeyFile('café', FAST)
  assert.deepEqual(await unlockKeyFile(accented, 'café'), m2)
  await assert.rejects(unlockKeyFile(keyFile, '错误的密码'), WrongPasswordError)
  await assert.rejects(unlockKeyFile(keyFile, ''), /请输入加密密码/)

  const rewrapped = await rewrapKeyFile(keyFile, '正确的密码 horse', '新密码')
  assert.notEqual(rewrapped.kdf.salt, keyFile.kdf.salt, 'a new salt on every wrap')
  assert.deepEqual(await unlockKeyFile(rewrapped, '新密码'), master, 'same master key after a password change')
  await assert.rejects(unlockKeyFile(rewrapped, '正确的密码 horse'), WrongPasswordError)
  await assert.rejects(rewrapKeyFile(keyFile, '错', 'x'), WrongPasswordError)

  const tampered = structuredClone(keyFile)
  tampered.key.wrapped = tampered.key.wrapped.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))
  await assert.rejects(unlockKeyFile(tampered, '正确的密码 horse'), WrongPasswordError)
  assert.equal(keyFile.check, await keyCheckFor(master))
  // A key file whose check does not match its key is damaged, not a password error.
  await assert.rejects(unlockKeyFile({ ...keyFile, check: '0'.repeat(64) }, '正确的密码 horse'), NotEncryptedDataError)
  assert.throws(() => parseKeyFile({ ...keyFile, check: undefined }), NotEncryptedDataError)
  assert.throws(() => parseKeyFile('{not json'), NotEncryptedDataError)
  assert.throws(() => parseKeyFile({ ...keyFile, version: 2 }), /更新版本的 HorseMD/)
  assert.throws(() => parseKeyFile({ ...keyFile, kdf: { ...keyFile.kdf, iterations: 10 } }), NotEncryptedDataError)

  // Two salts for the same password → two different wraps (SiYuan derived its
  // salt from the password, so equal passwords gave equal keys).
  const again = await createKeyFile('正确的密码 horse', FAST)
  assert.notEqual(again.keyFile.kdf.salt, keyFile.kdf.salt)
  assert.notDeepEqual(again.master, master)
}

// 2. The default work factor stays usable (one unlock ≈ what a phone pays).
{
  const t0 = performance.now()
  const { keyFile } = await createKeyFile('timing')
  assert.equal(keyFile.kdf.iterations, DEFAULT_ITERATIONS)
  await unlockKeyFile(keyFile, 'timing')
  const ms = performance.now() - t0
  console.log(`PBKDF2 ${DEFAULT_ITERATIONS}: create + unlock ${Math.round(ms)} ms`)
  assert.ok(ms < 5000, `create + unlock took ${ms} ms`)
}

// 3. Cipher: names deterministic per key, different across keys; sealing
// random per call; damage detected; empty and large files.
{
  const a = await workspaceCipher((await createKeyFile('a', FAST)).master)
  const b = await workspaceCipher((await createKeyFile('b', FAST)).master)
  assert.equal(await a.objectNameFor('笔记/第一篇.md'), await a.objectNameFor('笔记/第一篇.md'))
  assert.notEqual(await a.objectNameFor('笔记/第一篇.md'), await b.objectNameFor('笔记/第一篇.md'))
  assert.notEqual(await a.objectNameFor('a.md'), await a.objectNameFor('A.md'), 'case-only renames stay two objects')
  assert.match(await a.objectNameFor('x'.repeat(2000)), /^[0-9a-f]{64}$/, 'fixed length whatever the path')
  const text = new TextEncoder().encode('# 标题\n正文')
  const s1 = await a.encrypt(text)
  const s2 = await a.encrypt(text)
  assert.notDeepEqual(s1, s2, 'a fresh nonce every time')
  assert.deepEqual(await a.decrypt(s1), text)
  await assert.rejects(b.decrypt(s1), NotEncryptedDataError, 'another key cannot read it')
  const flipped = Uint8Array.from(s1); flipped[flipped.length - 1] ^= 1
  await assert.rejects(a.decrypt(flipped), NotEncryptedDataError, 'any change is detected')
  await assert.rejects(a.decrypt(text), NotEncryptedDataError, 'plain bytes are refused')
  assert.deepEqual(await a.decrypt(await a.encrypt(new Uint8Array(0))), new Uint8Array(0))
  const big = new Uint8Array(8 * 1024 * 1024).map((_, i) => i & 0xff)
  assert.deepEqual(await a.decrypt(await a.encrypt(big)), big)
}

// 4. Two devices, the real engine, one encrypted cloud.
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-sync-e2ee-'))
try {
  const cloud = new MemoryProvider()
  const workspaceId = randomUUID()
  const password = '马的同步密码'

  // Device A creates the workspace key and publishes it.
  const created = await createKeyFile(password, FAST)
  await writeKeyFile(cloud, created.keyFile, { createOnly: true, bytes: nodeBytes })
  // Device B only has the password: it reads the key file from the cloud.
  const keyText = await readKeyFile(cloud, nodeBytes)
  const masterB = await unlockKeyFile(keyText, password)
  await assert.rejects(unlockKeyFile(keyText, '猜的密码'), WrongPasswordError)

  const providerFor = async (master) => new EncryptedProvider({ inner: cloud, cipher: await workspaceCipher(master), bytes: nodeBytes })
  const providerA = await providerFor(created.master)
  const providerB = await providerFor(masterB)
  const dirs = { a: join(root, 'a'), b: join(root, 'b') }
  const engine = (side) => new SyncEngine({
    rootPath: dirs[side], userDataPath: join(root, `profile-${side}`), workspaceId,
    provider: side === 'a' ? providerA : providerB, deviceName: side === 'a' ? 'Mac' : 'Phone'
  })

  await fs.mkdir(join(dirs.a, '日记', '空文件夹'), { recursive: true })
  await fs.mkdir(dirs.b, { recursive: true })
  const secretText = '# 机密标题\n只有我能看到的内容 SECRET-BODY\n'
  await fs.writeFile(join(dirs.a, '日记', '第一天.md'), secretText)
  await fs.writeFile(join(dirs.a, 'photo-SECRETNAME.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))

  await engine('a').execute(await engine('a').preview())
  const plan = await engine('b').preview()
  assert.deepEqual(plan.operations.map((o) => o.type).sort(), ["createLocalDir", "download", "download"])
  await engine('b').execute(plan)
  assert.equal(await fs.readFile(join(dirs.b, '日记', '第一天.md'), 'utf8'), secretText)
  assert.deepEqual(await fs.readFile(join(dirs.b, 'photo-SECRETNAME.png')), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  assert.ok((await fs.stat(join(dirs.b, '日记', '空文件夹'))).isDirectory(), 'empty folders arrive through the manifest')

  // Both edit the same note → the engine's three-way merge, through ciphertext.
  await fs.writeFile(join(dirs.a, '日记', '第一天.md'), '# 机密标题 A\n只有我能看到的内容 SECRET-BODY\n')
  await engine('a').execute()
  await fs.writeFile(join(dirs.b, '日记', '第一天.md'), '# 机密标题\n只有我能看到的内容 SECRET-BODY\n第二行 B\n')
  await engine('b').execute(await engine('b').preview())
  assert.equal(await fs.readFile(join(dirs.b, '日记', '第一天.md'), 'utf8'), '# 机密标题 A\n只有我能看到的内容 SECRET-BODY\n第二行 B\n')
  await engine('a').execute()
  assert.equal(await fs.readFile(join(dirs.a, '日记', '第一天.md'), 'utf8'), '# 机密标题 A\n只有我能看到的内容 SECRET-BODY\n第二行 B\n')

  // A deletes the picture → B deletes it; the cloud keeps a trash copy (t/…).
  await fs.rm(join(dirs.a, 'photo-SECRETNAME.png'))
  await engine('a').execute(await engine('a').preview())
  const deletion = await engine('b').preview()
  assert.equal(deletion.summary.delete, 1)
  await engine('b').execute(deletion)
  await assert.rejects(fs.stat(join(dirs.b, 'photo-SECRETNAME.png')), { code: 'ENOENT' })
  const keys = [...cloud.objects.keys()]
  assert.ok(keys.some((k) => /^t\/[^/]+\/[0-9a-f]{64}$/.test(k)), `a trash copy under t/: ${keys.join(', ')}`)

  // 5. What the cloud holds: the key file, o/<hex>, t/<stamp>/<hex> — nothing else.
  for (const key of keys) {
    assert.match(key, /^(\.horsemd\/encryption\.json|o\/[0-9a-f]{64}|t\/[0-9A-Za-z_-]+\/[0-9a-f]{64})$/, `object name ${key}`)
  }
  const needles = ['SECRET', '机密', '第一天', '日记', '空文件夹', 'manifest', 'sha256', 'photo']
  for (const [key, { bytes }] of cloud.objects) {
    if (key === KEY_FILE) continue
    const raw = bytes.toString('latin1') + bytes.toString('utf8')
    for (const needle of needles) assert.ok(!raw.includes(needle), `${key} leaks "${needle}"`)
  }

  // 6. A wrong key never writes: it cannot even read the manifest.
  const stranger = await providerFor((await createKeyFile('另一个人', FAST)).master)
  const strangerEngine = new SyncEngine({ rootPath: join(root, 'c'), userDataPath: join(root, 'profile-c'), workspaceId, provider: stranger, deviceName: 'X' })
  await fs.mkdir(join(root, 'c'), { recursive: true })
  const before = JSON.stringify([...cloud.objects.keys()].sort())
  await assert.rejects(strangerEngine.preview(), KeyChangedError)
  assert.equal(JSON.stringify([...cloud.objects.keys()].sort()), before)

  // A key file replaced by another device (new key) stops the old one too.
  const replaced = await createKeyFile(password, FAST)
  const current = await cloud.get(KEY_FILE)
  await writeKeyFile(cloud, replaced.keyFile, { revision: current.revision, bytes: nodeBytes })
  const stale = await providerFor(created.master)
  await assert.rejects(stale.get('日记/第一天.md'), KeyChangedError)
  await writeKeyFile(cloud, created.keyFile, { revision: (await cloud.get(KEY_FILE)).revision, bytes: nodeBytes })
  // No key file at all (cloud wiped) → stop, never write into a namespace nobody can read.
  const saved = cloud.objects.get(KEY_FILE); cloud.objects.delete(KEY_FILE)
  await assert.rejects((await providerFor(created.master)).put('x.md', Buffer.from('x')), KeyChangedError)
  cloud.objects.set(KEY_FILE, saved)

  // 7. The key file itself is out of reach through the encrypted provider.
  await assert.rejects(providerA.get(KEY_FILE), /不能直接访问/)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

console.log('sync e2ee: ok')
