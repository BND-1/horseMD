// End-to-end encryption for a sync workspace (docs/official-sync-design.md §4).
// Shared by desktop and phones: WebCrypto only (globalThis.crypto.subtle —
// Node 20+, Chromium, WKWebView / Android WebView secure contexts).
//
// Key model (Joplin / Standard Notes): a random 32-byte master key encrypts
// everything; the user's password only wraps it. Changing the password
// rewraps 60 bytes, never the data. The wrapped key lives in the workspace
// as plain JSON (KEY_FILE) so every device can unlock it with the password.
//   KEK        = PBKDF2-SHA256(password, random 16-byte salt, 600 000) — OWASP
//                2023; native in WebCrypto everywhere (scrypt / Argon2 are not)
//   wrapped    = AES-256-GCM(KEK, master), AAD "horsemd-e2ee-key-v1"
//   contentKey = HKDF-SHA256(master, info "horsemd content v1") → AES-256-GCM
//   nameKey    = HKDF-SHA256(master, info "horsemd names v1")   → HMAC-SHA256
// A file is MAGIC + 12-byte random nonce + AES-GCM ciphertext (AAD = MAGIC).
// It is not bound to its path, so a server-side copy (cloud trash) stays
// readable. A path becomes an opaque fixed-length object name (objectNameFor):
// the cloud sees neither names nor folders, only counts, sizes and times.

import { base64ToBytes, bytesToBase64, utf8Encode } from './bytes.js'

export const KEY_FILE = '.horsemd/encryption.json'
export const KEY_FORMAT = 'horsemd-e2ee'
export const DEFAULT_ITERATIONS = 600000
const MIN_ITERATIONS = 1000
const MAX_ITERATIONS = 10000000
const KEY_AAD = utf8Encode('horsemd-e2ee-key-v1')
const MAGIC = utf8Encode('HMX1')
const NONCE_BYTES = 12

export class WrongPasswordError extends Error {
  constructor() {
    super('加密密码不对。')
    this.code = 'E2EE_WRONG_PASSWORD'
  }
}

export class KeyChangedError extends Error {
  constructor() {
    super('这个工作区的加密密钥已在别的设备上更换，请重新输入加密密码。')
    this.code = 'E2EE_KEY_CHANGED'
  }
}

export class NotEncryptedDataError extends Error {
  constructor(message = '云端文件不是 HorseMD 加密格式，或已损坏。') {
    super(message)
    this.code = 'E2EE_BAD_DATA'
  }
}

const subtleOf = (crypto) => {
  const subtle = (crypto || globalThis.crypto)?.subtle
  if (!subtle) throw new Error('这台设备不支持加密（缺少 WebCrypto）。')
  return subtle
}
const randomBytes = (n, crypto) => (crypto || globalThis.crypto).getRandomValues(new Uint8Array(n))
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}
const toU8 = (bytes) => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')

