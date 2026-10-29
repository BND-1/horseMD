import fs from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { gzip as gzipCb, gunzip as gunzipCb } from 'node:zlib'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'

const gzip = promisify(gzipCb)
const gunzip = promisify(gunzipCb)

// The content of each text file as of the last sync — the common ancestor a
// three-way merge needs when both devices edited it (Joplin keeps the last
// uploaded body, Logseq `version-files/base`). The sync state records only
// hashes, so without this every both-sides edit became a conflict copy.
// userData/sync/base/<workspace>/<sha256>.gz, one file per content; only the
// contents the sync state still refers to are kept (prune after a commit).

export const MERGEABLE = /\.(md|markdown|mdx|txt)$/i
export const MAX_MERGE_BYTES = 1024 * 1024
export const isMergeable = (path, size) => MERGEABLE.test(path) && size <= MAX_MERGE_BYTES

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export class SyncBaseStore {
  constructor(userDataPath, workspaceId) {
    this.dir = join(userDataPath, 'sync', 'base', workspaceId)
  }

  path(sha) { return join(this.dir, `${sha}.gz`) }

  async has(sha) {
    try { await fs.access(this.path(sha)); return true } catch { return false }
  }

  async put(bytes) {
    const sha = sha256(bytes)
    if (await this.has(sha)) return sha
    await fs.mkdir(this.dir, { recursive: true })
    const temp = `${this.path(sha)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await fs.writeFile(temp, await gzip(bytes))
    await fs.rename(temp, this.path(sha))
    return sha
  }

  // The bytes for `sha`, or null (never stored, or not readable).
  async get(sha) {
    if (!sha) return null
    try {
      const bytes = await gunzip(await fs.readFile(this.path(sha)))
      return sha256(bytes) === sha ? bytes : null
    } catch {
      return null
    }
  }

  // Keep only the contents in `keep` (a Set of sha256).
  async prune(keep) {
    let names = []
    try { names = await fs.readdir(this.dir) } catch { return }
    for (const name of names) {
      if (!name.endsWith('.gz')) continue
      if (!keep.has(name.slice(0, -3))) await fs.rm(join(this.dir, name), { force: true }).catch(() => {})
    }
  }

  async clear() {
    await fs.rm(dirname(this.path('x')), { recursive: true, force: true })
  }
}
