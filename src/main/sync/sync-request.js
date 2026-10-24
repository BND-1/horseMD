// Every S3 / WebDAV request of the sync goes through here (issue #161).
// - Timeout: a request the service never answers (or a body that stops
//   arriving) used to leave the sync running forever, so the folder stayed
//   "正在同步" until HorseMD restarted. The deadline covers the whole exchange
//   — the body is read here — and grows with the bytes sent / announced.
// - Trace: with --horsemd-input-trace each request is logged (method, URL
//   without credentials, status, bytes, time; never headers, so no keys or
//   signatures), so a provider-specific problem can be read from the log.

const NULL_BODY = new Set([101, 204, 205, 304])

const byteLength = (body) => {
  if (body == null) return 0
  if (typeof body === 'string') return Buffer.byteLength(body)
  if (typeof body.byteLength === 'number') return body.byteLength
  return 0
}

export const redactUrl = (raw) => {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return String(raw).replace(/\/\/[^/@]*@/, '//')
  }
}

export class SyncRequestTimeoutError extends Error {
  constructor(method, url, seconds) {
    let where = url
    try { where = decodeURIComponent(new URL(url).pathname) } catch { /* keep raw */ }
    super(`云端 ${seconds} 秒内没有响应（${method} ${where}），已停止这次同步。请检查网络后重试。`)
    this.name = 'SyncRequestTimeoutError'
  }
}

export function createSyncRequest(fetchFn, {
  log = null,
  baseTimeoutMs = 60000,
  bytesPerSecond = 32 * 1024,
  now = Date.now
} = {}) {
  return async (url, init = {}) => {
    const method = init.method || 'GET'
    const started = now()
    const bytesOut = byteLength(init.body)
    const controller = new AbortController()
    let timer = null
    let timedOutAfter = 0
    const arm = (bytes) => {
      if (timer) clearTimeout(timer)
      const ms = baseTimeoutMs + Math.round((bytes / bytesPerSecond) * 1000)
      timer = setTimeout(() => {
        timedOutAfter = Math.round((now() - started) / 1000)
        controller.abort()
      }, ms)
    }
    const entry = { kind: 'sync-request', method, url: redactUrl(url), bytesOut }
    const finish = (extra) => {
      if (timer) clearTimeout(timer)
      try { log?.({ ...entry, ms: now() - started, ...extra }) } catch { /* logging never breaks a sync */ }
    }
    arm(bytesOut)
    try {
      const response = await fetchFn(url, { ...init, signal: controller.signal })
      if (typeof response?.arrayBuffer !== 'function') {
        finish({ status: response?.status })
        return response
      }
      arm(Number(response.headers?.get?.('content-length')) || 0)
      const body = await response.arrayBuffer()
      finish({ status: response.status, bytesIn: body.byteLength })
      return new Response(NULL_BODY.has(response.status) ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    } catch (error) {
      if (timedOutAfter) {
        finish({ error: 'timeout' })
        throw new SyncRequestTimeoutError(method, url, timedOutAfter)
      }
      finish({ error: String(error?.message || error).replace(/\/\/[^/@\s]*@/g, '//').slice(0, 300) })
      throw error
    }
  }
}
