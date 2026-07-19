import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const VERSION = 1
const filePath = (userDataPath) => join(userDataPath, 'sync', 'connections.json')

function publicConnection(entry) {
  const { credentialId, ...publicEntry } = entry
  return publicEntry
}

export async function readConnections(userDataPath) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath(userDataPath), 'utf8'))
    return Array.isArray(raw?.connections)
      ? raw.connections.filter((item) => item?.id && ['webdav', 's3'].includes(item.type))
      : []
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new Error(`无法读取云端连接：${error?.message || error}`)
  }
}

async function writeConnections(userDataPath, connections) {
  const path = filePath(userDataPath)
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temp, JSON.stringify({ version: VERSION, connections }, null, 2) + '\n', {
    encoding: 'utf8', mode: 0o600
  })
  await fs.rename(temp, path)
}

export class ConnectionRegistry {
  constructor({ userDataPath, credentialStore, createWebDavProvider, createS3Provider }) {
    this.userDataPath = userDataPath
    this.credentialStore = credentialStore
    this.createWebDavProvider = createWebDavProvider
    this.createS3Provider = createS3Provider
  }

  async list() {
    return (await readConnections(this.userDataPath)).map(publicConnection)
  }

  async addWebDav({ name, endpoint, username, password, allowInsecure = false }) {
    const trimmedName = String(name || '').trim()
    if (!trimmedName) throw new Error('请填写连接名称。')
    if (!String(endpoint || '').trim()) throw new Error('请填写 WebDAV 地址。')
    if (!String(password || '')) throw new Error('请填写 WebDAV 密码或应用专用密码。')
    const provider = this.createWebDavProvider({ endpoint, username, password, allowInsecure })
    await provider.testConnection()
    const id = randomUUID()
    const credentialId = `webdav:${id}`
    await this.credentialStore.set(credentialId, { password: String(password) })
    const connections = await readConnections(this.userDataPath)
    const connection = {
      id,
      type: 'webdav',
      name: trimmedName,
      endpoint: String(endpoint).trim(),
      username: String(username || ''),
      allowInsecure: Boolean(allowInsecure),
      credentialId,
      createdAt: new Date().toISOString()
    }
    connections.push(connection)
    await writeConnections(this.userDataPath, connections)
    return publicConnection(connection)
  }

  async addS3({ name, endpoint, bucket, region, accessKeyId, secretAccessKey, allowInsecure = false }) {
    const trimmedName = String(name || '').trim()
    if (!trimmedName) throw new Error('请填写连接名称。')
    if (!String(endpoint || '').trim()) throw new Error('请填写 S3 Endpoint。')
    if (!String(bucket || '').trim()) throw new Error('请填写 Bucket 名称。')
    if (!String(region || '').trim()) throw new Error('请填写 Region。')
    if (!String(accessKeyId || '').trim() || !String(secretAccessKey || '')) {
      throw new Error('请填写 S3 Access Key 和 Secret Key。')
    }
    const provider = this.createS3Provider({ endpoint, bucket, region, accessKeyId, secretAccessKey, allowInsecure })
    await provider.testConnection()
    const id = randomUUID()
    const credentialId = `s3:${id}`
    await this.credentialStore.set(credentialId, { secretAccessKey: String(secretAccessKey) })
    const connections = await readConnections(this.userDataPath)
    const connection = {
      id,
      type: 's3',
      name: trimmedName,
      endpoint: String(endpoint).trim(),
      bucket: String(bucket).trim(),
      region: String(region).trim(),
      accessKeyId: String(accessKeyId).trim(),
      allowInsecure: Boolean(allowInsecure),
      credentialId,
      createdAt: new Date().toISOString()
    }
    connections.push(connection)
    await writeConnections(this.userDataPath, connections)
    return publicConnection(connection)
  }

  async update(id, config) {
    const connections = await readConnections(this.userDataPath)
    const index = connections.findIndex((connection) => connection.id === id)
    if (index < 0) throw new Error('找不到云端连接。')
    const current = connections[index]
    const credential = await this.credentialStore.get(current.credentialId)

    if (current.type === 'webdav') {
      const name = String(config.name || '').trim()
      const endpoint = String(config.endpoint || '').trim()
      const username = String(config.username || '')
      const password = String(config.password || '') || credential?.password
      if (!name) throw new Error('请填写连接名称。')
      if (!endpoint) throw new Error('请填写 WebDAV 地址。')
      if (!password) throw new Error('请填写 WebDAV 密码或应用专用密码。')
      const allowInsecure = Boolean(config.allowInsecure)
      await this.createWebDavProvider({ endpoint, username, password, allowInsecure }).testConnection()
      const next = { ...current, name, endpoint, username, allowInsecure, updatedAt: new Date().toISOString() }
      if (password !== credential?.password) await this.credentialStore.set(current.credentialId, { password })
      connections[index] = next
      await writeConnections(this.userDataPath, connections)
      return publicConnection(next)
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
      await this.createS3Provider({ endpoint, bucket, region, accessKeyId, secretAccessKey, allowInsecure }).testConnection()
      const next = { ...current, name, endpoint, bucket, region, accessKeyId, allowInsecure, updatedAt: new Date().toISOString() }
      if (secretAccessKey !== credential?.secretAccessKey) await this.credentialStore.set(current.credentialId, { secretAccessKey })
      connections[index] = next
      await writeConnections(this.userDataPath, connections)
      return publicConnection(next)
    }

    throw new Error('不支持的云端连接类型。')
  }

  async remove(id) {
    const connections = await readConnections(this.userDataPath)
    const current = connections.find((connection) => connection.id === id)
    if (!current) return false
    await writeConnections(this.userDataPath, connections.filter((connection) => connection.id !== id))
    await this.credentialStore.remove(current.credentialId)
    return true
  }

  async test(id) {
    const provider = await this.createProvider(id)
    return provider.testConnection()
  }

  async createProvider(id, options = {}) {
    const connection = (await readConnections(this.userDataPath)).find((item) => item.id === id)
    if (!connection) throw new Error('找不到云端连接。')
    const credential = await this.credentialStore.get(connection.credentialId)
    if (connection.type === 'webdav') {
      if (!credential?.password) throw new Error('云端密码不可用，请重新连接。')
      return this.createWebDavProvider({ ...connection, ...options, password: credential.password })
    }
    if (connection.type === 's3') {
      if (!credential?.secretAccessKey) throw new Error('S3 密钥不可用，请重新连接。')
      return this.createS3Provider({ ...connection, ...options, secretAccessKey: credential.secretAccessKey })
    }
    throw new Error('不支持的云端连接类型。')
  }
}
