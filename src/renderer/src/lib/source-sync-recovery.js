export const sourceSyncRecoveryName = (title) => {
  const stem = String(title || 'HorseMD').replace(/\.(?:md|markdown|mdx)$/i, '')
  return `${stem}.horsemd-recovered.md`
}

// A persistent source-mapping ambiguity must never overwrite the original
// path. The caller supplies only the native save dialog and writer, making the
// separate-file boundary explicit and independently testable.
export async function saveSourceSyncRecovery({ api, title, markdown }) {
  if (!api?.saveAs || !api?.writeFile || typeof markdown !== 'string') {
    return { ok: false, reason: 'unavailable' }
  }
  const path = await api.saveAs(sourceSyncRecoveryName(title))
  if (!path) return { ok: false, reason: 'cancelled' }
  await api.writeFile(path, markdown)
  return { ok: true, path }
}
