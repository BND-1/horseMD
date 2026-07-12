import { useCallback, useEffect, useState } from 'react'
import {
  isAbsolutePath,
  isRestrictedPath,
  normalizePathKey,
  sanitizeFolderRoots
} from '../paths.js'

// Owns the renderer-side multi-root workspace. Open-document file watchers stay
// in useFileOps because they have a different lifecycle and dirty-content guard.
export function useWorkspace({ initialFolderRoots, setSidebarOpen }) {
  const [folderRoots, setFolderRoots] = useState(() => sanitizeFolderRoots(initialFolderRoots))
  const folderRootsKey = folderRoots.join('\n')
  const [files, setFiles] = useState([])
  const [refreshNonce, setRefreshNonce] = useState(0)

  const bumpRefresh = useCallback(() => setRefreshNonce((value) => value + 1), [])

  const addFolder = useCallback(
    (dir) => {
      if (!dir || !isAbsolutePath(dir) || isRestrictedPath(dir)) return
      setFolderRoots((prev) => sanitizeFolderRoots([...prev, dir]))
      setSidebarOpen(true)
    },
    [setSidebarOpen]
  )

  const removeFolder = useCallback((rootPath) => {
    const target = normalizePathKey(rootPath)
    setFolderRoots((prev) => prev.filter((root) => normalizePathKey(root) !== target))
  }, [])

  const openFolder = useCallback(async () => {
    const dir = await window.api.openFolder()
    if (dir) addFolder(dir)
  }, [addFolder])

  const listAllRoots = useCallback(() => {
    const roots = folderRootsKey ? folderRootsKey.split('\n') : []
    if (!roots.length) {
      setFiles([])
      return Promise.resolve()
    }
    return Promise.all(roots.map((root) => window.api.listFiles(root).catch(() => []))).then((lists) =>
      setFiles(lists.flat())
    )
  }, [folderRootsKey])

  useEffect(() => {
    const roots = folderRootsKey ? folderRootsKey.split('\n') : []
    for (const root of roots) window.api.watchStart(root)
    listAllRoots()
    return () => {
      for (const root of roots) window.api.watchStop(root)
    }
    // listAllRoots is keyed by the same stable root string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderRootsKey])

  useEffect(() => {
    const off = window.api.onWatchChanged(() => {
      bumpRefresh()
      listAllRoots()
    })
    return off
  }, [listAllRoots, bumpRefresh])

  return {
    openFolder,
    folderRoots,
    addFolder,
    removeFolder,
    files,
    refreshNonce,
    bumpRefresh
  }
}
