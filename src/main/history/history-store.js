import fs from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { gzip as gzipCb, gunzip as gunzipCb } from 'node:zlib'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'

const gzip = promisify(gzipCb)
const gunzip = promisify(gunzipCb)

// Local version history (docs/cloud-sync-review.md P1). Every file HorseMD
// saves, and every file the sync overwrites or deletes, leaves the version
// that is about to be replaced here, so a bad edit, a wrong merge or a
// deletion can be undone. Pure Node (no Electron) — test:history-store.
//
// <root>/objects/ab/<sha256>.gz   content, gzip, stored once per content
// <root>/index/<hash of path>.json { path, versions: [{ id, at, sha, size, reason, pinned }] }
// <root>/deleted.json             { items: [{ id, path, at, sha, size, reason }] }
//
// Retention: every version younger than an hour; then the oldest of each
// hour for a day, of each day up to 30 days, of each week up to
// `retentionDays`; nothing older. Pinned versions are never removed. Above
// `capBytes` the oldest unpinned versions go first.

export const HOUR = 3600000
export const DAY = 24 * HOUR
export const REASONS = new Set(['save', 'sync-overwrite', 'sync-delete', 'delete', 'restore', 'merge'])
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Keys are case-insensitive where the disk is (macOS, Windows).
const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32'
export const pathKey = (path) => {
  const full = resolve(String(path))
  return caseInsensitive ? full.toLowerCase() : full
}
const indexName = (path) => `${createHash('sha1').update(pathKey(path)).digest('hex')}.json`
const newId = (at) => `${at.toString(36)}-${randomBytes(3).toString('hex')}`

async function writeJsonAtomic(path, value) {
  await fs.mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(temp, JSON.stringify(value))
  await fs.rename(temp, path)
}
async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return fallback
    throw error
  }
}

// Which versions survive thinning (ascending by time; returns a Set of ids).
export function versionsToKeep(versions, { now, retentionDays }) {
  const keep = new Set()
  const seen = new Set()
  const sorted = [...versions].sort((a, b) => a.at - b.at)
  const newest = sorted[sorted.length - 1]
  for (const version of sorted) {
    const age = now - version.at
    if (version.pinned) { keep.add(version.id); continue }
    if (age > retentionDays * DAY) continue
    let bucket = null
    if (age < HOUR) bucket = null // all
    else if (age < DAY) bucket = `h${Math.floor(version.at / HOUR)}`
    else if (age < 30 * DAY) bucket = `d${Math.floor(version.at / DAY)}`
    else bucket = `w${Math.floor(version.at / (7 * DAY))}`
    if (bucket && seen.has(bucket)) continue
    if (bucket) seen.add(bucket)
    keep.add(version.id)
  }
  // The most recent version is the one most likely to be needed: kept while
  // it is inside the retention period.
  if (newest && now - newest.at <= retentionDays * DAY) keep.add(newest.id)
  return keep
}

export class HistoryStore {
  constructor({ root, now = () => Date.now(), retentionDays = 30, capBytes = 1024 * 1024 * 1024 }) {
    this.root = root
    this.now = now
    this.retentionDays = retentionDays
    this.capBytes = capBytes
    this.queues = new Map() // index file -> promise chain (one writer per file)
    this.recordsSincePrune = 0
    this.pruning = null
  }

  objectPath(sha) { return join(this.root, 'objects', sha.slice(0, 2), `${sha}.gz`) }
  indexPath(path) { return join(this.root, 'index', indexName(path)) }
  get deletedPath() { return join(this.root, 'deleted.json') }

  // Serialize read-modify-write of one json file.
  locked(file, task) {
    const previous = this.queues.get(file) || Promise.resolve()
    const run = previous.catch(() => {}).then(task)
    const tail = run.catch(() => {})
    this.queues.set(file, tail)
    tail.then(() => { if (this.queues.get(file) === tail) this.queues.delete(file) })
    return run
  }

