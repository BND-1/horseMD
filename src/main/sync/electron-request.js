// Sync requests through Electron's net.request instead of net.fetch (#161).
//
// 七牛 (Qiniu, measured 2026-10-26) answers every download with
//   content-disposition: attachment; filename="<key>"; filename*=utf-8''…
// where the key's non-ASCII characters (Chinese file names) are raw UTF-8.
// net.fetch copies the response headers into a WHATWG Headers object, whose
// ByteString check throws on them ("Cannot convert argument to a ByteString")
// inside Electron's own 'response' listener. That error never reaches the
// fetch promise — it is an uncaught exception, swallowed by the process guard
// in index.js — so the request never settled and every download of a Chinese
// file name ended in the 60 s timeout (deleting it: its trash backup; a second
// device: pulling it). Here the raw headers are read directly; a value with
// characters above U+00FF is passed on as its UTF-8 bytes (a Latin-1 string),
// which is what a browser exposes for such a header.
//
// Still Chromium's network stack (not Node's fetch: its c-ares resolver can
// abort an unsigned app under launchd). `cache: 'no-store'`: a sync must read
// the object as the service has it now, never an HTTP-cache copy.

const NULL_BODY = new Set([101, 103, 204, 205, 304])

export const toByteString = (value) => (/[^\u0000-ÿ]/.test(value)
  ? Buffer.from(value, 'utf8').toString('latin1')
  : value)

const abortError = () => {
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  return error
}

export function responseHeaders(raw = {}) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw)) {
    const text = Array.isArray(value) ? value.join(', ') : String(value ?? '')
    try {
      headers.append(name, toByteString(text))
    } catch {
      // A header no Response can carry (should not happen after the
      // conversion above) is dropped rather than failing the request.
    }
  }
  return headers
}

export function createElectronRequest(net) {
  return (url, { method = 'GET', headers = {}, body = null, signal = null } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return }
    let request
    try {
      request = net.request({ method, url, redirect: 'follow', cache: 'no-store', useSessionCookies: false })
      for (const [name, value] of Object.entries(headers || {})) request.setHeader(name, value)
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    let finished = false
    let stream = null
    const finish = () => {
      finished = true
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error) => {
      if (finished) return
      finish()
      if (!settled) { settled = true; reject(error); return }
      try { stream?.error(error) } catch { /* stream already closed */ }
    }
    const onAbort = () => {
      try { request.abort() } catch { /* already done */ }
      fail(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    request.on('response', (response) => {
      if (finished) return
      const init = { status: response.statusCode, statusText: response.statusMessage || '', headers: responseHeaders(response.headers) }
      let result
      try {
        if (NULL_BODY.has(response.statusCode)) {
          response.on('data', () => {})
          response.on('end', finish)
          result = new Response(null, init)
        } else {
          result = new Response(new ReadableStream({
            start(controller) {
              stream = controller
              response.on('data', (chunk) => { if (!finished) controller.enqueue(new Uint8Array(chunk)) })
              response.on('end', () => {
                if (finished) return
                finish()
                controller.close()
              })
              response.on('error', (error) => fail(error))
              response.on('aborted', () => fail(abortError()))
              // A connection that drops mid-body emits only 'close'.
              response.on('close', () => fail(new Error('连接在传输中途断开。')))
            }
          }), init)
        }
      } catch (error) {
        fail(error)
        return
      }
      settled = true
      resolve(result)
    })
    request.on('error', (error) => fail(error))
    request.on('abort', () => fail(abortError()))

    try {
      if (body != null) {
        const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body.buffer ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : body)
        // Chromium sets Content-Length itself (setting it is refused with
        // ERR_INVALID_ARGUMENT); an empty PUT still sends "Content-Length: 0"
        // (S3 answers a PUT without one with 411) — locked by the test.
        if (bytes.length) request.write(bytes)
      }
      request.end()
    } catch (error) {
      fail(error)
    }
  })
}
