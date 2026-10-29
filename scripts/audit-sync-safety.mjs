// Sync data-safety audit (docs/cloud-sync-review.md). Two devices, one
// object store with S3 semantics (keys only, conditional writes), the real
// SyncEngine — named "HorseMD" on both devices, as SyncService does.
// Each scenario prints what happened and a verdict:
//   RISK — data was lost / blocked / the user gets an error for a normal case
//   OK   — the behaviour is safe
// This documents the CURRENT behaviour; it exits 0 either way. When a risk is
// fixed, turn its scenario into an assertion in a regular test.
// Run: node scripts/audit-sync-safety.mjs  (or --json for machine output)
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { SyncEngine } from '../src/main/sync/sync-engine.js'
import { initHistory, historyStore, syncHistory } from '../src/main/history/history-service.js'

class MemoryStore {
  constructor() { this.objects = new Map(); this.revision = 0; this.puts = 0 }
  async get(path) {
    const entry = this.objects.get(path)
    return entry ? { bytes: Buffer.from(entry.bytes), revision: entry.revision } : null
  }
  async put(path, bytes, { revision = null, createOnly = false } = {}) {
    this.puts += 1
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

const results = []
const report = (id, title, verdict, detail) => {
  results.push({ id, title, verdict, detail })
  if (!process.argv.includes('--json')) console.log(`[${verdict}] ${id} ${title}\n       ${detail}\n`)
}

async function setup() {
  const root = await fs.mkdtemp(join(tmpdir(), 'hm-sync-audit-'))
  const A = join(root, 'A'), B = join(root, 'B')
  await fs.mkdir(A); await fs.mkdir(B)
  const ws = randomUUID()
  const store = new MemoryStore()
  // The local version history, as the app has it since P1 (one per run).
  initHistory(join(root, 'history'))
  // Since 2026-10-29 SyncService names devices by host name; the audit keeps
  // both devices on one name ("HorseMD") — the worst case for R3.
  const engine = (dir, label, busyPaths = []) => new SyncEngine({ rootPath: dir, userDataPath: join(root, 'state-' + label), workspaceId: ws, provider: store, deviceName: 'HorseMD', busyPaths, history: syncHistory })
  // As SyncService.run: a lost manifest race re-plans (up to 3 attempts);
  // `busy` = files open with unsaved edits, as the app passes them.
  const sync = async (dir, label, { busy = [], ...options } = {}) => {
    for (let attempt = 1; ; attempt += 1) {
      try { return await engine(dir, label, busy).execute(null, 'merge', options) } catch (error) {
        if (error?.manifestChanged && attempt < 3) continue
        return { error: error.message }
      }
    }
  }
  return { root, A, B, store, engine, sync, history: join(root, 'history'), a: (o) => sync(A, 'A', o), b: (o) => sync(B, 'B', o) }
}
const write = (dir, path, text) => fs.mkdir(join(dir, path, '..'), { recursive: true }).then(() => fs.writeFile(join(dir, path), text))
const read = (dir, path) => fs.readFile(join(dir, path), 'utf8').catch(() => null)

// Every place a text could still be: both folders (with their .horsemd/trash)
// and every cloud object (with the cloud trash).
async function everywhere(env, needle) {
  const hits = []
  const walk = async (dir, label, prefix = '') => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path, label, prefix + entry.name + '/')
      else if ((await fs.readFile(path, 'utf8')).includes(needle)) hits.push(`${label}:${prefix}${entry.name}`)
    }
  }
  await walk(env.A, 'A'); await walk(env.B, 'B')
  for (const [key, value] of env.store.objects) if (value.bytes.toString('utf8').includes(needle)) hits.push(`cloud:${key}`)
  // The local version history (content is gzip, one file per content).
  const objects = join(env.history, 'objects')
  for (const sub of await fs.readdir(objects).catch(() => [])) {
    for (const name of await fs.readdir(join(objects, sub))) {
      if (gunzipSync(await fs.readFile(join(objects, sub, name))).toString('utf8').includes(needle)) hits.push(`历史版本:${name.slice(0, 8)}`)
    }
  }
  return hits
}

// R1. Unsaved edit on A + B's edit synced down + A saves → B's edit lost
// everywhere. (In the app: the download overwrites the file on disk, A's
// dirty tab shows "已在其他应用中被修改…现在保存会覆盖外部版本", and Save
// writes the tab — see test-sync-dirty-tab-save-ui.mjs for that part.)
{
  const env = await setup()
  await write(env.A, '笔记.md', '原文\n'); await env.a(); await env.b()
  await write(env.B, '笔记.md', '原文\nB 的修改\n'); await env.b()
  // A has typed "A 的修改" in the editor but not saved; automatic sync runs
  // (the app passes the open, unsaved file as busy).
  const down = await env.a({ automatic: true, busy: ['笔记.md'] })
  const afterDownload = await read(env.A, '笔记.md')
  // A presses Save: the editor content (without B's line) is written.
  await write(env.A, '笔记.md', '原文\nA 的修改\n')
  await env.a(); await env.b()
  const hits = await everywhere(env, 'B 的修改')
  report('R1', '未保存的修改 + 对方的修改同步下来 + 保存', hits.length ? 'OK' : 'RISK',
    `自动同步${down.deferred?.length ? '没有覆盖这个打开着的文件（留到保存后）' : '把 B 的版本直接写进 A 的文件'}，磁盘内容为 ${JSON.stringify(afterDownload)}；A 保存后再同步两边：「B 的修改」${hits.length ? '仍在 ' + hits.join(', ') : '在 A、B、云端（含回收站）都已不存在'}`)
}

