// Moves and renames between two devices (users: "folders and files moved to
// another folder affect sync too"). Sync has no rename operation: a move is a
// delete of the old path + an upload of the new one, and the other device
// applies both. Each scenario: sync A and B, change, sync until settled; both
// devices must end with the same tree, nothing left to do, and the expected
// files (no data lost, an edit made on the other side kept as a conflict copy).
// The case-only renames matter on case-insensitive disks (macOS, Windows):
// "Notes/a.md" and "notes/a.md" are the same file there.
// Empty files and empty folders between two devices. S3 has no directories:
// an empty folder exists remotely only as a zero-byte "path/" marker object
// (what the AWS console, rclone and S3 browsers create), so a sync that only
// uploads files silently loses empty folders. Folders with files need no
// marker. Deleting only ever removes EMPTY folders.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SyncEngine } from '../src/main/sync/sync-engine.js'
import { WebDavProvider } from '../src/main/sync/webdav-provider.js'

// Optional: run against a real WebDAV server (e.g. `wsgidav --root DIR
// --auth anonymous`) — HM_SYNC_MOVE_WEBDAV=<url>, HM_SYNC_MOVE_WEBDAV_ROOT=
// <the server's folder on disk>, which is then checked for leftovers too.
const davUrl = process.env.HM_SYNC_MOVE_WEBDAV
const davRoot = process.env.HM_SYNC_MOVE_WEBDAV_ROOT

// Object store with S3 semantics: keys only, "dir/" markers are objects.
class MemoryStore {
  constructor() { this.objects = new Map(); this.revision = 0 }
  async get(path) {
    const entry = this.objects.get(path)
    return entry ? { bytes: Buffer.from(entry.bytes), revision: entry.revision } : null
  }
  async put(path, bytes, { revision = null, createOnly = false } = {}) {
    const old = this.objects.get(path)
    if ((createOnly && old) || (revision && old?.revision !== revision)) throw new Error('远端文件已被其他设备修改，请重新同步。')
    const next = { bytes: Buffer.from(bytes), revision: String(++this.revision) }
    this.objects.set(path, next)
    return { revision: next.revision }
  }
  async delete(path) { this.objects.delete(path); return true }
  async createDirectory(path) { this.objects.set(`${path}/`, { bytes: Buffer.alloc(0), revision: String(++this.revision) }); return true }
  async removeDirectory(path) { this.objects.delete(`${path}/`); return true }
}

async function tree(dir, prefix = '') {
  const out = []
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.horsemd') continue
    const path = prefix + entry.name
    if (entry.isDirectory()) { out.push(`${path}/`); out.push(...await tree(join(dir, entry.name), `${path}/`)) }
    else out.push(`${path} = ${(await fs.readFile(join(dir, entry.name), 'utf8')).trim()}`)
  }
  return out
}

const results = []
async function scenario(name, setup, change, { onB = null, expect }) {
  const root = await fs.mkdtemp(join(tmpdir(), 'hm-move-'))
  const A = join(root, 'A'), B = join(root, 'B')
  await fs.mkdir(A); await fs.mkdir(B)
  await setup(A)
  const ws = randomUUID()
  const store = davUrl
    ? new WebDavProvider({ endpoint: davUrl, allowInsecure: true, prefix: `move-${ws}`, request: (url, init) => fetch(url, init) })
    : new MemoryStore()
  const run = (dir, label) => new SyncEngine({ rootPath: dir, userDataPath: join(root, 'p' + label), workspaceId: ws, provider: store, deviceName: label }).execute(null, 'merge')
  await run(A, 'A'); await run(B, 'B')
  await change(A)
  if (onB) await onB(B)
  const a1 = await run(A, 'A'); const b1 = await run(B, 'B')
  await run(B, 'B'); await run(A, 'A')
  const b2 = await run(B, 'B'); const a2 = await run(A, 'A')
  const ta = await tree(A), tb = await tree(B)
  const settled = [b2, a2].every((r) => !r.summary.upload && !r.summary.download && !r.summary.delete && !r.summary.conflict)
  assert.ok(settled, `${name}: settled`)
  assert.deepEqual(tb, ta, `${name}: same tree on both devices`)
  // Sorted by code unit: localeCompare orders Chinese differently on Windows.
  assert.deepEqual([...ta].sort(), [...expect].sort(), `${name}: expected files`)
  assert.ok(a1.summary.conflict === 0, `${name}: the moving device sees no conflict`)
  if (davRoot) {
    const server = join(davRoot, `move-${ws}`)
    assert.deepEqual([...await tree(server)].sort(), [...expect].sort(), `${name}: server holds exactly the files (no old folders)`)
    await fs.rm(server, { recursive: true, force: true })
  }
  await fs.rm(root, { recursive: true, force: true })
}
const mk = async (dir, files) => { for (const [p, c] of Object.entries(files)) { await fs.mkdir(join(dir, p, '..'), { recursive: true }); await fs.writeFile(join(dir, p), c) } }
const base = (d) => mk(d, { '甲/a.md': 'a\n', '甲/深/b.md': 'b\n', '乙/c.md': 'c\n' })
// A case-only rename through a temporary name (a direct rename works too,
// this matches what Finder / Explorer do on every file system).
const caseRename = async (dir, from, to) => { await fs.rename(join(dir, from), join(dir, `${to}.tmp`)); await fs.rename(join(dir, `${to}.tmp`), join(dir, to)) }

