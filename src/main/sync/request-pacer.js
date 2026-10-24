// Cloud services throttle clients that send requests too fast. A pacer is
// shared by all requests of one provider:
// - 429 / 503 are retried after Retry-After, or an exponential backoff with
//   jitter when the server gives none;
// - every throttled answer doubles the gap between requests, and successes
//   shrink it slowly, so a long sync settles below the server's limit.
// Each attempt calls `send` again, so a signed request is signed anew.
//
// 数据胶囊 (s3.cstcloud.cn), measured 2026-10-23: only uploads are limited.
// About 200 PUTs are accepted (at any speed: 5 parallel or one per 2 s), then
// every PUT answers 429, without Retry-After, for about 20 minutes; GET, LIST
// and DELETE keep working. Afterwards one PUT per minute passed for 20
// minutes straight. A short backoff cannot outlast that, so when the short
// retries are used up the pacer waits in long steps (one probe every
// `lockProbeMs`, up to `lockWaitMs`) and reports the wait; once a lock has
// been seen, uploads keep at least `lockedWriteGapMs` apart for the rest of
// the sync (about 180 per 30 minutes) instead of running into it again.

const RETRYABLE = new Set([429, 503])

// Appended to an HTTP error after the pacer gave up on a throttled request.
export const throttleHint = (status) => RETRYABLE.has(status)
  ? '。云端限制了请求频率，已等待较长时间仍未恢复，请稍后再同步（已上传的文件不会重复上传）'
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
    maxAttempts = 6,
    baseDelayMs = 1000,
    maxDelayMs = 60000,
    maxIntervalMs = 5000,
    lockProbeMs = 2 * 60000,
    lockWaitMs = 45 * 60000,
    lockedWriteGapMs = 10000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    random = Math.random,
    onThrottle = null
  } = {}) {
    Object.assign(this, { maxAttempts, baseDelayMs, maxDelayMs, maxIntervalMs, lockProbeMs, lockWaitMs, lockedWriteGapMs, sleep, now, random, onThrottle })
    this.intervalMs = 0
    // Upload-only throttling (数据胶囊 limits PUTs alone) must not slow reads.
    this.writeIntervalMs = 0
    this.nextStartAt = 0
    this.nextWriteAt = 0
    this.writeGapMs = 0
    this.throttled = 0
  }

  async waitTurn(write) {
    const at = Math.max(this.nextStartAt, write ? this.nextWriteAt : 0)
    const wait = at - this.now()
    if (wait > 0) await this.sleep(wait)
    const started = this.now()
    this.nextStartAt = started + this.intervalMs
    if (write) this.nextWriteAt = started + Math.max(this.intervalMs, this.writeIntervalMs, this.writeGapMs)
  }

  // `quick`: no long lock wait (a connection test must answer in seconds).
  async run(send, { write = false, quick = false } = {}) {
    let lockedSince = null
    for (let attempt = 1; ; attempt += 1) {
      await this.waitTurn(write)
      const response = await send()
      if (!RETRYABLE.has(response?.status)) {
        // Shrink the gap by 10% per success; below 50ms it is dropped.
        const gap = write ? 'writeIntervalMs' : 'intervalMs'
        this[gap] = this[gap] > 50 ? Math.round(this[gap] * 0.9) : 0
        if (lockedSince != null) {
          if (write) {
            this.writeGapMs = Math.max(this.writeGapMs, this.lockedWriteGapMs)
            this.nextWriteAt = Math.max(this.nextWriteAt, this.now() + this.writeGapMs)
          }
          this.onThrottle?.({ status: response.status, resumed: true, waitedMs: this.now() - lockedSince })
        }
        return response
      }
      this.throttled += 1
      const gap = write ? 'writeIntervalMs' : 'intervalMs'
      this[gap] = Math.min(this.maxIntervalMs, Math.max(250, this[gap] * 2))
      const hinted = retryAfterMs(response.headers?.get?.('retry-after'), this.now())
      let delay
      if (attempt < this.maxAttempts) {
        const backoff = this.baseDelayMs * 2 ** (attempt - 1)
        delay = Math.min(this.maxDelayMs, hinted ?? Math.round(backoff * (0.5 + this.random() / 2)))
      } else {
        // Short retries used up: the service has locked this client out.
        // Probe rarely (every probe during the lock is wasted, and may keep
        // it locked) until it lets requests through again.
        if (quick) return response
        lockedSince ??= this.now()
        const waited = this.now() - lockedSince
        if (waited >= this.lockWaitMs) return response
        delay = Math.min(this.lockWaitMs - waited, Math.max(hinted ?? 0, Math.round(this.lockProbeMs * (0.9 + this.random() / 5))))
      }
      // Drain the body so the connection can be reused.
      try { await response.arrayBuffer?.() } catch { /* ignore */ }
      this.onThrottle?.({
        status: response.status,
        attempt,
        delayMs: delay,
        locked: lockedSince != null,
        waitedMs: lockedSince != null ? this.now() - lockedSince : 0,
        resumeAt: this.now() + delay
      })
      await this.sleep(delay)
    }
  }
}