// R2. Ordinary edits overwritten by sync keep no earlier version anywhere.
{
  const env = await setup()
  await write(env.A, 'a.md', '版本1\n'); await env.a(); await env.b()
  for (const v of ['版本2', '版本3']) { await write(env.A, 'a.md', `${v}\n`); await env.a(); await env.b() }
  const old = [...await everywhere(env, '版本1'), ...await everywhere(env, '版本2')]
  report('R2', '普通修改被同步覆盖后有没有旧版本', old.length ? 'OK' : 'RISK',
    old.length ? `旧版本在 ${old.join(', ')}` : '改了三次并同步后，版本1、版本2 在两台设备和云端都找不到（没有任何历史版本）')
}

// R3. Conflict copies are named after the device, which SyncService fixes to
// "HorseMD": a second conflict on the same file collides with the first copy.
{
  const env = await setup()
  await write(env.A, 'x.md', '0\n'); await env.a(); await env.b()
  await write(env.A, 'x.md', 'A1\n'); await write(env.B, 'x.md', 'B1\n')
  await env.a(); const first = await env.b(); await env.a()
  await write(env.A, 'x.md', 'A2\n'); await write(env.B, 'x.md', 'B2\n')
  await env.a(); const second = await env.b()
  const copies = (await fs.readdir(env.B)).filter((n) => n.includes('冲突副本'))
  const localCopy = await read(env.B, copies[0] || 'none')
  // Keep syncing both devices a few rounds, as automatic sync would.
  const later = []
  for (let i = 0; i < 3; i += 1) later.push(await env.b(), await env.a())
  const stuck = later.filter((r) => r.error).length
  const stuckB = later.filter((r, i) => i % 2 === 0 && r.error).length
  const lost = (await everywhere(env, 'B1')).length === 0
  report('R3', '同一文件第二次冲突（两台设备名都是 HorseMD）', second.error || lost ? 'RISK' : 'OK',
    `第一次冲突：${first.error ? '出错 ' + first.error : '生成 ' + copies.join('、')}；第二次冲突：${second.error ? '同步失败「' + second.error + '」，B 本地的冲突副本已被改写为 ' + JSON.stringify(localCopy) : '完成'}；之后两台各同步 3 次：B ${stuckB}/3 次失败、A ${stuck - stuckB}/3 次失败（B 不会自己恢复）；最终第一次冲突的「B1」${lost ? '在两台设备和云端都已丢失' : '仍在'}`)
}

// R4. One deletion holds the whole automatic round: other edits stay only on
// this device until someone confirms in Settings.
{
  const env = await setup()
  await write(env.A, '删掉的.md', 'x\n'); await write(env.A, '在写的.md', '旧\n'); await env.a(); await env.b()
  await fs.rm(join(env.A, '删掉的.md')); await write(env.A, '在写的.md', '今天写的重要内容\n')
  const auto = await env.a({ automatic: true })
  const inCloud = (await everywhere(env, '今天写的重要内容')).filter((h) => h.startsWith('cloud:'))
  report('R4', '有一个删除时，自动同步的整轮被跳过', auto.needsConfirmation && !inCloud.length ? 'RISK' : 'OK',
    `自动同步返回 ${JSON.stringify({ needsConfirmation: auto.needsConfirmation, reason: auto.reason })}；另一个文件里今天写的内容${inCloud.length ? '已上传' : '没有上传，只存在这台电脑上，直到用户去设置里确认'}`)
}

// R5. Saving while a sync runs: the manifest records the hash scanned before
// the save, the cloud gets the bytes after it; the other device then fails.
{
  const env = await setup()
  await write(env.A, 'a.md', '1\n'); await env.a(); await env.b()
  await write(env.A, 'a.md', '2\n')
  const engine = env.engine(env.A, 'A')
  const preview = await engine.preview('merge')
  await write(env.A, 'a.md', '3（同步过程中保存）\n') // saved after the scan, before the upload
  await engine.execute(preview, 'merge')
  const b = await env.b()
  const again = await env.b()
  const aNext = await env.a()
  const bAfter = await env.b()
  const final = await read(env.B, 'a.md')
  report('R5', '同步进行中保存文件', b.error ? 'RISK' : 'OK',
    b.error ? `另一台设备同步失败「${b.error}」；再试一次${again.error ? '仍失败' : '成功'}；这台设备再同步一次（${aNext.error ? '出错' : '上传 ' + (aNext.summary?.upload ?? 0) + ' 个'}）后，另一台${bAfter.error ? '仍失败' : '恢复，内容为 ' + JSON.stringify(final)}` : '另一台设备正常')
}

