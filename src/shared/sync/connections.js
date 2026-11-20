// Saved cloud connections (WebDAV / S3), shared by desktop and phones.
// Non-secret fields live in the platform's private store
// (sync/connections.json); passwords and secret keys only in the credential
// store (`credentialStore`: get(id) / set(id, object) / remove(id) — the
// desktop's safeStorage blob file, the phone's Keychain / Keystore).
// `secretAccessKeyId`: also keep the S3 Access Key ID in the credential store
// instead of the connections file (phones; the desktop keeps it in the file).

import { OfficialSession, OFFICIAL_PROVIDER_ID, OfficialAccountError, formatBytes, isLoopbackUrl, normalizeServer } from './official-account.js'

const VERSION = 1
const FILE = 'sync/connections.json'
const defaultUuid = () => globalThis.crypto.randomUUID()

function normalizeUserAgent(value) {
  const userAgent = String(value || '').trim()
  if (/[\r\n]/.test(userAgent)) throw new Error('User-Agent 不能包含换行。')
  if (userAgent.length > 256) throw new Error('User-Agent 不能超过 256 个字符。')
  return userAgent
}

// Not persisted: tells the form the uploads were throttled during the test.
const withCheck = (connection, check) => (check?.uploadThrottled ? { ...connection, uploadThrottled: true } : connection)

function publicConnection(entry) {
  const { credentialId, ...publicEntry } = entry
  return publicEntry
}

// `horsemd`: HorseMD 同步, our own service (official-account.js); the
// credential store holds only its rotating refresh token.
const SUPPORTED_TYPES = ['webdav', 's3', 'horsemd']

// Every stored entry, also of types this version does not know (a newer
// HorseMD may add e.g. GitHub): they are written back untouched, so using
// an older version never deletes them.
async function readAllConnections(store) {
  try {
    const text = await store.readText(FILE)
    if (text == null) return []
    const raw = JSON.parse(text)
    return Array.isArray(raw?.connections) ? raw.connections.filter((item) => item?.id) : []
  } catch (error) {
    throw new Error(`无法读取云端连接：${error?.message || error}`)
  }
}

export async function readConnections(store) {
  return (await readAllConnections(store)).filter((item) => SUPPORTED_TYPES.includes(item.type))
}

// The service the connection was set up with in Settings (坚果云, 七牛…;
// sync-providers.js) — display only, the sync never reads it.
function normalizeProviderId(value) {
  const id = String(value || '').trim()
  return /^[a-z0-9-]{1,32}$/.test(id) ? id : ''
}

async function writeConnections(store, connections) {
  await store.writeText(FILE, JSON.stringify({ version: VERSION, connections }, null, 2) + '\n', { private: true })
}

export class ConnectionRegistry {
  // `createAccountClient(server)`: HorseMD 同步's account client;
  // `officialServer`: its default address (tests point it at a local one).
  constructor({ store, credentialStore, createWebDavProvider, createS3Provider, createAccountClient = null, officialServer = '', uuid = defaultUuid, secretAccessKeyId = false }) {
    this.store = store
    this.credentialStore = credentialStore
    this.createWebDavProvider = createWebDavProvider
    this.createS3Provider = createS3Provider
    this.createAccountClient = createAccountClient
    this.officialServer = officialServer
    this.uuid = uuid
    this.secretAccessKeyId = secretAccessKeyId
    // connection id → OfficialSession (one per connection, so renewals of
    // its rotating refresh token never overlap).
    this.officialSessions = new Map()
  }

  accountClient(server) {
    if (!this.createAccountClient) throw new Error('当前平台暂不支持 HorseMD 同步。')
    return this.createAccountClient(normalizeServer(server || this.officialServer))
  }

  officialSession(connection) {
    let session = this.officialSessions.get(connection.id)
    if (!session) {
      const credentialId = connection.credentialId
      session = new OfficialSession({
        client: this.accountClient(connection.server),
        loadRefreshToken: async () => (await this.credentialStore.get(credentialId))?.refreshToken || '',
        saveRefreshToken: (refreshToken) => this.credentialStore.set(credentialId, { refreshToken })
      })
      this.officialSessions.set(connection.id, session)
    }
    return session
  }

  // HorseMD 同步, step 1: mail a login code.
  async startOfficialLogin({ email, server = '' }) {
    return this.accountClient(server).startLogin(String(email || '').trim())
  }

