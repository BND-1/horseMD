// Byte helpers for the shared sync code: Uint8Array + TextEncoder/Decoder
// instead of Node's Buffer. A platform may pass its own codec with the same
// methods (the desktop passes Buffer-based ones, src/main/sync/node-platform.js,
// so every byte it hands to providers and tests is still a Buffer).
//
// Codec contract:
//   fromText(string) → Uint8Array          UTF-8
//   toText(Uint8Array) → string            UTF-8, a BOM is kept (like Buffer)
//   fromArrayBuffer(ArrayBuffer) → Uint8Array
//   empty() → Uint8Array                   zero bytes
//   base64(string) → string                base64 of the string's UTF-8 bytes

const encoder = new TextEncoder()
// ignoreBOM: keep a leading U+FEFF, as Buffer#toString('utf8') does.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

export const utf8Encode = (text) => encoder.encode(String(text))
export const utf8Decode = (bytes) => decoder.decode(bytes)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes) {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += '='
  }
  return out
}

export function base64ToBytes(text) {
  const clean = String(text || '').replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let buffer = 0
  let bits = 0
  let o = 0
  for (const char of clean) {
    buffer = (buffer << 6) | B64.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buffer >> bits) & 0xff
    }
  }
  return o === out.length ? out : out.slice(0, o)
}

export const webBytes = {
  fromText: utf8Encode,
  toText: utf8Decode,
  fromArrayBuffer: (arrayBuffer) => new Uint8Array(arrayBuffer),
  empty: () => new Uint8Array(0),
  base64: (text) => bytesToBase64(utf8Encode(text))
}

// A header value with characters above U+00FF as its UTF-8 bytes (one char
// per byte), what a browser exposes for such a header (see
// src/main/sync/electron-request.js, 七牛's raw UTF-8 content-disposition).
export const toByteString = (value) => (/[^\u0000-ÿ]/.test(value)
  ? Array.from(utf8Encode(value), (byte) => String.fromCharCode(byte)).join('')
  : value)
