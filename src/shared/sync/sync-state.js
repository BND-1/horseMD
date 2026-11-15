// Per-workspace sync state (what was last committed), kept in the platform's
// private store: sync/state/<workspaceId>.json.
// `store` contract: see docs/mobile-cloud-sync-architecture.md §6.

const STATE_VERSION = 1

export const syncStateName = (workspaceId) => `sync/state/${workspaceId}.json`

export async function readSyncState(store, workspaceId) {
  const empty = () => ({ version: STATE_VERSION, workspaceId, files: {}, dirs: [] })
  const text = await store.readText(syncStateName(workspaceId))
  if (text == null) return empty()
  // A file that is not JSON throws (as before): never sync from a broken state.
  const raw = JSON.parse(text)
  if (raw?.version !== STATE_VERSION || raw.workspaceId !== workspaceId || !raw.files) return empty()
  return { version: STATE_VERSION, workspaceId, files: raw.files, dirs: Array.isArray(raw.dirs) ? raw.dirs : [] }
}

export async function writeSyncState(store, state) {
  await store.writeText(syncStateName(state.workspaceId), JSON.stringify({ ...state, version: STATE_VERSION }, null, 2) + '\n', { private: true })
}