await scenario('文件移到别的文件夹（甲/a.md → 乙/a.md）', base, (A) => fs.rename(join(A, '甲/a.md'), join(A, '乙/a.md')), { expect: ['乙/', '乙/a.md = a', '乙/c.md = c', '甲/', '甲/深/', '甲/深/b.md = b'] })
await scenario('文件移走后旧文件夹变空（甲/深/b.md → 乙/b.md，A 上留着空的「深」，B 上也留着）', base, (A) => fs.rename(join(A, '甲/深/b.md'), join(A, '乙/b.md')), { expect: ['乙/', '乙/b.md = b', '乙/c.md = c', '甲/', '甲/a.md = a', '甲/深/'] })
await scenario('文件夹移进另一个文件夹（甲 → 乙/甲）', base, (A) => fs.rename(join(A, '甲'), join(A, '乙/甲')), { expect: ['乙/', '乙/c.md = c', '乙/甲/', '乙/甲/a.md = a', '乙/甲/深/', '乙/甲/深/b.md = b'] })
await scenario('文件夹移到上一层（甲/深 → 深）', base, (A) => fs.rename(join(A, '甲/深'), join(A, '深')), { expect: ['乙/', '乙/c.md = c', '深/', '深/b.md = b', '甲/', '甲/a.md = a'] })
await scenario('只改大小写的文件夹（notes → Notes）', (d) => mk(d, { 'notes/a.md': 'a\n', 'notes/b.md': 'b\n' }), (A) => caseRename(A, 'notes', 'Notes'), { expect: ['Notes/', 'Notes/a.md = a', 'Notes/b.md = b'] })
await scenario('只改大小写的文件夹（Notes → notes）', (d) => mk(d, { 'Notes/a.md': 'a\n', 'Notes/b.md': 'b\n' }), (A) => caseRename(A, 'Notes', 'notes'), { expect: ['notes/', 'notes/a.md = a', 'notes/b.md = b'] })
await scenario('只改大小写的文件（readme.md → README.md）', (d) => mk(d, { 'readme.md': 'r\n' }), (A) => caseRename(A, 'readme.md', 'README.md'), { expect: ['README.md = r'] })
await scenario('只改大小写的文件（README.md → readme.md）', (d) => mk(d, { 'README.md': 'r\n' }), (A) => caseRename(A, 'README.md', 'readme.md'), { expect: ['readme.md = r'] })
await scenario('A 移动文件夹，B 同时改了里面的文件（B 的修改留作冲突副本）', base, (A) => fs.rename(join(A, '甲'), join(A, '丙')), { onB: (B) => fs.writeFile(join(B, '甲/a.md'), 'a 改过\n'), expect: ['丙/', '丙/a.md = a', '丙/深/', '丙/深/b.md = b', '乙/', '乙/c.md = c', '甲/', '甲/a (来自 B 的冲突副本).md = a 改过'] })
await scenario('A 移动文件夹，B 在旧文件夹里新建文件（新文件保留）', base, (A) => fs.rename(join(A, '甲'), join(A, '丙')), { onB: (B) => fs.writeFile(join(B, '甲/新.md'), 'new\n'), expect: ['丙/', '丙/a.md = a', '丙/深/', '丙/深/b.md = b', '乙/', '乙/c.md = c', '甲/', '甲/新.md = new'] })
await scenario('两边把同一个文件夹移到不同地方（两份都留下）', base, (A) => fs.rename(join(A, '甲'), join(A, '丙')), { onB: (B) => fs.rename(join(B, '甲'), join(B, '丁')), expect: ['丁/', '丁/a.md = a', '丁/深/', '丁/深/b.md = b', '丙/', '丙/a.md = a', '丙/深/', '丙/深/b.md = b', '乙/', '乙/c.md = c'] })
await scenario('A 改名，B 也做了同样的改名', base, (A) => fs.rename(join(A, '甲'), join(A, '丙')), { onB: (B) => fs.rename(join(B, '甲'), join(B, '丙')), expect: ['丙/', '丙/a.md = a', '丙/深/', '丙/深/b.md = b', '乙/', '乙/c.md = c'] })
await scenario('交换两个文件的名字', (d) => mk(d, { 'x.md': 'X\n', 'y.md': 'Y\n' }), async (A) => { await fs.rename(join(A, 'x.md'), join(A, 't')); await fs.rename(join(A, 'y.md'), join(A, 'x.md')); await fs.rename(join(A, 't'), join(A, 'y.md')) }, { expect: ['x.md = Y', 'y.md = X'] })

console.log((davUrl ? `[WebDAV ${davUrl}] ` : '') + 'PASS sync move: files / folders moved or renamed (incl. case-only renames on case-insensitive disks) reach the other device intact, nothing left behind, concurrent edits kept')
