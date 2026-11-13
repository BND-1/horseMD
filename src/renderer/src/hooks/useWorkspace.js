import { useCallback, useEffect, useState } from 'react'
import {
  isAbsolutePath,
  isRestrictedPath,
  normalizePathKey,
  sanitizeFolderRoots
} from '../paths.js'

// Owns the renderer-side multi-root workspace. Open-document file watchers stay
// in useFileOps because they have a different lifecycle and dirty-content guard.
//
// isMobile relaxes the absolute-path guard on addFolder/sanitize: on Capacitor
// paths are opaque strings relative to the app's filesystem root (e.g. the
// library "HorseMD"), and the desktop-only chokidar watcher is a no-op there,
// so a relative root is safe. Without this the "添加文件夹" button silently
// does nothing on Android because openFolder() returns a relative library path.
export function useWorkspace({ initialFolderRoots, setSidebarOpen, isMobile = false }) {
  const [folderRoots, setFolderRoots] = useState(() => sanitizeFolderRoots(initialFolderRoots, isMobile))
  const folderRootsKey = folderRoots.join('\n')
  const [files, setFiles] = useState([])
  const [refreshNonce, setRefreshNonce] = useState(0)

  const bumpRefresh = useCallback(() => setRefreshNonce((value) => value + 1), [])

  const addFolder = useCallback(
    (dir) => {
      if (!dir) return
      // On mobile the library path is relative and the watcher is a no-op, so
      // only reject genuinely empty/dot paths; desktop keeps the full guard.
      if (!isMobile && (!isAbsolutePath(dir) || isRestrictedPath(dir))) return
      if (isMobile && (!dir || dir === '.' || dir === '..')) return
      setFolderRoots((prev) => sanitizeFolderRoots([...prev, dir], isMobile))
      setSidebarOpen(true)
    },
    [isMobile, setSidebarOpen]
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
