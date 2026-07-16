export function createLatestTaskRunner(worker) {
  const active = new Map()

  const cancel = (key) => {
    const task = active.get(key)
    if (!task) return false
    active.delete(key)
    task.controller.abort()
    return true
  }

  const run = async (key, payload) => {
    cancel(key)
    const controller = new AbortController()
    const task = { controller }
    active.set(key, task)
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
  }

  return { run, cancel }
}