async function passwordKey(password, salt, iterations, crypto) {
  const subtle = subtleOf(crypto)
  if (typeof password !== 'string' || !password) throw new Error('请输入加密密码。')
  const base = await subtle.importKey('raw', utf8Encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

const CHECK_INPUT = '\u0000horsemd key check'

// Which master key a key file holds, without the password: an HMAC under the
// name key. A device whose cached key differs stops before reading or writing.
export async function keyCheckFor(master, { crypto = null } = {}) {
  return (await workspaceCipher(master, { crypto })).objectNameFor(CHECK_INPUT)
}

async function wrapMaster(master, password, { iterations, crypto }) {
  const salt = randomBytes(16, crypto)
  const nonce = randomBytes(NONCE_BYTES, crypto)
  const kek = await passwordKey(password, salt, iterations, crypto)
  const wrapped = await subtleOf(crypto).encrypt({ name: 'AES-GCM', iv: nonce, additionalData: KEY_AAD }, kek, master)
  return {
    format: KEY_FORMAT,
    version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: bytesToBase64(salt) },
    key: { alg: 'AES-256-GCM', nonce: bytesToBase64(nonce), wrapped: bytesToBase64(new Uint8Array(wrapped)) },
    check: await keyCheckFor(master, { crypto })
  }
}

// A new workspace key: { keyFile (JSON-able), master (32 bytes) }.
export async function createKeyFile(password, { iterations = DEFAULT_ITERATIONS, crypto = null } = {}) {
  const master = randomBytes(32, crypto)
  return { keyFile: await wrapMaster(master, password, { iterations, crypto }), master }
}

export function parseKeyFile(input) {
  let file = input
  if (typeof input === 'string') {
    try { file = JSON.parse(input) } catch { throw new NotEncryptedDataError('云端的加密信息已损坏。') }
  }
  const iterations = Number(file?.kdf?.iterations)
  if (file?.format !== KEY_FORMAT || file.version !== 1 || file.kdf?.name !== 'PBKDF2' || file.kdf?.hash !== 'SHA-256' ||
      !Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS ||
      file.key?.alg !== 'AES-256-GCM' || !file.kdf.salt || !file.key.nonce || !file.key.wrapped || !/^[0-9a-f]{64}$/.test(file.check || '')) {
    throw new NotEncryptedDataError(file?.format === KEY_FORMAT && file.version > 1
      ? '这个工作区用更新版本的 HorseMD 加密，请先升级。'
      : '云端的加密信息已损坏。')
  }
  return file
}

// The master key from a key file + password; WrongPasswordError otherwise.
export async function unlockKeyFile(input, password, { crypto = null } = {}) {
  const file = parseKeyFile(input)
  const kek = await passwordKey(password, base64ToBytes(file.kdf.salt), Number(file.kdf.iterations), crypto)
  try {
    const master = await subtleOf(crypto).decrypt({ name: 'AES-GCM', iv: base64ToBytes(file.key.nonce), additionalData: KEY_AAD }, kek, base64ToBytes(file.key.wrapped))
    const bytes = new Uint8Array(master)
    if (bytes.byteLength !== 32 || await keyCheckFor(bytes, { crypto }) !== file.check) throw new NotEncryptedDataError('云端的加密信息已损坏。')
    return bytes
  } catch (error) {
    if (error instanceof NotEncryptedDataError) throw error
    throw new WrongPasswordError()
  }
}

// A key file for an existing master key (a key file lost in the cloud is
// written again with the key this device already holds).
export async function wrapMasterKey(master, password, { iterations = DEFAULT_ITERATIONS, crypto = null } = {}) {
  if (!(master instanceof Uint8Array) || master.byteLength !== 32) throw new Error('加密密钥无效。')
  return wrapMaster(master, password, { iterations, crypto })
}

// Change the password: same master key, new salt and wrap.
export async function rewrapKeyFile(input, oldPassword, newPassword, { iterations = null, crypto = null } = {}) {
  const file = parseKeyFile(input)
  const master = await unlockKeyFile(file, oldPassword, { crypto })
  return wrapMaster(master, newPassword, { iterations: iterations || Number(file.kdf.iterations), crypto })
}

async function hkdf(master, info, algorithm, usages, crypto) {
  const subtle = subtleOf(crypto)
  const base = await subtle.importKey('raw', toU8(master), 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Encode(info) }, base, algorithm, false, usages)
}

// The working keys for a master key. Keep the result, not the master, around.
export async function workspaceCipher(master, { crypto = null } = {}) {
  if (!(master instanceof Uint8Array) || master.byteLength !== 32) throw new Error('加密密钥无效。')
  const subtle = subtleOf(crypto)
  const contentKey = await hkdf(master, 'horsemd content v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt'], crypto)
  const nameKey = await hkdf(master, 'horsemd names v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign'], crypto)
  return {
    async encrypt(bytes) {
      const nonce = randomBytes(NONCE_BYTES, crypto)
      const sealed = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: MAGIC }, contentKey, toU8(bytes))
      return concat(MAGIC, nonce, new Uint8Array(sealed))
    },
    async decrypt(bytes) {
      const data = toU8(bytes)
      if (data.byteLength < MAGIC.byteLength + NONCE_BYTES + 16 || MAGIC.some((b, i) => data[i] !== b)) throw new NotEncryptedDataError()
      const nonce = data.subarray(MAGIC.byteLength, MAGIC.byteLength + NONCE_BYTES)
      try {
        return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: MAGIC }, contentKey, data.subarray(MAGIC.byteLength + NONCE_BYTES)))
      } catch {
        throw new NotEncryptedDataError('云端文件已损坏或被改动过，无法解密。')
      }
    },
    keyCheck: () => keyCheckFor(master, { crypto }),
    // Byte-exact: two spellings of a path are two objects, as without encryption.
    async objectNameFor(path) {
      return hex(await subtle.sign('HMAC', nameKey, utf8Encode(path)))
    }
  }
}
