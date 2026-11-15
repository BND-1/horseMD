// The content of each text file as of the last sync — the common ancestor a
// three-way merge needs when both devices edited it (Joplin keeps the last
// uploaded body, Logseq `version-files/base`). The sync state records only
// hashes, so without this every both-sides edit became a conflict copy.
// <store>/sync/base/<workspace>/<sha256>.gz, one file per content; only the
// contents the sync state still refers to are kept (prune after a commit).
// `platform`: { store, hash: { sha256 }, gzip, gunzip } (§6 of
// docs/mobile-cloud-sync-architecture.md).

export const MERGEABLE = /\.(md|markdown|mdx|txt)$/i
export const MAX_MERGE_BYTES = 1024 * 1024
export const isMergeable = (path, size) => MERGEABLE.test(path) && size <= MAX_MERGE_BYTES

export class SyncBaseStore {
  constructor(platform, workspaceId) {
    this.store = platform.store
    this.hash = platform.hash
    this.gzip = platform.gzip
    this.gunzip = platform.gunzip
    this.dir = `sync/base/${workspaceId}`
  }

  name(sha) { return `${this.dir}/${sha}.gz` }

  async has(sha) {
    try { return await this.store.exists(this.name(sha)) } catch { return false }
  }

  async put(bytes) {
    const sha = await this.hash.sha256(bytes)
    if (await this.has(sha)) return sha
    await this.store.writeBytes(this.name(sha), await this.gzip(bytes))
    return sha
  }

  // The bytes for `sha`, or null (never stored, or not readable).
  async get(sha) {
    if (!sha) return null
    try {
      const stored = await this.store.readBytes(this.name(sha))
      if (!stored) return null
      const bytes = await this.gunzip(stored)
      return (await this.hash.sha256(bytes)) === sha ? bytes : null
    } catch {
      return null
    }
  }

  // Keep only the contents in `keep` (a Set of sha256).
  async prune(keep) {
    let names = []
    try { names = await this.store.list(this.dir) } catch { return }
    for (const name of names) {
      if (!name.endsWith('.gz')) continue
      if (!keep.has(name.slice(0, -3))) await this.store.remove(`${this.dir}/${name}`).catch(() => {})
    }
  }

  async clear() {
    await this.store.removeTree(this.dir)
  }
}
