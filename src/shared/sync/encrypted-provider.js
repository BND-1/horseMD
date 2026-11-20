// A provider that end-to-end encrypts another one (WebDAV, S3, the official
// service): same interface as WebDavProvider / S3Provider for the sync
// engine (get / put / copy / delete / createDirectory / removeDirectory /
// testConnection), paths turned into opaque names, bytes sealed
// (sync-crypto.js; docs/official-sync-design.md §4). rclone crypt /
// Cryptomator are the model: a wrapper over any remote.
//
// Cloud layout inside the workspace prefix:
//   .horsemd/encryption.json   the wrapped key (plain JSON, KEY_FILE)
//   o/<hmac>                    every file, the manifest included
//   t/<stamp>/<hmac>            cloud trash copies (kept apart so a later
//                               cleanup can find old ones by stamp)
// Empty folders have no cloud marker: the (encrypted) manifest's `dirs`
// already carries them to the other devices, so createDirectory /
// removeDirectory do nothing.

import { KEY_FILE, KeyChangedError, parseKeyFile } from './sync-crypto.js'
import { webBytes } from './bytes.js'

const TRASH_RE = /^\.horsemd\/trash\/([^/]+)\/(.+)$/

export class EncryptedProvider {
  // `inner`: the provider holding the ciphertext. `cipher`: workspaceCipher().
  constructor({ inner, cipher, bytes = webBytes }) {
    if (!inner || !cipher) throw new Error('EncryptedProvider needs a provider and a cipher.')
    this.inner = inner
    this.cipher = cipher
    this.bytes = bytes
    this.encrypted = true
    this.verified = null
  }

  // Once per instance (one sync run), before the first read or write: the
  // cloud key file must hold this device's key. Another device that reset
  // the key would otherwise look like an empty workspace (other names).
  verify() {
    if (!this.verified) {
      this.verified = (async () => {
        const remote = await this.inner.get(KEY_FILE)
        if (!remote) throw new KeyChangedError()
        const file = parseKeyFile(this.bytes.toText(remote.bytes))
        if (file.check !== await this.cipher.keyCheck()) throw new KeyChangedError()
      })()
      this.verified.catch(() => { this.verified = null })
    }
    return this.verified
  }

  async objectPath(path) {
    await this.verify()
    const clean = String(path || '').replace(/^\/+|\/+$/g, '')
    if (!clean || clean === KEY_FILE) throw new Error(`不能直接访问加密工作区里的 ${clean || '根目录'}。`)
    const trash = TRASH_RE.exec(clean)
    const name = await this.cipher.objectNameFor(clean)
    return trash ? `t/${trash[1].replace(/[^0-9A-Za-z_-]/g, '_')}/${name}` : `o/${name}`
  }

  // The inner bytes codec type (Buffer on desktop) for decrypted bytes.
  out(plain) {
    return this.bytes.fromArrayBuffer(plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength))
  }

  testConnection() { return this.inner.testConnection() }

  async get(path) {
    const remote = await this.inner.get(await this.objectPath(path))
    if (!remote) return null
    return { ...remote, bytes: this.out(await this.cipher.decrypt(remote.bytes)) }
  }

  async put(path, bytes, options = {}) {
    const sealed = await this.cipher.encrypt(bytes)
    return this.inner.put(await this.objectPath(path), this.out(sealed), { ...options, contentType: 'application/octet-stream' })
  }

  async copy(fromPath, toPath, options = {}) {
    // No server-side copy (WebDAV): the engine falls back to download +
    // compare + upload, which goes through this provider's get / put.
    if (typeof this.inner.copy !== 'function') throw Object.assign(new Error('copy not supported'), { copyUnsupported: true })
    return this.inner.copy(await this.objectPath(fromPath), await this.objectPath(toPath), options)
  }

  async delete(path, options = {}) {
    return this.inner.delete(await this.objectPath(path), options)
  }

  async createDirectory() { return true }
  async removeDirectory() { return true }

  // Names are one-way: nothing inside an encrypted workspace can be listed.
  async list() { return [] }
}

// Read / write the workspace key file through the plain provider.
export async function readKeyFile(inner, bytes = webBytes) {
  const remote = await inner.get(KEY_FILE)
  return remote ? bytes.toText(remote.bytes) : null
}

export async function writeKeyFile(inner, keyFile, { revision = null, createOnly = false, bytes = webBytes } = {}) {
  return inner.put(KEY_FILE, bytes.fromText(JSON.stringify(keyFile, null, 2) + '\n'), {
    revision, createOnly, contentType: 'application/json'
  })
}
