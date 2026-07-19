import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const STORE_VERSION = 1

const storePathFor = (userDataPath) => join(userDataPath, 'sync', 'credentials.json')

export class CredentialStore {
  constructor({ userDataPath, safeStorage }) {
    this.userDataPath = userDataPath
    this.safeStorage = safeStorage
  }

  assertAvailable() {
    if (!this.safeStorage?.isEncryptionAvailable?.()) {
      throw new Error('当前系统无法安全保存同步密码，请先启用系统钥匙串或凭据服务。')
    }
  }

  async readAll() {
    try {
      const raw = JSON.parse(await fs.readFile(storePathFor(this.userDataPath), 'utf8'))
      return raw?.version === STORE_VERSION && raw.items && typeof raw.items === 'object' ? raw.items : {}
    } catch (error) {
      if (error?.code === 'ENOENT') return {}
      throw new Error(`无法读取同步凭据：${error?.message || error}`)
    }
  }

  async writeAll(items) {
    const path = storePathFor(this.userDataPath)
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(temp, JSON.stringify({ version: STORE_VERSION, items }, null, 2) + '\n', {
      encoding: 'utf8', mode: 0o600
    })
    await fs.rename(temp, path)
  }

  async set(id, value) {
    this.assertAvailable()
    const items = await this.readAll()
    items[id] = this.safeStorage.encryptString(JSON.stringify(value)).toString('base64')
    await this.writeAll(items)
  }

  async get(id) {
    this.assertAvailable()
    const encrypted = (await this.readAll())[id]
    if (!encrypted) return null
    try {
      return JSON.parse(this.safeStorage.decryptString(Buffer.from(encrypted, 'base64')))
    } catch {
      throw new Error('同步凭据无法解密，请重新连接云端。')
    }
  }

  async remove(id) {
    const items = await this.readAll()
    delete items[id]
    await this.writeAll(items)
  }
}
