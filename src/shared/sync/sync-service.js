// The sync service (connections, sync folders, runs), shared by desktop and
// phones. The desktop builds it with Node adapters and keeps the IPC in
// src/main/sync-service.js; a phone builds it in the WebView with its own
// adapters (docs/mobile-cloud-sync-architecture.md §6).
import { ConnectionRegistry } from './connections.js'
import { createAccountClient, OFFICIAL_SERVER, OFFICIAL_SYNC_BUILD } from './official-account.js'
import { WebDavProvider } from './webdav-provider.js'
import { S3Provider } from './s3-provider.js'
import { SyncEngine } from './sync-engine.js'
import { SyncControl } from './sync-control.js'
import { bindSyncWorkspace, joinSyncWorkspace, markSyncWorkspaceEncrypted, readWorkspaceRegistry } from './sync-workspaces.js'
import { EncryptedProvider, readKeyFile, writeKeyFile } from './encrypted-provider.js'
import { KEY_FILE, createKeyFile, parseKeyFile, unlockKeyFile, workspaceCipher, wrapMasterKey } from './sync-crypto.js'
import { base64ToBytes, bytesToBase64 } from './bytes.js'
import { RequestPacer } from './request-pacer.js'
import { createSyncRequest } from './sync-request.js'
import { createFetchFromHttp } from './http.js'

// UI tests shorten the throttling waits (minutes in production) to seconds.
const testPacerOptions = (env) => {
  try { return JSON.parse(env?.HORSEMD_TEST_SYNC_PACER || 'null') } catch { return null }
}
const newPacer = (env) => {
  const options = testPacerOptions(env)
  return options ? new RequestPacer(options) : new RequestPacer()
}

