// In-document find & replace (issue #19). Extracted verbatim in behavior from
// App.jsx (phase-2 refactor, US-2).
//
// Two backends, selected by what's mounted for the active tab:
//   - source <textarea> (plain-text / heavy-as-source / global source mode):
//     matches are character offsets into el.value; replace rewrites the string
//     bottom-up and writes it back through the uncontrolled-textarea contract
//     (el.value + liveContentRef + commitLive — see applyReplace).
//   - rich Crepe editor: matches are DOM Ranges painted via the CSS Custom
//     Highlight API (find.js); replace converts each Range to ProseMirror
//     positions via the view and inserts in one transaction.
//
// `replaceRef` is returned so the findbar's replace-input onChange can write it
// (applyReplace reads it); `find.replace` (state) mirrors it for the input value.
//
// Options:
//   editorHostRef — ref to the active rich editor's scroll container (richRoot)
//   sourceRef     — ref to the active source <textarea> (null in rich mode)
//   editorApis    — ref map of tab id → rich editor API (richView uses activeId)
//   activeId      — current active tab id (richView + source-replace target)
//   commitLive    — flush one tab's pending textarea edit (uncontrolled contract)
//   liveContentRef— ref map of tab id → latest uncommitted textarea value
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clearFindHighlights,
  findRangesInEl,
  paintFindHighlights,
  scrollRangeIntoView,
  matchIndices
} from '../find.js'

