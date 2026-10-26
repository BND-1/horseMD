import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// Local sync-workspace registration is deliberately separate from useWorkspace:
// the latter owns visible multi-root file trees and watchers, while this hook
// owns only the folders a user explicitly opted into for future cloud sync.
export function useSyncWorkspaces({ folderRoots, addFolder }) {
  const supported = window.api.capabilities?.cloudSync !== false
  const [registered, setRegistered] = useState([])
  const [connections, setConnections] = useState([])
  const [loading, setLoading] = useState(supported)
  const [busyRoot, setBusyRoot] = useState(null)
  // Live progress of the running sync: { rootPath, completed, total, waiting }.
  // `waiting` is set while the cloud service throttles uploads.
  const [progress, setProgress] = useState(null)
  // Folders whose sync this window started and is still awaiting (#161):
  // a second start is refused here, and only the call that started a sync
  // clears its busy state — a refused call used to clear it while the first
  // sync kept running, so the page showed "done" and invited another click.
  const runningRef = useRef(new Set())
  const keyOf = (rootPath) => String(rootPath || '').replace(/[\\/]+$/, '').toLowerCase()

  // A window opened while a sync runs (macOS keeps the app alive with no
  // window) shows it as running; its progress still arrives here.
  useEffect(() => {
    let cancelled = false
    window.api.syncStatus?.().then((status) => {
      const rootPath = status?.running?.[0]
      if (!cancelled && rootPath && !runningRef.current.size) setBusyRoot(rootPath)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => window.api.onSyncProgress?.((event) => {
    if (!event?.rootPath) return
    if (event.done) {
      setProgress(null)
      // A sync started by an earlier window has no awaiting call here.
      if (!runningRef.current.has(keyOf(event.rootPath))) {
        setBusyRoot((current) => (keyOf(current) === keyOf(event.rootPath) ? null : current))
      }
      return
    }
    setProgress((current) => {
      const base = current?.rootPath === event.rootPath ? current : { rootPath: event.rootPath, completed: 0, total: 0, waiting: null, paused: false, stopping: false }
      if (event.control) {
        const paused = event.control.paused ?? (event.control.stopping ? false : base.paused)
        return {
          ...base,
          paused,
          // Requested → holding once the file in flight has finished.
          holding: paused ? (event.control.holding ?? base.holding ?? false) : false,
          stopping: event.control.stopping === true || base.stopping
        }
      }
      if (event.throttle) {
        const { locked, resumed, resumeAt, waitedMs } = event.throttle
        if (resumed) return { ...base, waiting: null }
        return locked ? { ...base, waiting: { resumeAt, waitedMs, receivedAt: Date.now() } } : base
      }
      return { ...base, completed: event.completed ?? base.completed, total: event.total ?? base.total, waiting: null }
    })
  }), [])

  const refresh = useCallback(async () => {
    if (!supported || !window.api.syncListWorkspaces) {
      setRegistered([])
      setLoading(false)
      return []
    }
    try {
      const [entries, connectionItems] = await Promise.all([
        window.api.syncListWorkspaces(),
        window.api.syncListConnections?.() || []
      ])
      setRegistered(Array.isArray(entries) ? entries : [])
      setConnections(Array.isArray(connectionItems) ? connectionItems : [])
      return entries
    } finally {
      setLoading(false)
    }
  }, [supported])

  useEffect(() => {
    refresh().catch(() => setLoading(false))
  }, [refresh])

  const enableFolder = useCallback(async (rootPath) => {
    if (!supported || !window.api.syncAdoptWorkspace) throw new Error('当前平台暂不支持云同步。')
    const entry = await window.api.syncAdoptWorkspace(rootPath)
    addFolder(rootPath)
    await refresh()
    return entry
  }, [addFolder, refresh, supported])

  const addSyncFolder = useCallback(async () => {
    const rootPath = await window.api.openFolder()
    if (!rootPath) return null
    return enableFolder(rootPath)
  }, [enableFolder])

  const removeFolder = useCallback(async (rootPath) => {
    if (!supported || !window.api.syncRemoveWorkspace) return false
    await window.api.syncRemoveWorkspace(rootPath)
    await refresh()
    return true
  }, [refresh, supported])

  const addWebDavConnection = useCallback(async (config) => {
    const connection = await window.api.syncAddWebDavConnection(config)
    await refresh()
    return connection
  }, [refresh])

  const addS3Connection = useCallback(async (config) => {
    const connection = await window.api.syncAddS3Connection(config)
    await refresh()
    return connection
  }, [refresh])

  const updateConnection = useCallback(async (connectionId, config) => {
    if (!window.api.syncUpdateConnection) throw new Error('当前平台暂不支持云同步。')
    const connection = await window.api.syncUpdateConnection(connectionId, config)
    await refresh()
    return connection
  }, [refresh])

  const removeConnection = useCallback(async (connectionId) => {
    const removed = await window.api.syncRemoveConnection(connectionId)
    await refresh()
    return removed
  }, [refresh])

  const testConnection = useCallback(async (connectionId) => {
    if (!window.api.syncTestConnection) throw new Error('当前平台暂不支持云同步。')
    return window.api.syncTestConnection(connectionId)
  }, [])

  const bindConnection = useCallback(async (rootPath, connectionId) => {
    setBusyRoot(rootPath)
    try {
      const entry = await window.api.syncBindWorkspaceConnection(rootPath, connectionId)
      await refresh()
      return entry
    } finally {
      setBusyRoot(null)
    }
  }, [refresh])

  const preview = useCallback(async (rootPath, strategy = 'merge') => window.api.syncPreview(rootPath, strategy), [])
  const listRemoteWorkspaces = useCallback(
    async (connectionId) => window.api.syncListRemoteWorkspaces(connectionId),
    []
  )
  const joinWorkspace = useCallback(async (rootPath, connectionId, workspaceId) => {
    setBusyRoot(rootPath)
    try {
      const entry = await window.api.syncJoinWorkspace(rootPath, connectionId, workspaceId)
      await refresh()
      return entry
    } finally {
      setBusyRoot(null)
    }
  }, [refresh])
  // options.safeOnly: automatic sync — main re-plans and refuses deletions /
  // conflicts ({ needsConfirmation }); nothing to do → { idle }.
  const run = useCallback(async (rootPath, strategy = 'merge', options = undefined) => {
    const key = keyOf(rootPath)
    if (runningRef.current.has(key)) throw new Error('这个文件夹正在同步，请等它完成，或先点「停止」。')
    runningRef.current.add(key)
    setBusyRoot(rootPath)
    try {
      return await window.api.syncRun(rootPath, strategy, options)
    } finally {
      runningRef.current.delete(key)
      setBusyRoot((current) => (keyOf(current) === key ? null : current))
      setProgress((current) => (keyOf(current?.rootPath) === key ? null : current))
    }
  }, [])

  // 'pause' | 'resume' | 'stop' for the running sync of `rootPath`.
  const controlSync = useCallback(async (rootPath, action) => window.api.syncControl?.(rootPath, action), [])

  const registeredByPath = useMemo(
    () => new Map(registered.map((entry) => [entry.rootPath.replace(/[\\/]+$/, '').toLowerCase(), entry])),
    [registered]
  )

  return {
    supported,
    loading,
    registered,
    connections,
    busyRoot,
    progress,
    controlSync,
    registeredByPath,
    refresh,
    enableFolder,
    addSyncFolder,
    removeFolder,
    addWebDavConnection,
    addS3Connection,
    updateConnection,
    removeConnection,
    testConnection,
    bindConnection,
    preview,
    listRemoteWorkspaces,
    joinWorkspace,
    run
  }
}
