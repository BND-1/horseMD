// Native plugins for cloud sync on phones (Capacitor). Native side:
//   ios/App/App/HorseHttpPlugin.swift, HorseSecureStorePlugin.swift, HorseDevicePlugin.swift
//   android/app/src/main/java/com/horsemd/app/HorseHttpPlugin.java, HorseSecureStorePlugin.java,
//   HorseDevicePlugin.java
// Registered in MainViewController.swift / MainActivity.java like HorseFiles.
//
// HorseHttp.request({ method, url, headers, bodyBase64?, timeoutMs })
//   → { status, headers: { lower-case name: string }, bodyBase64 }
//   Any method (PROPFIND, MKCOL, PUT, DELETE, HEAD, GET, POST…); headers sent
//   as given (User-Agent too). No cache, no cookies. timeoutMs bounds the whole
//   exchange. A compressed response is returned decoded, without its
//   Content-Encoding / Content-Length headers. Rejects with error.code
//   BAD_URL | TIMEOUT | TOO_LARGE (> 200 MB) | NETWORK; the message names the
//   host only. Any HTTP status (4xx/5xx too) RESOLVES.
// HorseSecureStore.get({ key }) → { value: string | null }, set({ key, value }),
//   remove({ key }), keys({ prefix }) → { keys: string[] }
//   (iOS Keychain, this device only; Android EncryptedSharedPreferences, not
//   backed up). Rejects with code EINVAL | SECURE_STORE.
// HorseDevice.name() → { name } ("iPhone", "HUAWEI SEA-AL10").
import { registerPlugin } from '@capacitor/core'

export const HorseHttp = registerPlugin('HorseHttp')
export const HorseSecureStore = registerPlugin('HorseSecureStore')
export const HorseDevice = registerPlugin('HorseDevice')

const CHUNK = 0x8000

export function bytesToBase64(bytes) {
  if (!bytes || !bytes.length) return ''
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64()
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function base64ToBytes(base64) {
  if (!base64) return new Uint8Array(0)
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(base64)
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const toBytes = (body) => {
  if (body == null) return null
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  if (typeof body === 'string') return new TextEncoder().encode(body)
  throw new TypeError('nativeRequest body must be a Uint8Array, ArrayBuffer, string or null')
}

/**
 * One HTTP exchange through HorseHttp.
 * @param {{ method?: string, url: string, headers?: Record<string,string>,
 *           body?: Uint8Array|ArrayBuffer|string|null, timeoutMs?: number }} req
 * @returns {Promise<{ status: number, headers: Record<string,string>, body: Uint8Array }>}
 *   Rejects with an Error whose `code` is BAD_URL / TIMEOUT / TOO_LARGE / NETWORK.
 */
export async function nativeRequest({ method = 'GET', url, headers = {}, body = null, timeoutMs = 60000 } = {}) {
  const plain = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (v != null) plain[k] = String(v)
  }
  const bytes = toBytes(body)
  const options = { method: String(method), url: String(url), headers: plain, timeoutMs: Number(timeoutMs) || 60000 }
  if (bytes) options.bodyBase64 = bytesToBase64(bytes)
  let res
  try {
    res = await HorseHttp.request(options)
  } catch (error) {
    const e = new Error(error?.message || 'Network request failed')
    e.code = error?.code || 'NETWORK'
    throw e
  }
  const outHeaders = {}
  for (const [k, v] of Object.entries(res?.headers || {})) outHeaders[k.toLowerCase()] = String(v)
  return { status: Number(res?.status) || 0, headers: outHeaders, body: base64ToBytes(res?.bodyBase64 || '') }
}

let cachedName = null

/** This phone's label for conflict-copy names; falls back to the platform name. */
export async function deviceName() {
  if (cachedName) return cachedName
  try {
    const { name } = await HorseDevice.name()
    if (name && String(name).trim()) cachedName = String(name).trim()
  } catch {}
  if (!cachedName) cachedName = /android/i.test(navigator.userAgent || '') ? 'Android' : 'iPhone'
  return cachedName
}