export function useFindReplace({ editorHostRef, sourceRef, editorApis, activeId, commitLive, liveContentRef }) {
  const [find, setFind] = useState({ open: false, query: '', matches: 0, active: 0, replace: '' })
  // Current match set: Range objects (rich editor) or character offsets (source).
  const findRangesRef = useRef([])
  const findQueryRef = useRef('')
  const replaceRef = useRef('')
  const activeIdxRef = useRef(-1)
  const findInputRef = useRef(null)
  const replaceInputRef = useRef(null)

  // Discriminate the active view: the source <textarea> sets sourceRef only when
  // it's mounted (source mode or a .txt doc); otherwise we're in the rich editor.
  const richRoot = () => editorHostRef.current?.querySelector('.ProseMirror') || null
  // The active rich editor's ProseMirror view (null in source/plain-text mode).
  // Used to turn a find DOM Range into document positions for replacement.
  const richView = () => editorApis.current[activeId]?.getView?.() || null

  // Run a fresh search for `query`, scoped to the editor content. `preferActive`
  // is the 0-based match index to land on (clamped) — used after a replace to
  // stay on the next match instead of jumping back to the first.
  const runFind = useCallback((query, preferActive = 0) => {
    const q = query ?? ''
    findQueryRef.current = q
    clearFindHighlights()
    findRangesRef.current = []
    if (sourceRef.current) {
      const el = sourceRef.current
      // Source textarea: live-count + SELECT the active match so find is visible.
      // A textarea can't use the CSS Highlight API, so an (inactive/gray)
      // selection is the only signal matches are being found — without it, source
      // find showed just a count and looked broken.
      const hits = matchIndices(el.value, q)
      findRangesRef.current = hits
      const i = hits.length ? Math.min(preferActive, hits.length - 1) : -1
      activeIdxRef.current = i
      if (i >= 0 && q) el.setSelectionRange(hits[i], hits[i] + q.length)
      setFind((f) => ({ ...f, matches: hits.length, active: i + 1 }))
      return
    }
    const root = richRoot()
    const ranges = q ? findRangesInEl(root, q) : []
    findRangesRef.current = ranges
    const i = ranges.length ? Math.min(preferActive, ranges.length - 1) : -1
    activeIdxRef.current = i
    if (ranges.length) {
      paintFindHighlights(ranges, i)
      scrollRangeIntoView(ranges[i], root.closest('.editor-scroll'))
    }
    setFind((f) => ({ ...f, matches: ranges.length, active: i + 1 }))
  }, [])

  // Move to the next / previous match (wrapping around).
  const stepFind = useCallback((backwards = false) => {
    const items = findRangesRef.current
    if (!items.length) return
    let i = activeIdxRef.current + (backwards ? -1 : 1)
    if (i < 0) i = items.length - 1
    if (i >= items.length) i = 0
    activeIdxRef.current = i
    if (sourceRef.current) {
      const el = sourceRef.current
      el.focus()
      el.setSelectionRange(items[i], items[i] + findQueryRef.current.length)
    } else {
      paintFindHighlights(items, i)
      scrollRangeIntoView(items[i], richRoot()?.closest('.editor-scroll'))
    }
    setFind((f) => ({ ...f, active: i + 1 }))
  }, [])

  const closeFind = useCallback(() => {
    clearFindHighlights()
    findRangesRef.current = []
    activeIdxRef.current = -1
    findQueryRef.current = ''
    // Keep the replace text across open/close (mirrors editors like VSCode).
    setFind((f) => ({ open: false, query: '', matches: 0, active: 0, replace: f.replace }))
  }, [])

  // Replace the active match (then land on the next), or every match. Works in
  // both the rich editor (DOM Range → ProseMirror positions, one transaction)
  // and the source textarea (offsets). Re-runs the search afterwards so counts
  // stay correct; for a single replace it keeps the cursor on the next match.
  const applyReplace = useCallback(
    (all = false) => {
      const q = findQueryRef.current
      const repl = replaceRef.current
      if (!q) return
      const i = Math.max(0, activeIdxRef.current)

      if (sourceRef.current) {
        const el = sourceRef.current
        const val = el.value
        const offsets = findRangesRef.current // number[] of match starts
        if (!offsets.length) return
        let next
        if (all) {
          // Bottom-up so earlier offsets stay valid as the string shifts.
          next = val
          for (const start of [...offsets].sort((a, b) => b - a)) {
            next = next.slice(0, start) + repl + next.slice(start + q.length)
          }
        } else {
          const start = offsets[i]
          next = val.slice(0, start) + repl + val.slice(start + q.length)
        }
        // Uncontrolled textarea: write the DOM directly + stash the value so
        // the debounced commit (and commitAllLive before save/close) persists
        // it. updateContent() alone wouldn't touch the DOM here, so the
        // replace would vanish and runFind would re-read the old value.
        el.value = next
        liveContentRef.current.set(activeId, next)
        commitLive(activeId)
        runFind(q, all ? 0 : i)
        return
      }

      const view = richView()
      const ranges = findRangesRef.current // Range[]
      if (!view || !ranges.length) return
      const tr = view.state.tr
      if (all) {
        // Convert every range to positions, then replace bottom-up in ONE
        // transaction so earlier positions don't shift mid-loop.
        const spans = ranges
          .map((r) => [view.posAtDOM(r.startContainer, r.startOffset), view.posAtDOM(r.endContainer, r.endOffset)])
          .sort((a, b) => b[0] - a[0])
        for (const [from, to] of spans) tr.insertText(repl, from, to)
      } else {
        const r = ranges[i]
        const from = view.posAtDOM(r.startContainer, r.startOffset)
        const to = view.posAtDOM(r.endContainer, r.endOffset)
        tr.insertText(repl, from, to)
      }
      view.dispatch(tr)
      view.focus()
      requestAnimationFrame(() => runFind(q, all ? 0 : i))
    },
    [activeId, runFind, commitLive]
  )

  // Re-run the search when switching tabs while the find bar is open, so ranges
  // point at the newly-visible document.
  useEffect(() => {
    if (find.open) runFind(findQueryRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // Open the find bar, pre-filled with the current selection (if any) — like VS
  // Code / Typora. No selection → keep the previous query.
  const openFind = useCallback((focusReplace = false) => {
    let sel = ''
    if (sourceRef.current) {
      const ta = sourceRef.current
      if (ta.selectionStart !== ta.selectionEnd) sel = ta.value.slice(ta.selectionStart, ta.selectionEnd)
    } else {
      const view = richView()
      const s = view?.state?.selection
      if (view && s && !s.empty) sel = view.state.doc.textBetween(s.from, s.to, '\n')
    }
    // Skip giant multi-line selections (would flood the input).
    if (sel.length > 200) sel = ''
    setFind((f) => ({ ...f, open: true, query: sel || f.query }))
    if (sel) runFind(sel)
    requestAnimationFrame(() => {
      const ref = focusReplace ? replaceInputRef : findInputRef
      ref.current?.focus()
      ref.current?.select()
    })
  }, [runFind, activeId])

  return { find, setFind, findInputRef, replaceInputRef, replaceRef, runFind, stepFind, closeFind, applyReplace, openFind }
}
