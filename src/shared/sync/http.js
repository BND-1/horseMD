import { toByteString, utf8Encode } from './bytes.js'

// A platform's raw HTTP adapter turned into the fetch-like function the
// providers use ((url, init) → Response). Phones pass their native request
// (no CORS, any method, no cache); the desktop passes electron-request.js
// directly and never comes through here.
//
// http.request({ method, url, headers, body: Uint8Array|null, timeoutMs })
//   → { status, headers: { lower-case name: string }, body: Uint8Array }
//
// `init.signal` (the per-request deadline of sync-request.js) rejects the
// call with an AbortError; the native request is left to finish on its own
// (its own timeoutMs is the backstop).

const NULL_BODY = new Set([101, 103, 204, 205, 304])

const abortError = () => {
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  return error
}

const toBody = (body) => {
  if (body == null) return null
  if (typeof body === 'string') return utf8Encode(body)
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  throw new Error('Unsupported request body.')
}

export function responseHeaders(raw = {}) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw || {})) {
    const text = Array.isArray(value) ? value.join(', ') : String(value ?? '')
    try {
      headers.append(name, toByteString(text))
    } catch {
      // A header no Response can carry is dropped rather than failing the request.
    }
  }
  return headers
}

export function createFetchFromHttp(http, { timeoutMs = 10 * 60 * 1000 } = {}) {
  if (!http || typeof http.request !== 'function') throw new Error('Sync needs a network request adapter.')
  return (url, { method = 'GET', headers = {}, body = null, signal = null } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return }
    let done = false
    const onAbort = () => {
      if (done) return
      done = true
      reject(abortError())
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    const plainHeaders = {}
    for (const [name, value] of Object.entries(headers || {})) plainHeaders[name] = String(value)
    Promise.resolve()
      .then(() => http.request({ method, url, headers: plainHeaders, body: toBody(body), timeoutMs }))
      .then((response) => {
        if (done) return
        done = true
        signal?.removeEventListener?.('abort', onAbort)
        try {
          const status = Number(response?.status) || 0
          if (status < 200 || status > 599) throw new Error(`云端返回了无效的 HTTP 状态（${status}）。`)
          const bytes = response?.body instanceof Uint8Array ? response.body : toBody(response?.body) || new Uint8Array(0)
          resolve(new Response(NULL_BODY.has(status) ? null : bytes, { status, headers: responseHeaders(response?.headers) }))
        } catch (error) {
          reject(error)
        }
      }, (error) => {
        if (done) return
        done = true
        signal?.removeEventListener?.('abort', onAbort)
        reject(error)
      })
  })
}