// R9. Saving while a sync runs, download side: the plan says "remote changed,
// local unchanged → download"; the user saves this file after the scan and
// before the download writes it.
{
  const env = await setup()
  await write(env.A, 'n.md', '原文\n'); await env.a(); await env.b()
  await write(env.B, 'n.md', '原文\nB 的修改\n'); await env.b()
  const engine = env.engine(env.A, 'A')
  const preview = await engine.preview('merge')
  await write(env.A, 'n.md', '原文\nA 刚保存的内容\n') // saved after the scan, before the download
  await engine.execute(preview, 'merge')
  await env.a(); await env.b()
  const hits = await everywhere(env, 'A 刚保存的内容')
  report('R9', '同步进行中保存文件（下载方向）', hits.length ? 'OK' : 'RISK',
    `A 在扫描之后、下载写入之前保存；${hits.length ? '保存的内容仍在 ' + hits.join(', ') : '下载直接覆盖，A 刚保存的内容在两台设备和云端（含回收站）都已不存在'}`)
}

// R6. Both devices syncing at the same moment.
{
  const env = await setup()
  await write(env.A, 'a.md', '1\n'); await env.a(); await env.b()
  await write(env.A, 'a.md', 'A\n'); await write(env.B, 'b.md', 'B\n')
  const [ra, rb] = await Promise.all([env.a(), env.b()])
  const failed = [ra, rb].filter((r) => r.error)
  const settle = [await env.a(), await env.b(), await env.a(), await env.b()]
  const ok = (await read(env.A, 'b.md')) === 'B\n' && (await read(env.B, 'a.md')) === 'A\n'
  report('R6', '两台设备同时同步', failed.length ? 'RISK' : 'OK',
    `${failed.length ? `其中一台报错「${failed[0].error}」（用户会看到同步失败）` : '都成功'}；再同步一轮后${ok && !settle.some((r) => r.error) ? '两边一致，没有丢数据' : '仍不一致'}`)
}

// R7. Deletion on one device, edit on the other.
{
  const env = await setup()
  await write(env.A, 'd.md', '旧\n'); await env.a(); await env.b()
  await fs.rm(join(env.A, 'd.md')); await write(env.B, 'd.md', 'B 改过\n')
  await env.a(); const b = await env.b(); await env.a()
  const hits = await everywhere(env, 'B 改过')
  report('R7', '一边删除、另一边修改', hits.length ? 'OK' : 'RISK', `B 的修改${hits.length ? '保留在 ' + hits.join(', ') : '丢失'}${b.error ? '；同步出错 ' + b.error : ''}`)
}

// R8. Local trash: inside the user's folder, never cleaned.
{
  const env = await setup()
  for (let i = 0; i < 5; i += 1) await write(env.A, `f${i}.md`, `内容${i}\n`.repeat(200))
  await env.a(); await env.b()
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 5; i += 1) await fs.rm(join(env.B, `f${i}.md`), { force: true })
    await env.b(); await env.a()
    for (let i = 0; i < 5; i += 1) await write(env.B, `f${i}.md`, `内容${i}-${round}\n`.repeat(200))
    await env.b(); await env.a()
  }
  const trash = join(env.A, '.horsemd', 'trash')
  const stamps = await fs.readdir(trash).catch(() => [])
  const cloudTrash = [...env.store.objects.keys()].filter((k) => k.startsWith('.horsemd/trash/')).length
  const deleted = await historyStore().listDeleted()
  const ok = stamps.length === 0 && deleted.length > 0
  report('R8', '回收站的位置和清理', ok ? 'OK' : 'RISK',
    ok
      ? `用户文件夹里不再写回收站；被同步删除的 ${deleted.length} 个文件在「最近删除」里（本机历史，按保留期自动清理）；云端回收站 ${cloudTrash} 个对象（云端，未改变）`
      : `本地回收站在用户文件夹里（${join('<文件夹>', '.horsemd', 'trash')}），3 轮删除后有 ${stamps.length} 个时间目录；云端回收站 ${cloudTrash} 个对象；没有清理，也没有界面`)
}

// OK checks: an emptied cloud never deletes local files; delete-vs-modify keeps
// the edit (R7); concurrent runs converge (R6).
{
  const env = await setup()
  await write(env.A, 'keep.md', '重要\n'); await env.a()
  env.store.objects.clear()
  const r = await env.a()
  const still = await read(env.A, 'keep.md')
  report('S1', '云端被清空后同步', still === '重要\n' ? 'OK' : 'RISK',
    `本地文件${still ? '仍在' : '被删除'}；同步结果：${r.error ? '停止并提示「' + r.error + '」' : JSON.stringify(r.summary)}`)
}

if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2))
else console.log(`${results.filter((r) => r.verdict === 'RISK').length} risk(s), ${results.filter((r) => r.verdict === 'OK').length} ok`)