  // Step 2: the code → a connection. Logging in again to the same account
  // renews the saved connection instead of adding a second one.
  async addOfficial({ email, code, device = '', server = '' }) {
    const client = this.accountClient(server)
    const result = await client.verify(String(email || '').trim(), String(code || '').trim(), String(device || '').slice(0, 120))
    const connections = await readAllConnections(this.store)
    const existing = connections.find((item) => item.type === 'horsemd' && item.userId === result.user.id && item.server === client.server)
    const id = existing?.id || this.uuid()
    const credentialId = existing?.credentialId || `horsemd:${id}`
    // The old session (if any) may hold a refresh token that is now stale.
    const old = existing && this.officialSessions.get(id)
    if (old) await old.logout().catch(() => {})
    this.officialSessions.delete(id)
    await this.credentialStore.set(credentialId, { refreshToken: result.refreshToken })
    const connection = {
      ...(existing || {}),
      id,
      type: 'horsemd',
      provider: OFFICIAL_PROVIDER_ID,
      name: existing?.name || 'HorseMD 同步',
      server: client.server,
      email: result.user.email,
      userId: result.user.id,
      credentialId,
      ...(existing ? { updatedAt: new Date().toISOString() } : { createdAt: new Date().toISOString() })
    }
    if (existing) connections[connections.indexOf(existing)] = connection
    else connections.push(connection)
    await writeConnections(this.store, connections)
    const session = this.officialSession(connection)
    session.access = { token: result.accessToken, expiresAt: Date.parse(result.accessExpiresAt) || Date.now() + 50 * 60 * 1000 }
    return publicConnection(connection)
  }

  async officialAccount(id) {
    const connection = (await readConnections(this.store)).find((item) => item.id === id && item.type === 'horsemd')
    if (!connection) throw new Error('找不到 HorseMD 同步连接。')
    return this.officialSession(connection).me()
  }

  // The S3 Access Key ID of a saved connection: from the file, or (phones)
  // from its credential.
  async withAccessKeyId(connection, credential) {
    if (!this.secretAccessKeyId || connection.type !== 's3') return connection
    const stored = credential === undefined ? await this.credentialStore.get(connection.credentialId).catch(() => null) : credential
    return { ...connection, accessKeyId: stored?.accessKeyId || connection.accessKeyId || '' }
  }

  // What the connections file keeps of an S3 entry.
  storedS3(entry) {
    return this.secretAccessKeyId ? { ...entry, accessKeyId: '' } : entry
  }

  async list() {
    const connections = await readConnections(this.store)
    if (!this.secretAccessKeyId) return connections.map(publicConnection)
    const out = []
    for (const connection of connections) out.push(publicConnection(await this.withAccessKeyId(connection)))
    return out
  }

  async addWebDav({ name, endpoint, username, password, allowInsecure = false, userAgent = '', provider: providerId = '' }) {
    const trimmedName = String(name || '').trim()
    if (!trimmedName) throw new Error('请填写连接名称。')
    if (!String(endpoint || '').trim()) throw new Error('请填写 WebDAV 地址。')
    // A password is optional: a NAS / test server may allow anonymous WebDAV
    // (rclone, Remotely Save); the provider sends Basic auth only when a
    // username or password is given.
    const normalizedUserAgent = normalizeUserAgent(userAgent)
    const provider = this.createWebDavProvider({ endpoint, username, password, allowInsecure, userAgent: normalizedUserAgent })
    const check = await provider.testConnection()
    const id = this.uuid()
    const credentialId = `webdav:${id}`
    await this.credentialStore.set(credentialId, { password: String(password) })
    const connections = await readAllConnections(this.store)
    const connection = {
      id,
      type: 'webdav',
      provider: normalizeProviderId(providerId),
      name: trimmedName,
      endpoint: String(endpoint).trim(),
      username: String(username || ''),
      userAgent: normalizedUserAgent,
      allowInsecure: Boolean(allowInsecure),
      credentialId,
      createdAt: new Date().toISOString()
    }
    connections.push(connection)
    await writeConnections(this.store, connections)
    return withCheck(publicConnection(connection), check)
  }