// Paths of files open with unsaved edits → paths relative to the sync root
// (others dropped). `paths.relativeInside` is the platform's rule (desktop:
// absolute paths only, node:path).
export function busyRelativePaths(paths, rootPath, absolutePaths) {
  const out = []
  for (const path of Array.isArray(absolutePaths) ? absolutePaths.slice(0, 1000) : []) {
    const rel = paths.relativeInside(rootPath, path)
    if (rel) out.push(rel)
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const compactRemotePrefix = (workspaceId) => `HorseMD/${workspaceId}`
const legacyRemotePrefix = (workspaceId) => `HorseMD/v1/workspaces/${workspaceId}`
const manifestPath = '.horsemd/manifest.json'
// The unlocked key of an encrypted workspace, in the credential store.
const keyCredentialId = (workspaceId) => `e2ee:${workspaceId}`
const MIN_PASSWORD = 8

// An encrypted workspace this device cannot open now: the sync stops and
// Settings › 云同步 asks for the password (SyncUnlock). `reason`:
//   e2ee-locked       no key on this device (another device made the
//                     workspace encrypted, or the key store was cleared)
//   e2ee-key-changed  another device replaced the key: the password unlocks the new one
//   e2ee-key-missing  the cloud lost the key file (emptied?): a password
//                     writes it again with this device's key
export class SyncLockedError extends Error {
  constructor(reason) {
    super(reason === 'e2ee-key-changed'
      ? '这个工作区的加密密钥已在别的设备上更换，请重新输入加密密码。'
      : reason === 'e2ee-key-missing'
        ? '云端找不到这个工作区的加密信息，请重新设置加密密码。'
        : '这个工作区已加密，请输入加密密码。')
    this.code = 'E2EE_LOCKED'
    this.reason = reason
  }
}

const emptySummary = () => ({ upload: 0, download: 0, delete: 0, conflict: 0, unchanged: 0, uploadBytes: 0, downloadBytes: 0 })

function checkNewPassword(password) {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) throw new Error(`加密密码至少要 ${MIN_PASSWORD} 个字符。`)
}

export class SyncService {
  // `platform`: §6 adapters. `credentials`: get / set / remove of secret
  // objects. `request`: fetch-like (url, init) → Response, or `http`: the
  // platform's raw request adapter (wrapped here). `history`: optional local
  // version history. `connectionsStore`: where sync/connections.json lives
  // (default platform.store). `secretAccessKeyId`: keep the S3 Access Key ID
  // with the secrets (phones).
  constructor({ platform, credentials, request: rawRequest = null, http = null, traceLog = null, history = null, connectionsStore = null, secretAccessKeyId = false }) {
    this.platform = platform
    // Local version history: files the sync replaces or deletes go there.
    this.history = history
    // Timeout + optional trace for every provider request (#161). Tests may
    // shorten the timeout (HORSEMD_TEST_SYNC_REQUEST_TIMEOUT_MS).
    const testTimeout = Number(platform.env?.HORSEMD_TEST_SYNC_REQUEST_TIMEOUT_MS)
    const request = createSyncRequest(rawRequest || createFetchFromHttp(http), {
      log: traceLog,
      ...(Number.isFinite(testTimeout) && testTimeout > 0 ? { baseTimeoutMs: testTimeout } : {})
    })
    this.request = request
    this.credentials = credentials
    const providerOptions = { request, bytes: platform.bytes, uuid: platform.uuid }
    this.connections = new ConnectionRegistry({
      store: connectionsStore || platform.store,
      credentialStore: this.credentials,
      uuid: platform.uuid,
      secretAccessKeyId,
      createWebDavProvider: (config) => new WebDavProvider({ ...config, ...providerOptions, pacer: newPacer(platform.env) }),
      createS3Provider: (config) => new S3Provider({ ...config, ...providerOptions, pacer: newPacer(platform.env) }),
      // HorseMD 同步: account calls go through the same request (timeout,
      // trace without bodies). HORSEMD_SYNC_SERVER points tests at a local
      // account service.
      createAccountClient: (server) => createAccountClient({ request, server }),
      officialServer: platform.env?.HORSEMD_SYNC_SERVER || OFFICIAL_SERVER
    })
    this.running = new Set()
    this.runningPaths = new Map()
    // rootPath (lower-cased) -> SyncControl of the running sync.
    this.controls = new Map()
  }

  async addWebDavConnection(config) {
    return this.connections.addWebDav(config)
  }

  async addS3Connection(config) {
    return this.connections.addS3(config)
  }

  async listConnections() {
    return this.connections.list()
  }

  // HorseMD 同步: mail a code, then log in with it (→ a connection).
  async startOfficialLogin(config) {
    return this.connections.startOfficialLogin(config)
  }

  async addOfficialConnection(config) {
    let device = String(config?.device || '')
    if (!device) {
      try { device = String(await this.platform.deviceName?.() || '') } catch { /* label only */ }
    }
    return this.connections.addOfficial({ ...config, device })
  }

  async officialAccount(connectionId) {
    return this.connections.officialAccount(connectionId)
  }

  // Whether Settings offers HorseMD 同步 (see OFFICIAL_SYNC_BUILD).
  async officialSyncEnabled() {
    if (OFFICIAL_SYNC_BUILD || this.platform.env?.HORSEMD_SYNC_SERVER) return true
    return (await this.listConnections()).some((connection) => connection.type === 'horsemd')
  }

  async updateConnection(connectionId, config) {
    return this.connections.update(connectionId, config)
  }

  async removeConnection(connectionId) {
    const bound = (await readWorkspaceRegistry(this.platform))
      .find((workspace) => workspace.connectionId === connectionId)
    if (bound) throw new Error(`“${bound.rootPath}”仍在使用这个连接。请先停止管理该同步文件夹。`)
    return this.connections.remove(connectionId)
  }

  async testConnection(connectionId) {
    return this.connections.test(connectionId)
  }

  async entryFor(rootPath) {
    const entry = (await readWorkspaceRegistry(this.platform))
      .find((workspace) => workspace.rootPath.toLowerCase() === String(rootPath || '').replace(/[\\/]+$/, '').toLowerCase())
    if (!entry) throw new Error('请先将这个文件夹添加为 HorseMD 同步文件夹。')
    return entry
  }

  // The workspace's own folder in the cloud, unencrypted (the key file lives
  // there; encrypted workspaces always use the compact prefix).
  plainProvider(connectionId, workspaceId) {
    return this.connections.createProvider(connectionId, { prefix: compactRemotePrefix(workspaceId) })
  }

  async cachedKey(workspaceId) {
    const stored = await this.credentials.get(keyCredentialId(workspaceId)).catch(() => null)
    if (!stored?.master) return null
    try {
      const master = base64ToBytes(stored.master)
      return master.byteLength === 32 ? master : null
    } catch { return null }
  }

  async storeKey(workspaceId, master) {
    await this.credentials.set(keyCredentialId(workspaceId), { master: bytesToBase64(master) })
  }

  // Stop syncing a folder: its key leaves this device too.
  async forgetWorkspaceKey(rootPath) {
    const entry = (await readWorkspaceRegistry(this.platform))
      .find((workspace) => workspace.rootPath.toLowerCase() === String(rootPath || '').replace(/[\\/]+$/, '').toLowerCase())
    if (entry) await this.credentials.remove(keyCredentialId(entry.workspaceId)).catch(() => {})
    return true
  }

  // A new encrypted workspace, or this password unlocks the one already in
  // the cloud under this id. Never turns an unencrypted cloud copy into an
  // encrypted one (its files would stay readable next to the encrypted ones).
  async setupEncryption(connectionId, workspaceId, password) {
    const plain = await this.plainProvider(connectionId, workspaceId)
    const existing = await readKeyFile(plain, this.platform.bytes)
    if (existing) {
      const master = await unlockKeyFile(existing, password)
      await this.storeKey(workspaceId, master)
      return master
    }
    checkNewPassword(password)
    const legacy = await this.connections.createProvider(connectionId, { prefix: legacyRemotePrefix(workspaceId) })
    if (await plain.get(manifestPath) || await legacy.get(manifestPath)) {
      throw new Error('这个文件夹以前已经不加密地同步过，不能直接改成加密。可以把文件放进一个新文件夹，再加密同步那个文件夹。')
    }
    const { keyFile, master } = await createKeyFile(password)
    try {
      await writeKeyFile(plain, keyFile, { createOnly: true, bytes: this.platform.bytes })
    } catch (error) {
      // Another device created it a moment ago: its password decides.
      const raced = await readKeyFile(plain, this.platform.bytes)
      if (!raced) throw error
      const theirs = await unlockKeyFile(raced, password)
      await this.storeKey(workspaceId, theirs)
      return theirs
    }
    await this.storeKey(workspaceId, master)
    return master
  }

  // `encryption`: { password } → the folder syncs end-to-end encrypted.
  async bindWorkspace(rootPath, connectionId, { encryption = null } = {}) {
    await this.connections.createProvider(connectionId)
    if (encryption) {
      const entry = await this.entryFor(rootPath)
      await this.setupEncryption(connectionId, entry.workspaceId, encryption.password)
    }
    return bindSyncWorkspace(this.platform, rootPath, connectionId, { encrypted: Boolean(encryption) })
  }

  // The password for a locked folder (SyncLockedError): unlocks the cloud's
  // key file, or — when the cloud lost it — writes it again with this
  // device's key (a new key when this device has none).
  async unlockWorkspace(rootPath, password) {
    const entry = await this.entryFor(rootPath)
    if (!entry.connectionId) throw new Error('请先为这个文件夹选择云端连接。')
    const plain = await this.plainProvider(entry.connectionId, entry.workspaceId)
    const remote = await readKeyFile(plain, this.platform.bytes)
    let master
    if (remote) {
      master = await unlockKeyFile(remote, password)
    } else {
      checkNewPassword(password)
      const cached = await this.cachedKey(entry.workspaceId)
      const created = cached ? { keyFile: await wrapMasterKey(cached, password), master: cached } : await createKeyFile(password)
      await writeKeyFile(plain, created.keyFile, { createOnly: true, bytes: this.platform.bytes })
      master = created.master
    }
    await this.storeKey(entry.workspaceId, master)
    return markSyncWorkspaceEncrypted(this.platform, entry.rootPath)
  }

  // Same key, new password: only the key file changes (other devices keep
  // syncing without asking).
  async changeEncryptionPassword(rootPath, oldPassword, newPassword) {
    const entry = await this.entryFor(rootPath)
    if (!entry.encrypted || !entry.connectionId) throw new Error('这个文件夹没有加密同步。')
    checkNewPassword(newPassword)
    const plain = await this.plainProvider(entry.connectionId, entry.workspaceId)
    const remote = await plain.get(KEY_FILE)
    if (!remote) throw new SyncLockedError('e2ee-key-missing')
    const text = this.platform.bytes.toText(remote.bytes)
    const master = await unlockKeyFile(text, oldPassword)
    const keyFile = await wrapMasterKey(master, newPassword, { iterations: Number(parseKeyFile(text).kdf.iterations) })
    await writeKeyFile(plain, keyFile, { revision: remote.revision || null, bytes: this.platform.bytes })
    await this.storeKey(entry.workspaceId, master)
    return true
  }

  // The provider the engine uses for an encrypted workspace, after checking
  // that this device's key is the cloud's (SyncLockedError otherwise).
  async encryptedProviderFor(entry, plain, remoteKeyText) {
    const master = await this.cachedKey(entry.workspaceId)
    if (!remoteKeyText) throw new SyncLockedError(master ? 'e2ee-key-missing' : 'e2ee-locked')
    if (!master) throw new SyncLockedError('e2ee-locked')
    const cipher = await workspaceCipher(master)
    if (parseKeyFile(remoteKeyText).check !== await cipher.keyCheck()) throw new SyncLockedError('e2ee-key-changed')
    if (!entry.encrypted) await markSyncWorkspaceEncrypted(this.platform, entry.rootPath)
    const provider = new EncryptedProvider({ inner: plain, cipher, bytes: this.platform.bytes })
    // Just checked; the provider would read the key file again otherwise.
    provider.verified = Promise.resolve()
    return provider
  }

  async listRemoteWorkspaces(connectionId) {
    const provider = await this.connections.createProvider(connectionId)
    const workspaces = new Map()
    for (const root of ['HorseMD', 'HorseMD/v1/workspaces']) {
      const rows = await provider.list(root)
      const ids = rows.filter((row) => row.isDirectory).map((row) => row.href.split('/').filter(Boolean).pop()).filter(Boolean)
      for (const workspaceId of ids) {
        if (workspaces.has(workspaceId)) continue
        const manifest = await provider.get(`${root}/${workspaceId}/${manifestPath}`)
        if (!manifest) {
          // Encrypted: the manifest has an opaque name; the key file says so.
          const keyFile = root === 'HorseMD' ? await provider.get(`${root}/${workspaceId}/${KEY_FILE}`) : null
          if (!keyFile) continue
          try {
            parseKeyFile(this.platform.bytes.toText(keyFile.bytes))
            workspaces.set(workspaceId, { workspaceId, encrypted: true, fileCount: null })
          } catch { /* not ours */ }
          continue
        }
        try {
          const parsed = JSON.parse(this.platform.bytes.toText(manifest.bytes))
          if (parsed.workspaceId === workspaceId) workspaces.set(workspaceId, { workspaceId, fileCount: Object.keys(parsed.files || {}).length })
        } catch { /* ignore malformed non-HorseMD directories */ }
      }
    }
    return [...workspaces.values()]
  }

  // `password`: required for an encrypted cloud workspace; checked before
  // the folder changes anything.
  async joinWorkspace(rootPath, connectionId, workspaceId, { password = '' } = {}) {
    await this.connections.createProvider(connectionId)
    const candidates = await this.listRemoteWorkspaces(connectionId)
    const candidate = candidates.find((item) => item.workspaceId === workspaceId)
    if (!candidate) throw new Error('远端工作区不存在。')
    if (candidate.encrypted) {
      if (!password) throw new Error('请输入加密密码。')
      const plain = await this.plainProvider(connectionId, workspaceId)
      const master = await unlockKeyFile(await readKeyFile(plain, this.platform.bytes), password)
      await this.storeKey(workspaceId, master)
    }
    const entry = await joinSyncWorkspace(this.platform, rootPath, workspaceId)
    return bindSyncWorkspace(this.platform, entry.rootPath, connectionId, { encrypted: candidate.encrypted === true })
  }

  async engineFor(rootPath, onProgress = null, control = null, { busyPaths = [] } = {}) {
    const entry = (await readWorkspaceRegistry(this.platform))
      .find((workspace) => workspace.rootPath.toLowerCase() === rootPath.replace(/[\\/]+$/, '').toLowerCase())
    if (!entry?.connectionId) throw new Error('请先为这个文件夹选择云端连接。')
    const prefixes = [compactRemotePrefix(entry.workspaceId), legacyRemotePrefix(entry.workspaceId)]
    let provider = null
    const compactProvider = await this.connections.createProvider(entry.connectionId, { prefix: prefixes[0] })
    // Encrypted (here, or by another device under this id): never written
    // in plain text, never with a key the cloud does not hold.
    const remoteKey = await readKeyFile(compactProvider, this.platform.bytes)
    if (entry.encrypted || remoteKey) {
      provider = await this.encryptedProviderFor(entry, compactProvider, remoteKey)
    } else {
      for (const prefix of prefixes) {
        const candidate = prefix === prefixes[0] ? compactProvider : await this.connections.createProvider(entry.connectionId, { prefix })
        if (await candidate.get(manifestPath)) {
          provider = candidate
          break
        }
      }
      provider ||= compactProvider
    }
    const pacer = (provider.inner || provider).pacer
    if (onProgress && pacer) pacer.onThrottle = (event) => onProgress({ throttle: event })
    // Throttling waits end at once on stop and hold while paused.
    if (control && pacer) pacer.sleep = (ms) => control.sleep(ms)
    return new SyncEngine({
      platform: this.platform,
      rootPath: entry.rootPath,
      workspaceId: entry.workspaceId,
      provider,
      deviceName: this.platform.deviceName(),
      onProgress,
      control,
      busyPaths: busyRelativePaths(this.platform.paths, entry.rootPath, busyPaths),
      history: this.history
    })
  }

  // A locked encrypted folder previews as { status: 'e2ee-…' } (no plan).
  async preview(rootPath, strategy = 'merge') {
    try {
      return await (await this.engineFor(rootPath)).preview(strategy)
    } catch (error) {
      if (!(error instanceof SyncLockedError)) throw error
      return { status: error.reason, strategy, message: error.message, plan: null, summary: emptySummary(), operations: [] }
    }
  }

  // `busyPaths`: absolute paths of files open with unsaved edits (never
  // overwritten by this run). A run whose manifest commit loses to another
  // device re-plans and runs again (up to 3 times) instead of failing.
  async run(rootPath, strategy = 'merge', onProgress = null, { automatic = false, safeOnly = false, busyPaths = [] } = {}) {
    automatic = automatic || safeOnly
    const key = rootPath.toLowerCase()
    if (this.running.has(key)) throw new Error('这个文件夹正在同步。')
    this.running.add(key)
    this.runningPaths.set(key, rootPath)
    const control = new SyncControl({ onChange: (state) => onProgress?.({ control: state }) })
    this.controls.set(key, control)
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await (await this.engineFor(rootPath, onProgress, control, { busyPaths })).execute(null, strategy, { automatic })
        } catch (error) {
          // Like a brake: nothing ran, Settings asks for the password.
          if (error instanceof SyncLockedError) return { needsConfirmation: true, reason: error.reason, message: error.message, summary: emptySummary() }
          if (!error?.manifestChanged || attempt >= 3) throw error
          await sleep(400 * attempt)
        }
      }
    } finally {
      this.running.delete(key)
      this.runningPaths.delete(key)
      this.controls.delete(key)
    }
  }

  // Folders with a sync in progress (a reopened window asks, #161).
  status() {
    return { running: [...this.runningPaths.values()] }
  }

  // Pause / resume / stop the running sync of a folder (false when none runs).
  control(rootPath, action) {
    const control = this.controls.get(String(rootPath || '').toLowerCase())
    if (!control || !['pause', 'resume', 'stop'].includes(action)) return false
    return control[action]()
  }
}
