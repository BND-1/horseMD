export function createLatestTaskRunner(worker) {
  const active = new Map()

  const cancel = (key) => {
    const task = active.get(key)
    if (!task) return false
    task.controller.abort()
    return true
  }

  const run = (key, payload) => {
    const previous = active.get(key)
    if (previous) previous.controller.abort()
    const controller = new AbortController()
    const task = { controller }
    active.set(key, task)
    task.settled = (async () => {
      // Aborting a BrowserWindow print is asynchronous. Wait for the previous
      // worker's finally block before starting its replacement so Chromium
      // never receives overlapping printToPDF jobs for the same renderer.
      if (previous?.settled) await previous.settled.catch(() => {})
      if (controller.signal.aborted || active.get(key) !== task) return { stale: true }
      try {
        const value = await worker(payload, controller.signal)
        if (active.get(key) !== task || controller.signal.aborted) return { stale: true }
        return { stale: false, value }
      } catch (error) {
        if (controller.signal.aborted || active.get(key) !== task) return { stale: true }
        throw error
      } finally {
        if (active.get(key) === task) active.delete(key)
      }
    })()
    return task.settled
  }

  return { run, cancel }
}