  async addS3({ name, endpoint, bucket, region, accessKeyId, secretAccessKey, allowInsecure = false, userAgent = '', provider: providerId = '' }) {
    const trimmedName = String(name || '').trim()
    if (!trimmedName) throw new Error('请填写连接名称。')
    if (!String(endpoint || '').trim()) throw new Error('请填写 S3 Endpoint。')
    if (!String(bucket || '').trim()) throw new Error('请填写 Bucket 名称。')
    if (!String(region || '').trim()) throw new Error('请填写 Region。')
    if (!String(accessKeyId || '').trim() || !String(secretAccessKey || '')) {
      throw new Error('请填写 S3 Access Key 和 Secret Key。')
    }
    const normalizedUserAgent = normalizeUserAgent(userAgent)
    const provider = this.createS3Provider({ endpoint, bucket, region, accessKeyId, secretAccessKey, allowInsecure, userAgent: normalizedUserAgent })
    const check = await provider.testConnection()
    const id = this.uuid()
    const credentialId = `s3:${id}`
    await this.credentialStore.set(credentialId, this.secretAccessKeyId
      ? { secretAccessKey: String(secretAccessKey), accessKeyId: String(accessKeyId).trim() }
      : { secretAccessKey: String(secretAccessKey) })
    const connections = await readAllConnections(this.store)
    const connection = {
      id,
      type: 's3',
      provider: normalizeProviderId(providerId),
      name: trimmedName,
      endpoint: String(endpoint).trim(),
      bucket: String(bucket).trim(),
      region: String(region).trim(),
      accessKeyId: String(accessKeyId).trim(),
      userAgent: normalizedUserAgent,
      allowInsecure: Boolean(allowInsecure),
      credentialId,
      createdAt: new Date().toISOString()
    }
    connections.push(this.storedS3(connection))
    await writeConnections(this.store, connections)
    return withCheck(publicConnection(connection), check)
  }

  async update(id, config) {
    const connections = await readAllConnections(this.store)
    const index = connections.findIndex((connection) => connection.id === id && SUPPORTED_TYPES.includes(connection.type))
    if (index < 0) throw new Error('找不到云端连接。')
    const current = connections[index]
    // Absent = keep the saved service; '' = the full form (no service).
    const provider = config.provider === undefined ? (current.provider || '') : normalizeProviderId(config.provider)
    const credential = await this.credentialStore.get(current.credentialId)

    if (current.type === 'horsemd') {
      const name = String(config.name || '').trim()
      if (!name) throw new Error('请填写连接名称。')
      const next = { ...current, name, updatedAt: new Date().toISOString() }
      connections[index] = next
      await writeConnections(this.store, connections)
      return publicConnection(next)
    }

    if (current.type === 'webdav') {
      const name = String(config.name || '').trim()
      const endpoint = String(config.endpoint || '').trim()
      const username = String(config.username || '')
      const password = String(config.password || '') || credential?.password
      if (!name) throw new Error('请填写连接名称。')
      if (!endpoint) throw new Error('请填写 WebDAV 地址。')
      const allowInsecure = Boolean(config.allowInsecure)
      const userAgent = normalizeUserAgent(config.userAgent ?? current.userAgent)
      const check = await this.createWebDavProvider({ endpoint, username, password, allowInsecure, userAgent }).testConnection()
      const next = { ...current, provider, name, endpoint, username, userAgent, allowInsecure, updatedAt: new Date().toISOString() }
      if (password !== credential?.password) await this.credentialStore.set(current.credentialId, { password })
      connections[index] = next
      await writeConnections(this.store, connections)
      return withCheck(publicConnection(next), check)
    }

    if (current.type === 's3') {
      const name = String(config.name || '').trim()
      const endpoint = String(config.endpoint || '').trim()
      const bucket = String(config.bucket || '').trim()
      const region = String(config.region || '').trim()
      const accessKeyId = String(config.accessKeyId || '').trim()
      const secretAccessKey = String(config.secretAccessKey || '') || credential?.secretAccessKey
      if (!name) throw new Error('请填写连接名称。')
      if (!endpoint) throw new Error('请填写 S3 Endpoint。')
      if (!bucket) throw new Error('请填写 Bucket 名称。')
      if (!region) throw new Error('请填写 Region。')
      if (!accessKeyId || !secretAccessKey) throw new Error('请填写 S3 Access Key 和 Secret Key。')
      const allowInsecure = Boolean(config.allowInsecure)
      const userAgent = normalizeUserAgent(config.userAgent ?? current.userAgent)
      const check = await this.createS3Provider({ endpoint, bucket, region, accessKeyId, secretAccessKey, allowInsecure, userAgent }).testConnection()
      const next = { ...current, provider, name, endpoint, bucket, region, accessKeyId, userAgent, allowInsecure, updatedAt: new Date().toISOString() }
      if (this.secretAccessKeyId) {
        if (secretAccessKey !== credential?.secretAccessKey || accessKeyId !== credential?.accessKeyId) {
          await this.credentialStore.set(current.credentialId, { secretAccessKey, accessKeyId })
        }
        connections[index] = this.storedS3(next)
      } else {
        if (secretAccessKey !== credential?.secretAccessKey) await this.credentialStore.set(current.credentialId, { secretAccessKey })
        connections[index] = next
      }
      await writeConnections(this.store, connections)
      return withCheck(publicConnection(next), check)
    }

    throw new Error('不支持的云端连接类型。')
  }

