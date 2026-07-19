import { useCallback, useEffect, useMemo, useState } from 'react'

// Local sync-workspace registration is deliberately separate from useWorkspace:
// the latter owns visible multi-root file trees and watchers, while this hook
// owns only the folders a user explicitly opted into for future cloud sync.
export function useSyncWorkspaces({ folderRoots, addFolder }) {
  const supported = window.api.capabilities?.cloudSync !== false
  const [registered, setRegistered] = useState([])
  const [connections, setConnections] = useState([])
  const [loading, setLoading] = useState(supported)
  const [busyRoot, setBusyRoot] = useState(null)

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
  const run = useCallback(async (rootPath, strategy = 'merge') => {
    setBusyRoot(rootPath)
    try { return await window.api.syncRun(rootPath, strategy) } finally { setBusyRoot(null) }
  }, [])

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
