// Workspace-wide search state (issue #120: 全局搜索，空格分隔多关键词 AND)。
//
// Two halves:
//  - search: debounced `search:workspace` IPC over the workspace folder
//    roots, with a monotonic request id so stale responses are dropped
//    (latest-request-only, same contract as the PDF/HTML preview pipelines).
//  - jumpToMatch: open the clicked file and land the in-document FindBar on
//    the clicked occurrence. Source/plain-text surfaces jump by occurrence
//    index (globalsearch-core computes occIdx with find.js matchIndices
//    semantics, so the index is exact); rich editors first anchor the caret
//    in the matching block via restoreMarkdownOffset, then pick the nearest
//    highlighted range at/before the caret.
import { useCallback, useEffect, useRef, useState } from 'react'
import { findRangesInEl } from '../find.js'

const SEARCH_DEBOUNCE_MS = 250

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Untitled/scratch tabs carry `path: null` — tolerate both null and undefined.
const normalizePath = (path) => (path || '').replace(/\\/g, '/')

// Last highlighted range at/before the restored caret — lands the FindBar on
// (or just before) the clicked occurrence when DOM ranges don't map 1:1 to
// raw source occurrences.
function nearestRichMatchIndex({ api, editorHostRef, term }) {
  try {
    const root = editorHostRef.current?.querySelector('.ProseMirror')
    const view = api.getView?.()
    if (!root || !view) return 0
    const ranges = findRangesInEl(root, term)
    if (!ranges.length) return 0
    const caret = view.state.selection.from
    let index = 0
    for (let i = 0; i < ranges.length; i += 1) {
      const start = view.posAtDOM(ranges[i].startContainer, ranges[i].startOffset)
      if (start <= caret) index = i
      else break
    }
    return index
  } catch {
    return 0
  }
}

export function useGlobalSearch({
  roots,
  openPaths,
  tabsRef,
  editorApis,
  editorHostRef,
  waitForEditorApi,
  setFind,
  runFind,
  findInputRef
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState({ status: 'idle', files: [], truncated: false, matchTotal: 0 })
  const requestIdRef = useRef(0)
  // Stable dep (the workspace convention: join('\n') instead of array identity).
  const rootsKey = Array.isArray(roots) ? roots.join('\n') : ''

  useEffect(() => {
    if (!query.trim() || !rootsKey) {
      requestIdRef.current += 1
      setResults((prev) =>
        prev.status === 'idle' && prev.files.length === 0
          ? prev
          : { status: 'idle', files: [], truncated: false, matchTotal: 0 }
      )
      return undefined
    }
    const id = ++requestIdRef.current
    setResults((prev) => ({ ...prev, status: 'loading' }))
    const timer = setTimeout(() => {
      window.api
        .searchWorkspace({ roots: rootsKey.split('\n'), query })
        .then((res) => {
          if (id !== requestIdRef.current) return
          setResults({
            status: 'done',
            files: Array.isArray(res?.files) ? res.files : [],
            truncated: Boolean(res?.truncated),
            matchTotal: Number(res?.matchTotal) || 0
          })
        })
        .catch(() => {
          if (id === requestIdRef.current) setResults((prev) => ({ ...prev, status: 'error' }))
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, rootsKey])

  const jumpToMatch = useCallback(
    async (file, match) => {
      await openPaths([file.path])
      const wanted = normalizePath(file.path)
      const tab = tabsRef.current.find((t) => normalizePath(t.path) === wanted)
      if (!tab) return
      const term = match.term
      let preferIndex = 0

      // Let the newly-activated pane mount: poll briefly for EITHER surface.
      // A visible source textarea (plain .txt / heavy doc / per-tab source
      // mode) means find runs on raw file bytes — occIdx is exact there. A
      // rich editor registers its tab API on ready. Plain tabs never
      // register an API, so the editor wait must stay bounded.
      let sourceVisible = false
      for (let i = 0; i < 20 && !sourceVisible && !editorApis.current[tab.id]; i += 1) {
        await sleep(100)
        sourceVisible =
          typeof document !== 'undefined' &&
          [...document.querySelectorAll('textarea.source-editor')].some((el) => el.offsetParent)
      }
      if (!sourceVisible && !editorApis.current[tab.id]) {
        // ~2s without either surface: a slow rich editor is still worth
        // waiting for, but a plain tab would block for the registry's 30s
        // timeout — cap it and fall through (runFind's late-source re-check
        // recovers a textarea that mounts after this point).
        await Promise.race([waitForEditorApi(tab.id).catch(() => {}), sleep(1500)])
      }
      if (sourceVisible) {
        preferIndex = Number.isInteger(match.occIdx) ? Math.max(0, match.occIdx) : 0
      } else {
        const api = editorApis.current[tab.id]
        if (api?.restoreMarkdownOffset && Number.isInteger(match.fileOffset)) {
          try {
            api.restoreMarkdownOffset(match.fileOffset, false)
          } catch {
            // Keep index 0 — the FindBar still highlights every occurrence.
          }
          preferIndex = nearestRichMatchIndex({ api, editorHostRef, term })
        }
      }

      setFind((f) => ({ ...f, open: true, query: term }))
      runFind(term, preferIndex)
      requestAnimationFrame(() => findInputRef.current?.focus())
    },
    [openPaths, tabsRef, editorApis, editorHostRef, waitForEditorApi, setFind, runFind, findInputRef]
  )

  return { query, setQuery, results, jumpToMatch }
}
