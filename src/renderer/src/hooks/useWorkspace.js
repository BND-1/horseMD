import { useCallback, useEffect, useState } from 'react'
import {
  isAbsolutePath,
  isRestrictedPath,
  normalizePathKey,
  sanitizeFolderRoots
} from '../paths.js'

// Owns the renderer-side multi-root workspace. Open-document file watchers stay
// in useFileOps because they have a different lifecycle and dirty-content guard.
// On a phone the app's own folder (window.api.libraryRoot, where new
// documents are saved) is always the first root, like iA Writer's "On My
// iPhone": 添加文件夹 then picks other folders through the system picker.
const withLibrary = (roots) => {
  const lib = window.api?.libraryRoot
  return lib && !roots.includes(lib) ? [lib, ...roots] : roots
}

// `watchFolders` false (a secondary window, tab tear-off): the folders are
// still listed (command palette) but not watched — the main window owns the
// workspace and its watchers.
export function useWorkspace({ initialFolderRoots, setSidebarOpen, watchFolders = true }) {
  const [folderRoots, setFolderRoots] = useState(() => withLibrary(sanitizeFolderRoots(initialFolderRoots)))
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
    setFolderRoots((prev) => withLibrary(prev.filter((root) => normalizePathKey(root) !== target)))
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
    if (watchFolders) for (const root of roots) window.api.watchStart(root)
    listAllRoots()
    return () => {
      if (watchFolders) for (const root of roots) window.api.watchStop(root)
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