  async putObject(bytes) {
    const sha = sha256(bytes)
    const target = this.objectPath(sha)
    try {
      // Already stored: refresh its time, so a prune running right now
      // treats it as fresh instead of collecting it under the new reference.
      const stamp = new Date()
      await fs.utimes(target, stamp, stamp)
      return sha
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await fs.mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await fs.writeFile(temp, await gzip(bytes))
    await fs.rename(temp, target)
    return sha
  }

  async readObject(sha) {
    return gunzip(await fs.readFile(this.objectPath(sha)))
  }

  async readIndex(path) {
    const index = await readJson(this.indexPath(path), null)
    return index && Array.isArray(index.versions) ? index : { path: resolve(path), versions: [] }
  }

  // Keep `bytes` as a version of `path` (the content about to be replaced).
  // `throttleMs`: skip when the newest version is younger (saves); `force`
  // overrides it (a save that removes a large part of the text). The same
  // content as the newest version is never stored twice in a row.
  async record(path, bytes, reason, { throttleMs = 0, force = false } = {}) {
    if (!REASONS.has(reason)) throw new Error(`unknown history reason ${reason}`)
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8')
    const at = this.now()
    const version = await this.locked(this.indexPath(path), async () => {
      const index = await this.readIndex(path)
      const newest = index.versions[index.versions.length - 1]
      const sha = sha256(buffer)
      if (newest?.sha === sha) return null
      if (!force && throttleMs > 0 && newest && at - newest.at < throttleMs) return null
      await this.putObject(buffer)
      const entry = { id: newId(at), at, sha, size: buffer.byteLength, reason, pinned: false }
      index.path = resolve(path)
      index.versions.push(entry)
      await writeJsonAtomic(this.indexPath(path), index)
      return entry
    })
    if (version) this.afterRecord()
    return version
  }

  // A file that is about to disappear: a version of it, plus an entry in
  // 「最近删除」.
  async recordDeletion(path, bytes, reason = 'delete') {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8')
    await this.record(path, buffer, reason, { force: true })
    const at = this.now()
    const sha = await this.putObject(buffer)
    return this.locked(this.deletedPath, async () => {
      const list = await readJson(this.deletedPath, { items: [] })
      const item = { id: newId(at), path: resolve(path), at, sha, size: buffer.byteLength, reason }
      list.items = [...(list.items || []), item]
      await writeJsonAtomic(this.deletedPath, list)
      return item
    })
  }

  async list(path) {
    const index = await this.readIndex(path)
    return [...index.versions].sort((a, b) => b.at - a.at).map(({ id, at, reason, size, pinned }) => ({ id, at, reason, size, pinned: Boolean(pinned) }))
  }

  async findVersion(path, id) {
    const index = await this.readIndex(path)
    const version = index.versions.find((item) => item.id === id)
    if (!version) throw new Error('找不到这个历史版本，可能已过期被清理。')
    return version
  }

  async read(path, id) {
    return this.readObject((await this.findVersion(path, id)).sha)
  }

  async pin(path, id, pinned) {
    return this.locked(this.indexPath(path), async () => {
      const index = await this.readIndex(path)
      const version = index.versions.find((item) => item.id === id)
      if (!version) throw new Error('找不到这个历史版本，可能已过期被清理。')
      version.pinned = Boolean(pinned)
      await writeJsonAtomic(this.indexPath(path), index)
      return true
    })
  }

  async listDeleted() {
    const list = await readJson(this.deletedPath, { items: [] })
    return [...(list.items || [])].sort((a, b) => b.at - a.at).map(({ id, path, at, reason, size }) => ({ id, path, at, reason, size }))
  }

  async findDeleted(id) {
    const list = await readJson(this.deletedPath, { items: [] })
    const item = (list.items || []).find((entry) => entry.id === id)
    if (!item) throw new Error('找不到这条删除记录，可能已过期被清理。')
    return item
  }

  async readDeleted(id) {
    return this.readObject((await this.findDeleted(id)).sha)
  }

  async forgetDeleted(id) {
    return this.locked(this.deletedPath, async () => {
      const list = await readJson(this.deletedPath, { items: [] })
      list.items = (list.items || []).filter((entry) => entry.id !== id)
      await writeJsonAtomic(this.deletedPath, list)
    })
  }

  // In-app rename / move of a file or a folder: its history follows.
  async movePath(oldPath, newPath) {
    const from = pathKey(oldPath)
    const sep = from.includes('\\') ? '\\' : '/'
    const dir = join(this.root, 'index')
    let names = []
    try { names = await fs.readdir(dir) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const index = await readJson(join(dir, name), null)
      if (!index?.path) continue
      const key = pathKey(index.path)
      if (key !== from && !key.startsWith(from + sep)) continue
      const target = resolve(newPath) + index.path.slice(resolve(oldPath).length)
      await this.locked(this.indexPath(target), async () => {
        const existing = await this.readIndex(target)
        const merged = { path: target, versions: [...existing.versions, ...index.versions].sort((a, b) => a.at - b.at) }
        await writeJsonAtomic(this.indexPath(target), merged)
      })
      if (pathKey(target) !== key) await fs.rm(join(dir, name), { force: true })
    }
  }

  async usage() {
    let bytes = 0
    let versions = 0
    let files = 0
    const objects = join(this.root, 'objects')
    for (const sub of await fs.readdir(objects).catch(() => [])) {
      for (const name of await fs.readdir(join(objects, sub)).catch(() => [])) {
        bytes += (await fs.stat(join(objects, sub, name)).catch(() => ({ size: 0 }))).size
      }
    }
    for (const name of await fs.readdir(join(this.root, 'index')).catch(() => [])) {
      const index = await readJson(join(this.root, 'index', name), null)
      if (!index?.versions?.length) continue
      files += 1
      versions += index.versions.length
    }
    return { bytes, versions, files }
  }

  async clear() {
    await this.pruning?.catch(() => {})
    await fs.rm(this.root, { recursive: true, force: true })
  }

  configure({ retentionDays, capBytes } = {}) {
    if ([30, 90, 365].includes(retentionDays)) this.retentionDays = retentionDays
    if (Number.isFinite(capBytes) && capBytes > 0) this.capBytes = capBytes
  }

  afterRecord() {
    this.recordsSincePrune += 1
    if (this.recordsSincePrune >= 50) this.prune().catch(() => {})
  }

  // Thinning, retention, the size cap, and unreferenced content.
  prune() {
    if (this.pruning) return this.pruning
    this.recordsSincePrune = 0
    this.pruning = this.pruneNow().finally(() => { this.pruning = null })
    return this.pruning
  }

  async pruneNow() {
    const now = this.now()
    const options = { now, retentionDays: this.retentionDays }
    const dir = join(this.root, 'index')
    const indexes = []
    for (const name of await fs.readdir(dir).catch(() => [])) {
      if (!name.endsWith('.json')) continue
      const file = join(dir, name)
      const index = await this.locked(file, async () => {
        const current = await readJson(file, null)
        if (!current?.versions) return null
        const keep = versionsToKeep(current.versions, options)
        const versions = current.versions.filter((version) => keep.has(version.id))
        if (!versions.length) { await fs.rm(file, { force: true }); return null }
        if (versions.length !== current.versions.length) await writeJsonAtomic(file, { ...current, versions })
        return { file, path: current.path, versions }
      })
      if (index) indexes.push(index)
    }
    let deleted = await this.locked(this.deletedPath, async () => {
      const list = await readJson(this.deletedPath, { items: [] })
      const items = (list.items || []).filter((item) => now - item.at <= this.retentionDays * DAY)
      if (items.length !== (list.items || []).length) await writeJsonAtomic(this.deletedPath, { items })
      return items
    })

    // Size cap: drop the oldest unpinned versions / deletion records first.
    const sizeOf = new Map()
    const objectSize = async (sha) => {
      if (!sizeOf.has(sha)) sizeOf.set(sha, (await fs.stat(this.objectPath(sha)).catch(() => ({ size: 0 }))).size)
      return sizeOf.get(sha)
    }
    const referenced = () => new Set([...indexes.flatMap((index) => index.versions.map((v) => v.sha)), ...deleted.map((item) => item.sha)])
    let total = 0
    for (const sha of referenced()) total += await objectSize(sha)
    if (total > this.capBytes) {
      const candidates = [
        ...indexes.flatMap((index) => index.versions.filter((v) => !v.pinned).map((v) => ({ at: v.at, sha: v.sha, drop: () => { index.versions = index.versions.filter((x) => x !== v); index.dirty = true } }))),
        ...deleted.map((item) => ({ at: item.at, sha: item.sha, drop: () => { deleted = deleted.filter((x) => x !== item); deleted.dirty = true } }))
      ].sort((a, b) => a.at - b.at)
      for (const candidate of candidates) {
        if (total <= this.capBytes) break
        candidate.drop()
        if (!referenced().has(candidate.sha)) total -= await objectSize(candidate.sha)
      }
      for (const index of indexes.filter((item) => item.dirty)) {
        await this.locked(index.file, async () => {
          const current = await readJson(index.file, null)
          if (!current) return
          const keepIds = new Set(index.versions.map((v) => v.id))
          // Versions recorded meanwhile stay.
          const versions = current.versions.filter((v) => keepIds.has(v.id) || v.at >= now)
          if (versions.length) await writeJsonAtomic(index.file, { ...current, versions })
          else await fs.rm(index.file, { force: true })
        })
      }
      if (deleted.dirty) {
        const keepIds = new Set(deleted.map((item) => item.id))
        await this.locked(this.deletedPath, async () => {
          const list = await readJson(this.deletedPath, { items: [] })
          await writeJsonAtomic(this.deletedPath, { items: (list.items || []).filter((item) => keepIds.has(item.id) || item.at >= now) })
        })
      }
    }

    // Content nothing refers to any more (re-read: records may have landed).
    const live = new Set()
    for (const name of await fs.readdir(dir).catch(() => [])) {
      const index = await readJson(join(dir, name), null)
      for (const version of index?.versions || []) live.add(version.sha)
    }
    for (const item of (await readJson(this.deletedPath, { items: [] })).items || []) live.add(item.sha)
    const objects = join(this.root, 'objects')
    for (const sub of await fs.readdir(objects).catch(() => [])) {
      for (const name of await fs.readdir(join(objects, sub)).catch(() => [])) {
        if (!name.endsWith('.gz')) continue
        const sha = name.slice(0, -3)
        // Written in the last minute: may belong to a record in flight.
        const stat = await fs.stat(join(objects, sub, name)).catch(() => null)
        if (!live.has(sha) && stat && Date.now() - stat.mtimeMs > 60000) await fs.rm(join(objects, sub, name), { force: true })
      }
    }
  }
}
