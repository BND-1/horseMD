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
// Match options (VSCode-style): matchCase, wholeWord, regex (multiline via \n
// in the query or the regex `m` flag) and inSelection. They live in
// findOptsRef so they survive open/close like the replace text; regex and
// wholeWord are mutually exclusive. inSelection captures the editor selection
// at toggle time — a DOM Range for rich mode (live across transactions) and
// character offsets for the textarea (adjusted after each replace).
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
import { applyTextareaSourceEdit } from '../source-text-fidelity.js'
import {
  clearFindHighlights,
  clearSourceFindHighlight,
  compileFindMatcher,
  expandReplacement,
  findRangesInEl,
  paintFindHighlights,
  revealSourceFindMatch,
  scrollRangeIntoView,
  matchIndices
} from '../find.js'

const FIND_OPTION_KEYS = ['matchCase', 'wholeWord', 'regex', 'inSelection']

export function useFindReplace({ editorHostRef, sourceRef, editorApis, activeId, viewModeKey, sourceFindActive = true, commitLive, liveContentRef }) {
  const [find, setFind] = useState({
    open: false, query: '', matches: 0, active: 0, replace: '',
    matchCase: false, wholeWord: false, regex: false, inSelection: false, regexError: false
  })
  // Current match set: Range objects (rich editor) or character offsets (source).
  const findRangesRef = useRef([])
  // Concatenated scan text for the rich backend — regex replacement templates
  // ($1, $&) must replay against the exact matched text, which a DOM Range's
  // toString() cannot reconstruct across block boundaries.
  const findMatchTextsRef = useRef([])
  const findQueryRef = useRef('')
  const replaceRef = useRef('')
  const findOptsRef = useRef({ matchCase: false, wholeWord: false, regex: false, inSelection: false })
  // { kind: 'source', start, end } or { kind: 'rich', range: DOMRange }
  const findSelectionRef = useRef(null)
  const activeIdxRef = useRef(-1)
  const findInputRef = useRef(null)
  const replaceInputRef = useRef(null)
  const sourceFindTextareaRef = useRef(null)
  const findContextRef = useRef({ activeId, viewModeKey })
  // A source + rich split has two visible surfaces. The most recently focused
  // one is the find target; ordinary source/plain-text views keep this true.
  const sourceFindActiveRef = useRef(sourceFindActive)
  sourceFindActiveRef.current = sourceFindActive

  // Discriminate the active view: the source <textarea> sets sourceRef only when
  // it's mounted (source mode or a .txt doc); otherwise we're in the rich editor.
  const richRoot = () => editorHostRef.current?.querySelector('.ProseMirror') || null
  const activeSourceTextarea = () => {
    if (!sourceFindActiveRef.current) return null
    const isVisibleSource = (el) => {
      if (!el?.isConnected) return false
      const rect = el.getBoundingClientRect()
      const style = el.ownerDocument.defaultView.getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const doc = typeof document !== 'undefined' ? document : editorHostRef.current?.ownerDocument || sourceRef.current?.ownerDocument || null
    const visible = doc ? [...doc.querySelectorAll('textarea.source-editor')].find(isVisibleSource) : null
    if (visible) {
      sourceRef.current = visible
      return visible
    }
    const current = sourceRef.current
    if (isVisibleSource(current)) return current
    return null
  }
  // The active rich editor's ProseMirror view (null in source/plain-text mode).
  // Used to turn a find DOM Range into document positions for replacement.
  const richView = () => editorApis.current[activeId]?.getView?.() || null

  // Snapshot the editor selection as the find-in-selection window. Returns
  // null when there is nothing (usable) selected.
  const captureFindSelection = () => {
    const sourceEl = activeSourceTextarea()
    if (sourceEl) {
      if (sourceEl.selectionStart !== sourceEl.selectionEnd) {
        return { kind: 'source', start: sourceEl.selectionStart, end: sourceEl.selectionEnd }
      }
      return null
    }
    const root = richRoot()
    if (root && typeof document !== 'undefined') {
      // Prefer ProseMirror's own selection (what a focused editor maintains);
      // fall back to the DOM selection for windows whose state sync lagged
      // (e.g. an unfocused/background window still showing a selection).
      const view = richView()
      const sel = view?.state?.selection
      const fromDom = (node, offset) => {
        try {
          const other = view.domAtPos(sel.to)
          const range = document.createRange()
          range.setStart(node, offset)
          range.setEnd(other.node, other.offset)
          if (!range.collapsed && root.contains(range.commonAncestorContainer)) return range
        } catch {
          // boundary mismatch — fall through to the DOM selection
        }
        return null
      }
      if (view && sel && !sel.empty) {
        let a
        try { a = view.domAtPos(sel.from) } catch { a = null }
        if (a) {
          const range = fromDom(a.node, a.offset)
          if (range) return { kind: 'rich', range }
        }
      }
      const dom = document.getSelection()
      if (dom && !dom.isCollapsed && dom.rangeCount) {
        const range = dom.getRangeAt(0)
        if (root.contains(range.commonAncestorContainer) && !range.collapsed) {
          return { kind: 'rich', range }
        }
      }
    }
    return null
  }

  // A captured selection can go stale (document shortened, DOM rebuilt). Callers
  // use this to decide whether the capture still scopes the current surface.
  const findSelectionUsable = (capture, root, sourceEl) => {
    if (!capture) return false
    if (capture.kind === 'source') {
      return !!sourceEl && capture.end > capture.start && capture.end <= sourceEl.value.length
    }
    if (capture.kind === 'rich') {
      return !!root && !capture.range.collapsed && !!capture.range.startContainer?.isConnected && root.contains(capture.range.startContainer)
    }
    return false
  }

  const runSourceFind = (el, q, preferActive = 0, opts = {}) => {
    let hits = matchIndices(el.value, q, opts)
    const sel = findSelectionRef.current
    if (opts.inSelection && sel?.kind === 'source') {
      hits = hits.filter((hit) => hit.start >= sel.start && hit.end <= sel.end)
    }
    findRangesRef.current = hits
    findMatchTextsRef.current = []
    const i = hits.length ? Math.min(preferActive, hits.length - 1) : -1
    activeIdxRef.current = i
    if (i >= 0 && q) {
      revealSourceFindMatch(el, hits[i].start, hits[i].end)
      sourceFindTextareaRef.current = el
    }
    setFind((f) => ({ ...f, matches: hits.length, active: i + 1 }))
  }

  // Run a fresh search for `query`, scoped to the editor content. `preferActive`
  // is the 0-based match index to land on (clamped) — used after a replace to
  // stay on the next match instead of jumping back to the first.
  const runFind = useCallback((query, preferActive = 0) => {
    const q = query ?? ''
    findQueryRef.current = q
    let opts = findOptsRef.current
    const regexError = opts.regex && !!q && compileFindMatcher(q, opts).error === 'invalid-regex'
    clearFindHighlights()
    const sourceEl = activeSourceTextarea()
    clearSourceFindHighlight(sourceFindTextareaRef.current || sourceEl)
    sourceFindTextareaRef.current = null
    findRangesRef.current = []
    findMatchTextsRef.current = []
    // Drop an unusable find-in-selection capture instead of silently searching
    // the whole document (the user believes matches are scoped).
    if (opts.inSelection && !findSelectionUsable(findSelectionRef.current, richRoot(), sourceEl)) {
      findSelectionRef.current = null
      opts = { ...opts, inSelection: false }
      findOptsRef.current = opts
      setFind((f) => ({ ...f, inSelection: false }))
    }
    if (sourceEl) {
      // Source textarea: live-count + SELECT/reveal the active match. Textarea
      // selections are not reliably visible while the FindBar keeps focus, so a
      // lightweight overlay paints the current match without stealing focus.
      if (!regexError) runSourceFind(sourceEl, q, preferActive, opts)
      else setFind((f) => ({ ...f, matches: 0, active: 0, regexError }))
      requestAnimationFrame(() => {
        const latestSourceEl = activeSourceTextarea()
        if (latestSourceEl && findQueryRef.current === q && !regexError) runSourceFind(latestSourceEl, q, preferActive, opts)
      })
      if (regexError) return
      return
    }
    requestAnimationFrame(() => {
      const lateSourceEl = activeSourceTextarea()
      if (lateSourceEl && findQueryRef.current === q && !regexError) runSourceFind(lateSourceEl, q, preferActive, opts)
    })
    if (regexError) {
      setFind((f) => ({ ...f, matches: 0, active: 0, regexError }))
      return
    }
    const root = richRoot()
    const clamp = opts.inSelection && findSelectionRef.current?.kind === 'rich' ? findSelectionRef.current.range : null
    const { ranges, matchTexts } = q ? findRangesInEl(root, q, opts, clamp) : { ranges: [], matchTexts: [] }
    findRangesRef.current = ranges
    findMatchTextsRef.current = matchTexts
    const i = ranges.length ? Math.min(preferActive, ranges.length - 1) : -1
    activeIdxRef.current = i
    if (ranges.length) {
      paintFindHighlights(ranges, i)
      scrollRangeIntoView(ranges[i], root.closest('.editor-scroll'))
    }
    setFind((f) => ({ ...f, matches: ranges.length, active: i + 1, regexError }))
  }, [])

  // Move to the next / previous match (wrapping around).
  const stepFind = useCallback((backwards = false) => {
    const items = findRangesRef.current
    if (!items.length) return
    let i = activeIdxRef.current + (backwards ? -1 : 1)
    if (i < 0) i = items.length - 1
    if (i >= items.length) i = 0
    activeIdxRef.current = i
    const sourceEl = activeSourceTextarea()
    if (sourceEl) {
      const el = sourceEl
      revealSourceFindMatch(el, items[i].start, items[i].end)
      sourceFindTextareaRef.current = el
    } else {
      paintFindHighlights(items, i)
      scrollRangeIntoView(items[i], richRoot()?.closest('.editor-scroll'))
    }
    setFind((f) => ({ ...f, active: i + 1 }))
  }, [])

  const closeFind = useCallback(() => {
    clearFindHighlights()
    clearSourceFindHighlight(sourceFindTextareaRef.current || activeSourceTextarea())
    sourceFindTextareaRef.current = null
    findRangesRef.current = []
    findMatchTextsRef.current = []
    activeIdxRef.current = -1
    findQueryRef.current = ''
    // Keep the replace text and the match options across open/close (mirrors
    // editors like VSCode). The selection capture stays live for rich mode;
    // runFind re-validates it on the next search.
    setFind((f) => ({ ...f, open: false, query: '', matches: 0, active: 0, regexError: false, replace: f.replace }))
  }, [])

  // Toggle one match option (matchCase / wholeWord / regex / inSelection) and
  // re-run the search. regex and wholeWord are mutually exclusive; enabling
  // inSelection snapshots the current editor selection as the search window.
  const setFindOption = useCallback((key) => {
    if (!FIND_OPTION_KEYS.includes(key)) return
    const opts = findOptsRef.current
    let next
    if (key === 'inSelection') {
      if (opts.inSelection) {
        findSelectionRef.current = null
        next = { ...opts, inSelection: false }
      } else {
        const captured = captureFindSelection()
        if (!captured) return
        findSelectionRef.current = captured
        next = { ...opts, inSelection: true }
      }
    } else {
      const value = !opts[key]
      next = { ...opts, [key]: value }
      if (value && key === 'regex') next.wholeWord = false
      if (value && key === 'wholeWord') next.regex = false
    }
    findOptsRef.current = next
    setFind((f) => ({ ...f, ...next }))
    runFind(findQueryRef.current, Math.max(0, activeIdxRef.current))
  }, [runFind])

  // Replace the active match (then land on the next), or every match. Works in
  // both the rich editor (DOM Range → ProseMirror positions, one transaction)
  // and the source textarea (offsets). Regex mode applies the replacement as a
  // template ($1…$9, $&, $$) against each matched text. Re-runs the search
  // afterwards so counts stay correct; for a single replace it keeps the cursor
  // on the next match.
  const applyReplace = useCallback(
    (all = false) => {
      const q = findQueryRef.current
      const repl = replaceRef.current
      const opts = findOptsRef.current
      if (!q) return
      if (opts.regex && compileFindMatcher(q, opts).error) return
      const i = Math.max(0, activeIdxRef.current)

      const sourceEl = activeSourceTextarea()
      if (sourceEl) {
        const el = sourceEl
        const val = el.value
        const hits = findRangesRef.current // {start,end}[] match spans
        if (!hits.length) return
        const sel = opts.inSelection && findSelectionRef.current?.kind === 'source' ? findSelectionRef.current : null
        let selDelta = 0
        let next = val
        const applyHit = (hit) => {
          const replacement = expandReplacement(next.slice(hit.start, hit.end), repl, q, opts)
          next = next.slice(0, hit.start) + replacement + next.slice(hit.end)
          if (sel && hit.start >= sel.start) selDelta += replacement.length - (hit.end - hit.start)
        }
        // Bottom-up so earlier offsets stay valid as the string shifts.
        if (all) for (const hit of [...hits].sort((a, b) => b.start - a.start)) applyHit(hit)
        else applyHit(hits[i])
        if (sel) findSelectionRef.current = { kind: 'source', start: sel.start, end: Math.max(sel.start + 1, sel.end + selDelta) }
        // Uncontrolled textarea: write the DOM directly + stash the value so
        // the debounced commit (and commitAllLive before save/close) persists
        // it. updateContent() alone wouldn't touch the DOM here, so the
        // replace would vanish and runFind would re-read the old value.
        liveContentRef.current.set(activeId, applyTextareaSourceEdit(el, next))
        commitLive(activeId)
        runFind(q, all ? 0 : i)
        return
      }

      const view = richView()
      const ranges = findRangesRef.current // Range[]
      if (!view || !ranges.length) return
      const texts = findMatchTextsRef.current
      const tr = view.state.tr
      if (all) {
        // Convert every range to positions, then replace bottom-up in ONE
        // transaction so earlier positions don't shift mid-loop.
        const spans = ranges
          .map((r) => [view.posAtDOM(r.startContainer, r.startOffset), view.posAtDOM(r.endContainer, r.endOffset)])
          .sort((a, b) => b[0] - a[0])
        spans.forEach(([from, to], idx) => {
          const matched = texts[ranges.length - 1 - idx] || ''
          tr.insertText(expandReplacement(matched, repl, q, opts), from, to)
        })
      } else {
        const r = ranges[i]
        const from = view.posAtDOM(r.startContainer, r.startOffset)
        const to = view.posAtDOM(r.endContainer, r.endOffset)
        tr.insertText(expandReplacement(texts[i] || r.toString(), repl, q, opts), from, to)
      }
      view.dispatch(tr)
      view.focus()
      requestAnimationFrame(() => runFind(q, all ? 0 : i))
    },
    [activeId, runFind, commitLive]
  )

  // DOM Ranges (rich) and numeric offsets (source) are different backends. Any
  // tab or view-mode switch must rebuild the cache for the newly-visible view.
  // Preserve the active result while toggling rich/source in the same document;
  // a different tab starts from its first result. The find-in-selection window
  // belongs to the surface it was captured on, so a switch drops it.
  useEffect(() => {
    const previous = findContextRef.current
    findContextRef.current = { activeId, viewModeKey }
    if (find.open) {
      if (findOptsRef.current.inSelection) {
        findSelectionRef.current = null
        findOptsRef.current = { ...findOptsRef.current, inSelection: false }
        setFind((f) => ({ ...f, inSelection: false }))
      }
      const preferActive = previous.activeId === activeId ? Math.max(0, activeIdxRef.current) : 0
      runFind(findQueryRef.current, preferActive)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, viewModeKey])

  // Open the find bar, pre-filled with the current selection (if any) — like VS
  // Code / Typora. No selection → keep the previous query. A multiline
  // selection instead activates find-in-selection (VSCode parity): it becomes
  // the search window rather than flooding the query input.
  const openFind = useCallback((focusReplace = false) => {
    let sel = ''
    let multiline = false
    const sourceEl = activeSourceTextarea()
    if (sourceEl) {
      if (sourceEl.selectionStart !== sourceEl.selectionEnd) {
        sel = sourceEl.value.slice(sourceEl.selectionStart, sourceEl.selectionEnd)
        multiline = sel.includes('\n')
      }
    } else {
      const view = richView()
      const s = view?.state?.selection
      if (view && s && !s.empty) {
        sel = view.state.doc.textBetween(s.from, s.to, '\n')
        multiline = sel.includes('\n')
      }
    }
    let optsUpdate = null
    if (multiline) {
      const captured = captureFindSelection()
      if (captured) {
        findSelectionRef.current = captured
        optsUpdate = { inSelection: true }
      }
      sel = ''
    } else if (sel.length > 200) {
      // Skip giant single-line selections (would flood the input).
      sel = ''
    } else if (sel) {
      // A fresh single-line seed starts a new document-wide search.
      findSelectionRef.current = null
      optsUpdate = { inSelection: false }
    }
    if (optsUpdate) findOptsRef.current = { ...findOptsRef.current, ...optsUpdate }
    setFind((f) => ({ ...f, open: true, query: sel || f.query, ...(optsUpdate || {}) }))
    if (sel) runFind(sel)
    else if (optsUpdate?.inSelection && findQueryRef.current) runFind(findQueryRef.current)
    requestAnimationFrame(() => {
      const ref = focusReplace ? replaceInputRef : findInputRef
      ref.current?.focus()
      ref.current?.select()
    })
  }, [runFind, activeId])

  return { find, setFind, findInputRef, replaceInputRef, replaceRef, runFind, stepFind, closeFind, applyReplace, openFind, setFindOption }
}
