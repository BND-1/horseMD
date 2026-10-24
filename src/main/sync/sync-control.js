// Pause / resume / stop for one running sync.
// - The engine calls `checkpoint()` between files: it waits while paused and
//   throws SyncStoppedError once stopped.
// - The request pacer sleeps through `sleep()`, so a stop also ends a long
//   throttling wait (数据胶囊 locks uploads for ~20 minutes) at once, and a
//   pause during that wait takes effect without another request.
// A stop never interrupts a file mid-transfer: the request in flight finishes
// and the engine records everything completed so far.

export class SyncStoppedError extends Error {
  constructor() {
    super('同步已停止。')
    this.name = 'SyncStoppedError'
    this.syncStopped = true
  }
}

export const isSyncStopped = (error) => error?.syncStopped === true

export class SyncControl {
  constructor({ onChange = null } = {}) {
    this.paused = false
    this.stopped = false
    this.onChange = onChange
    this.waiters = new Set()
    // Set while a stopped run records its progress: those requests may still
    // do their short retries.
    this.finalizing = false
    // A pause takes effect at the next checkpoint (after the file in flight)
    // or at once inside a throttling wait; `holding` says it has.
    this.holding = false
  }

  // Called where the sync actually stands still for a pause.
  hold() {
    if (this.holding) return
    this.holding = true
    this.onChange?.({ paused: true, holding: true })
  }

  wake() {
    for (const wake of [...this.waiters]) wake()
  }

  pause() {
    if (this.stopped || this.paused) return false
    this.paused = true
    this.onChange?.({ paused: true })
    this.wake()
    return true
  }

  resume() {
    if (this.stopped || !this.paused) return false
    this.paused = false
    this.holding = false
    this.onChange?.({ paused: false, holding: false })
    this.wake()
    return true
  }

  stop() {
    if (this.stopped) return false
    this.stopped = true
    this.paused = false
    this.onChange?.({ stopping: true })
    this.wake()
    return true
  }

  // Resolves when `ready()` is true or a state change happens.
  waitForChange(ms = Infinity) {
    return new Promise((resolve) => {
      let timer = null
      const done = () => {
        this.waiters.delete(done)
        if (timer) clearTimeout(timer)
        resolve()
      }
      this.waiters.add(done)
      if (Number.isFinite(ms)) timer = setTimeout(done, Math.max(0, ms))
    })
  }

  async checkpoint() {
    while (this.paused && !this.stopped) {
      this.hold()
      await this.waitForChange()
    }
    if (this.stopped) throw new SyncStoppedError()
  }

  // Pacer sleep: ends early on stop (throws), and stays asleep while paused.
  async sleep(ms) {
    if (this.stopped && this.finalizing) return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
    const until = Date.now() + Math.max(0, ms)
    for (;;) {
      if (this.stopped) throw new SyncStoppedError()
      const left = until - Date.now()
      if (left <= 0 && !this.paused) return
      if (this.paused) this.hold()
      await this.waitForChange(this.paused ? Infinity : left)
    }
  }
}