  async remove(id) {
    const connections = await readAllConnections(this.store)
    const current = connections.find((connection) => connection.id === id)
    if (!current) return false
    // Signing out ends the session on the service too (best effort: offline
    // removal still forgets it here).
    if (current.type === 'horsemd') {
      await this.officialSession(current).logout().catch(() => {})
      this.officialSessions.delete(id)
    }
    await writeConnections(this.store, connections.filter((connection) => connection.id !== id))
    await this.credentialStore.remove(current.credentialId)
    return true
  }

  async test(id) {
    const provider = await this.createProvider(id)
    return provider.testConnection()
  }

  async createProvider(id, options = {}) {
    const saved = (await readConnections(this.store)).find((item) => item.id === id)
    if (!saved) throw new Error('找不到云端连接。')
    const credential = await this.credentialStore.get(saved.credentialId)
    const connection = await this.withAccessKeyId(saved, credential)
    if (connection.type === 'webdav') {
      if (!credential) throw new Error('云端密码不可用，请重新连接。')
      return this.createWebDavProvider({ ...connection, ...options, password: credential.password || '' })
    }
    if (connection.type === 's3') {
      if (!credential?.secretAccessKey) throw new Error('S3 密钥不可用，请重新连接。')
      return this.createS3Provider({ ...connection, ...options, secretAccessKey: credential.secretAccessKey })
    }
    if (connection.type === 'horsemd') return this.createOfficialProvider(connection, options)
    throw new Error('不支持的云端连接类型。')
  }

  // HorseMD 同步 = S3 under users/<uid>/ with the service's temporary
  // credentials. A plan that ended or is over quota is read-only: uploads
  // stop here with a clear reason instead of the storage's 403.
  async createOfficialProvider(connection, options = {}) {
    const session = this.officialSession(connection)
    let grant
    try {
      grant = await session.storageGrant({ maxAgeMs: 15 * 1000 })
    } catch (error) {
      throw officialError(error)
    }
    return this.createS3Provider({
      endpoint: grant.endpoint,
      bucket: grant.bucket,
      region: grant.region,
      credentials: session.credentialProvider(),
      prefix: [grant.prefix, options.prefix].filter(Boolean).join('/'),
      allowInsecure: isLoopbackUrl(grant.endpoint),
      beforePut: async (bytes) => {
        const current = await session.storageGrant()
        if (!current.writable) throw new Error('HorseMD 同步的空间已满或订阅已结束，现在只能下载，不能上传。')
        const size = bytes?.byteLength ?? bytes?.length ?? 0
        if (current.fileBytes && size > current.fileBytes) {
          throw new Error(`有文件超过 HorseMD 同步的单文件上限（${formatBytes(current.fileBytes)}），没有上传。`)
        }
      }
    })
  }
}

// The service's own Chinese message, with the cases a person must act on
// spelled out.
function officialError(error) {
  if (!(error instanceof OfficialAccountError)) return error
  if (error.code === 'refresh-invalid') return new Error('HorseMD 同步已退出登录，请在 设置 › 云同步 里重新登录。')
  if (error.code === 'no-plan') return new Error('HorseMD 同步还没有订阅：在官网账号页开通后即可同步。')
  return error
}
