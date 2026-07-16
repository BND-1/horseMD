const DEFAULT_READY_TIMEOUT_MS = 30000

export function createEditorApiRegistry({ timeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
  const ref = { current: {} }
  const waiters = new Map()

  const register = (id, api) => {
    ref.current[id] = api
    const pending = waiters.get(id)
    if (!pending) return
    waiters.delete(id)
    for (const finish of pending) finish(api)
  }

  const waitFor = (id) => {
    const current = ref.current[id]
    if (current) return Promise.resolve(current)
    return new Promise((resolve) => {
      const pending = waiters.get(id) || new Set()
      let timer = null
      const finish = (api) => {
        clearTimeout(timer)
        pending.delete(finish)
        if (!pending.size) waiters.delete(id)
        resolve(api)
      }
      pending.add(finish)
      waiters.set(id, pending)
      timer = setTimeout(() => finish(null), timeoutMs)
    })
  }

  const prune = (liveIds) => {
    const live = liveIds instanceof Set ? liveIds : new Set(liveIds)
    for (const id of Object.keys(ref.current)) {
      if (!live.has(id)) delete ref.current[id]
    }
    for (const [id, pending] of waiters) {
      if (live.has(id)) continue
      waiters.delete(id)
      for (const finish of pending) finish(null)
    }
  }

  const dispose = () => {
    ref.current = {}
    for (const pending of waiters.values()) {
      for (const finish of pending) finish(null)
    }
    waiters.clear()
  }

  return { ref, register, waitFor, prune, dispose }
}
