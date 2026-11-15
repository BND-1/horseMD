// Cloud sync on phones: the shared SyncService (src/shared/sync/) on the
// phone's adapters (./platform.js), the native HTTP client and the secure
// store (../native-sync.js). capacitor-api.js loads this module lazily and
// exposes the same window.api.sync* functions as the desktop preload; the
// handlers below mirror src/main/sync-service.js / sync-workspaces.js.
//
// Phase 1 (docs/mobile-cloud-sync-architecture.md): only the app library
// ("HorseMD") syncs; no local version history (deletions / overwrites go to
// <library>/.horsemd/trash); sync runs only while the app is in the
// foreground — a run in progress pauses when the app goes to the background
// and continues when it comes back.
import { App as CapApp } from '@capacitor/app'
import { SyncService } from '../../../../shared/sync/sync-service.js'
import { adoptSyncWorkspace, listSyncWorkspaces, unregisterSyncWorkspace } from '../../../../shared/sync/sync-workspaces.js'
import { HorseSecureStore, nativeRequest } from '../native-sync.js'
import { createMobilePlatform } from './platform.js'

const CREDENTIAL_PREFIX = 'sync.cred.'

// Secrets (WebDAV password, S3 secret key and access key id) only in the
// Keychain / Keystore-backed store.
export const secureCredentials = {
  async get(id) {
    if (!id) return null
    const { value } = await HorseSecureStore.get({ key: CREDENTIAL_PREFIX + id })
    if (value == null || value === '') return null
    try { return JSON.parse(value) } catch { return null }
  },
  async set(id, object) {
    await HorseSecureStore.set({ key: CREDENTIAL_PREFIX + id, value: JSON.stringify(object ?? null) })
  },
  async remove(id) {
    if (!id) return
    await HorseSecureStore.remove({ key: CREDENTIAL_PREFIX + id })
  }
}

// `onLocalChange()`: a run may have written / removed files in the library —
// capacitor-api.js reloads open tabs (onFileChanged) and the file tree.
export async function createMobileSync({ directory, root, onLocalChange = null, phaseOneError = null }) {
  const platform = await createMobilePlatform({ directory, root })
  const service = new SyncService({
    platform,
    credentials: secureCredentials,
    http: { request: nativeRequest },
    history: null,
    secretAccessKeyId: true
  })

  const progressListeners = new Set()
  const send = (payload) => {
    for (const listener of [...progressListeners]) {
      try { listener(payload) } catch { /* a listener's own error */ }
    }
  }

  // Phase 1: the library is the only folder that can sync.
  const assertLibrary = (rootPath) => {
    if (String(rootPath || '').replace(/\/+$/, '') !== root) throw phaseOneError?.() || new Error('Only the HorseMD folder can sync on a phone.')
  }

  // Background: hold the running sync between files (iOS suspends the
  // WebView a few seconds later; Android keeps timers going for a while).
  const pausedInBackground = new Set()
  CapApp.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) {
      for (const rootPath of service.status().running) {
        if (service.control(rootPath, 'pause')) pausedInBackground.add(rootPath)
      }
      return
    }
    for (const rootPath of pausedInBackground) service.control(rootPath, 'resume')
    pausedInBackground.clear()
  }).catch(() => {})

  const api = {
    syncListWorkspaces: () => listSyncWorkspaces(platform),
    syncAdoptWorkspace: (rootPath) => {
      assertLibrary(rootPath)
      return adoptSyncWorkspace(platform, root)
    },
    syncRemoveWorkspace: (rootPath) => unregisterSyncWorkspace(platform, rootPath),
    syncListConnections: () => service.listConnections(),
    syncAddWebDavConnection: (config) => service.addWebDavConnection(config || {}),
    syncAddS3Connection: (config) => service.addS3Connection(config || {}),
    syncUpdateConnection: (connectionId, config) => service.updateConnection(connectionId, config || {}),
    syncRemoveConnection: (connectionId) => service.removeConnection(connectionId),
    syncTestConnection: (connectionId) => service.testConnection(connectionId),
    syncBindWorkspaceConnection: (rootPath, connectionId) => service.bindWorkspace(rootPath, connectionId),
    syncPreview: (rootPath, strategy) => service.preview(rootPath, strategy),
    async syncRun(rootPath, strategy, options) {
      const report = (progress) => send({ rootPath, ...progress })
      // Automatic sync (hooks/useAutoSync.js) is merge only, like main.
      const automatic = options?.automatic === true || options?.safeOnly === true
      const busyPaths = Array.isArray(options?.dirtyPaths) ? options.dirtyPaths.filter((path) => typeof path === 'string') : []
      let result = null
      try {
        result = await service.run(rootPath, automatic ? 'merge' : strategy, report, { automatic, busyPaths })
        return result
      } finally {
        report({ done: true })
        // Downloads, deletions and merges changed files on disk: open tabs
        // and the file tree follow (nothing to do for an idle run or a brake).
        if (!result?.idle && !result?.needsConfirmation) {
          try { onLocalChange?.(rootPath) } catch { /* best effort */ }
        }
      }
    },
    onSyncProgress: (callback) => {
      progressListeners.add(callback)
      return () => progressListeners.delete(callback)
    },
    syncControl: (rootPath, action) => {
      // A user's own pause / resume wins over the background hold.
      if (action === 'resume' || action === 'stop') pausedInBackground.delete(rootPath)
      return service.control(rootPath, action)
    },
    syncStatus: () => service.status(),
    syncListRemoteWorkspaces: (connectionId) => service.listRemoteWorkspaces(connectionId),
    syncJoinWorkspace: (rootPath, connectionId, workspaceId) => service.joinWorkspace(rootPath, connectionId, workspaceId)
  }

  return { api, service, platform, progressListeners }
}
