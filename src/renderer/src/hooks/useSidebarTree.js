import { useCallback, useEffect, useRef, useState } from 'react'
import { dirName as parentDir, normalizePathKey } from '../paths.js'

export function useSidebarTree({ folderRoots, activePath, refreshNonce }) {
  const [childrenMap, setChildrenMap] = useState({})
  const [expanded, setExpanded] = useState(() => new Set())
  const childrenRef = useRef(childrenMap)
  childrenRef.current = childrenMap
  const activeRowRef = useRef(null)
  const lastScrolledRef = useRef(null)
  const folderRootsKey = folderRoots.join('\n')

  const loadDir = useCallback(async (dir) => {
    const nodes = await window.api.readDir(dir)
    setChildrenMap((current) => ({ ...current, [dir]: nodes }))
    return nodes
  }, [])

  useEffect(() => {
    setChildrenMap({})
    const roots = folderRootsKey ? folderRootsKey.split('\n') : []
    setExpanded(new Set(roots))
    roots.forEach((root) => loadDir(root))
  }, [folderRootsKey, loadDir])

  useEffect(() => {
    if (refreshNonce === 0) return
    Object.keys(childrenRef.current).forEach((dir) => loadDir(dir))
  }, [refreshNonce, loadDir])

  // Reveal an active file opened by the tree, recents, search, or a link.
  useEffect(() => {
    if (!activePath || !folderRoots.length) return
    const activeKey = normalizePathKey(activePath)
    const root = folderRoots
      .map(normalizePathKey)
      .sort((a, b) => b.length - a.length)
      .find((candidate) => activeKey === candidate || activeKey.startsWith(candidate + '/'))
    if (!root) return

    let cancelled = false
    ;(async () => {
      const ancestors = []
      let dir = parentDir(activePath)
      let guard = 0
      while (dir && guard++ < 50) {
        ancestors.unshift(dir)
        if (normalizePathKey(dir) === root) break
        const up = parentDir(dir)
        if (!up || up === dir) break
        dir = up
      }
      for (const ancestor of ancestors) {
        if (cancelled) return
        if (!childrenRef.current[ancestor]) await loadDir(ancestor)
      }
      if (cancelled) return
      setExpanded((current) => {
        const next = new Set(current)
        ancestors.forEach((ancestor) => next.add(ancestor))
        return next
      })
    })()

    return () => {
      cancelled = true
    }
  }, [activePath, folderRootsKey, loadDir])

  useEffect(() => {
    if (!activePath) return
    if (activeRowRef.current && lastScrolledRef.current !== activePath) {
      activeRowRef.current.scrollIntoView({ block: 'nearest' })
      lastScrolledRef.current = activePath
    }
  }, [activePath, expanded, childrenMap])

  const toggle = useCallback(async (node) => {
    if (expanded.has(node.path)) {
      setExpanded((current) => {
        const next = new Set(current)
        next.delete(node.path)
        return next
      })
      return
    }
    if (!childrenRef.current[node.path]) await loadDir(node.path)
    setExpanded((current) => new Set(current).add(node.path))
  }, [expanded, loadDir])

  return {
    childrenMap,
    expanded,
    setExpanded,
    loadDir,
    toggle,
    activeRowRef
  }
}
