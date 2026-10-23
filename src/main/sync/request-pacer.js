// Cloud services throttle clients that send requests too fast: 数据胶囊
// (s3.cstcloud.cn) answers HTTP 429 when a workspace with thousands of small
// Markdown files is synced, because every file is at least one PUT. A pacer
// is shared by all requests of one provider:
// - 429 / 503 are retried after Retry-After, or an exponential backoff with
//   jitter when the server gives none;
// - every throttled answer doubles the gap between requests, and successes
//   shrink it slowly, so a long sync settles below the server's limit instead
//   of hitting it again on every file.
// Each attempt calls `send` again, so a signed request is signed anew.

const RETRYABLE = new Set([429, 503])

// Appended to an HTTP error after the pacer gave up on a throttled request.
export const throttleHint = (status) => RETRYABLE.has(status)
  ? '。云端限制了请求频率，已自动放慢并重试多次仍未成功，请稍后再同步'
  : ''

export function retryAfterMs(value, nowMs = Date.now()) {
  const text = String(value || '').trim()
  if (!text) return null
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000)
  const date = Date.parse(text)
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null
}

export class RequestPacer {
  constructor({
    maxAttempts = 8,
    baseDelayMs = 1000,
    maxDelayMs = 60000,
    maxIntervalMs = 5000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    random = Math.random,
    onThrottle = null
  } = {}) {
    Object.assign(this, { maxAttempts, baseDelayMs, maxDelayMs, maxIntervalMs, sleep, now, random, onThrottle })
    this.intervalMs = 0
    this.nextStartAt = 0
    this.throttled = 0
  }

  async waitTurn() {
    const wait = this.nextStartAt - this.now()
    if (wait > 0) await this.sleep(wait)
    this.nextStartAt = this.now() + this.intervalMs
  }

  async run(send) {
    for (let attempt = 1; ; attempt += 1) {
      await this.waitTurn()
      const response = await send()
      if (!RETRYABLE.has(response?.status)) {
        // Shrink the gap by 10% per success; below 50ms it is dropped.
        this.intervalMs = this.intervalMs > 50 ? Math.round(this.intervalMs * 0.9) : 0
        return response
      }
      this.throttled += 1
      this.intervalMs = Math.min(this.maxIntervalMs, Math.max(250, this.intervalMs * 2))
      if (attempt >= this.maxAttempts) return response
      const hinted = retryAfterMs(response.headers?.get?.('retry-after'), this.now())
      const backoff = this.baseDelayMs * 2 ** (attempt - 1)
      const delay = Math.min(this.maxDelayMs, hinted ?? Math.round(backoff * (0.5 + this.random() / 2)))
      // Drain the body so the connection can be reused.
      try { await response.arrayBuffer?.() } catch { /* ignore */ }
      this.onThrottle?.({ status: response.status, attempt, delayMs: delay })
      await this.sleep(delay)
    }
  }
}
