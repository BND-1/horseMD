import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  editorViewCtx,
  inputRulesCtx,
  parserCtx,
  remarkCtx,
  schemaCtx,
  serializerCtx
} from '@milkdown/kit/core'
import { ParserState } from '@milkdown/kit/transformer'
import { memoizeLastParses } from '../lib/parse-memo.js'
import { guardMarkInputRules } from '../lib/input-rule-guards.js'
import './editor-codeblock-eager.js' // side effect: root-fix #25 — eager, non-tearing code-block node view
import { chooseCodeBlockMountMode } from './editor-codeblock-eager.js' // #126 cap: lazy mount for block-heavy docs
import './editor-table-click.js' // side effect: single click in a table cell places the caret
import {
  applySerializerStyleToRemark,
  createSerializerStyleHolder
} from '../lib/serializer-style.js'
import { TextSelection } from '@milkdown/prose/state'
import { BLOCK_TYPES } from '../blocks.js'
import { useI18n } from '../i18n.jsx'
import { copyToClipboard, fireToast } from '../ui.js'
import { Icon } from './icons.jsx'
import { createImagePersister } from './editor-image-persistence.js'
import { normalizeDisplayMath } from './editor-math.js'
import { runHeadingFold } from './editor-heading-fold.js'
import { splitMarkdown, CHUNK_THRESHOLD, CHUNK_SIZE, appendChunks } from './editor-chunked-parse.js'
import { createBlockControls } from './editor-block-controls.js'
import { convertListAtSelection, getListConversionContext } from './editor-list-conversion.js'
import { normalizeReviewMarkupMarkdown } from '../reviewMarkup.js'
import { REVIEW_KINDS } from './editor-review.js'
import { createEditorApi } from './editor-api.js'
import { useEditorLightboxControls } from './editor-lightbox.js'
import { applyImageText, createConfiguredCrepe } from './editor-crepe-setup.js'
import { mountEditorDomBindings } from './editor-dom-bindings.js'
import { mountEditorInputTrace, traceEditorEvent } from './editor-input-trace.js'
import { mountSyncEventLog } from './editor-sync-event-log.js'
import { buildSyncReport, changedRegion, createSyncEventLog, syncReportAction } from '../lib/sync-diagnostics.js'
import { getCommandShortcut } from '../lib/commands/shortcut-labels.js'
import { generatedScratchMarkdown } from '../markdown-source-preservation.js'
import { createPmPosToMarkdownOffsetMapper, pmPosToMarkdownOffset } from './editor-source-map.js'
import { createEditorTransactionTracer } from './editor-transaction-trace.js'
import {
  areSourceDocumentsEquivalent,
  areSourceDocumentsEquivalentWithLiteralEmphasis,
  formatWholeDocumentReplacementSource,
  isWholeDocumentReplacementBatch
} from '../lib/source-transaction-sync.js'
import {
  createDocumentReplacementSourceSyncOwner,
  createEditorSourceSyncBridge,
  createSourceIntegrityValidator,
  createSourceSyncCheckpointStore
} from '../lib/source-sync/index.js'
import { isHeadingIdOnlyChange, isTrailingEmptyParagraphAppend, sameIgnoringHeadingIds } from '../lib/source-sync/editor-only-document.js'
import { listsReadAsOne, reprintSource, reprintVerified } from '../lib/source-reprint/index.js'
import { forgetParses, incrementalParse, parseMarkdownCached, parseMarkdownFull } from '../lib/source-reprint/incremental-parse.js'
import { createIncrementalSerializer } from '../lib/incremental-serialize.js'
import { createMilkdownSerializer } from '../lib/inline-serializer.js'
import { stripCodeFromAtoms } from './editor-inline-code-atoms.js'
import { Transform } from '@milkdown/kit/prose/transform'
// Self-check build (VITE_HM_SYNC_SELF_CHECK=1, used by the regression and
// fuzz runs): the incremental parse and the per-block comparison memo are
// re-checked against the full computation on every sync.
if (import.meta.env?.VITE_HM_SYNC_SELF_CHECK === '1') {
  globalThis.__hmIncrementalParseCheck = true
  globalThis.__hmSemanticMemoCheck = true
  globalThis.__hmIncrementalSerializeCheck = true
}
import { SOURCE_SYNC_OWNERS } from '../lib/source-sync/proof.js'
import { areDocumentsEquivalentByProjection, literalEmphasisOnly, projectDocument, registerProjector } from '../lib/source-sync/projection.js'
import {
  createSourceSnapshotHistory,
  isHistoryTransactionBatch,
  planHistorySourceRestore
} from '../lib/source-sync/history-source-restore.js'
import { hasBlockingSourceSyncListInputIntent, isSourceSyncListInputIntentActive } from '../lib/source-sync/list-input-intent-lifecycle.js'

// An IME composition in the editor's own text. ProseMirror's flag stays set
// when a composition starts in its DOM and ends in a CodeMirror code block
// (the caret had just moved there, after a paste): compositionend went to
// CodeMirror and every later code edit was held as "composing" — a save
// then wrote the source as it was before them (fuzz seed 5686). Inside a
// code block CodeMirror owns the composition.
const proseComposing = (view) => Boolean(view?.composing) &&
  !(typeof document !== 'undefined' && document.activeElement?.closest?.('.cm-editor'))

// Every mounted rich editor registers itself here. A rich-text tab stays mounted
// after its first activation, so several editors (and several Crepe selection
// toolbars) can coexist. The heading button injected into a toolbar resolves its
// target editor at click time — the one that currently owns the selection —
// instead of capturing a single instance, which previously made the button act
// on the wrong (hidden) tab when more than one tab was open.
const liveEditors = new Set()

// Line ending of the source line that holds `offset` (else of the nearest
// line before it; LF in a one-line file).
const localLineEnding = (source, offset) => {
  const text = String(source || '')
  const at = Math.max(0, Math.min(text.length, offset || 0))
  const next = text.indexOf('\n', at)
  if (next >= 0) return text[next - 1] === '\r' ? '\r\n' : '\n'
  const previous = text.lastIndexOf('\n', at - 1)
  if (previous >= 0) return text[previous - 1] === '\r' ? '\r\n' : '\n'
  return '\n'
}

/**
 * WYSIWYG editor (Milkdown Crepe) with Typora-style block-level controls.
 *
 * Ways to change a block's level — all driven through one `setBlock` path:
 *   - Keyboard:        Ctrl+1…6 → headings, Ctrl+0 → paragraph
 *   - Selection toolbar: an "H" button injected into Crepe's bold/italic
 *                        toolbar; hover it to reveal H1 / H2 / H3 / ¶
 *   - Right-click:     context menu with the full list + shortcuts
 *   - Status bar:      always-visible switcher (wired from App via onReady)
 *   - Plus Crepe's built-in slash menu (`/`) and block handle.
 */
// SVG images (#162) are vector: open them fitted to the window, keeping their
// ratio, instead of at the 300×150 an SVG without a width defaults to.
const isVectorImageSrc = (src) => /^data:image\/svg\+xml|\.svg(?:[?#]|$)/i.test(src || '')
const fitVectorLightboxImage = (event) => {
  const image = event.currentTarget
  if (!image.classList.contains('hm-lightbox-vector')) return
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (!width || !height) return
  const maxHeight = parseFloat(getComputedStyle(image).maxHeight)
  const scale = Math.min(
    (window.innerWidth * 0.9) / width,
    (Number.isFinite(maxHeight) ? maxHeight : window.innerHeight * 0.95 - 64) / height
  )
  image.style.width = `${width * scale}px`
  image.style.height = `${height * scale}px`
}

export default function Editor({
  initialContent,
  docPath,
  imageUploadCommand,
  spellcheck,
  inlineMathDeleteMode,
  markdownSyntax,
  selectionToolbar,
  onToggleSourceRichSplit,
  readOnly = false,
  effectiveKeybindings,
  onChange,
  onRichEditPending,
  onReady,
  onActiveBlock,
  onStructureChange,
  onLoadingChange
}) {
  const { t } = useI18n()
  const tRef = useRef(t)
  tRef.current = t
  // Live mirror of the image-host upload command, read at upload time (the Crepe
  // onUpload callback is registered once at create but always uses the latest).
  const uploadCmdRef = useRef(imageUploadCommand)
  uploadCmdRef.current = imageUploadCommand
  // Live mirror of the spell-check pref: applied to view.dom on mount (below) and
  // re-applied by the effect when the pref changes.
  const spellcheckRef = useRef(spellcheck)
  spellcheckRef.current = spellcheck
  // Read live by the parser and input rules (editor-subsup.js); a change
  // re-renders the open document (effect below).
  const markdownSyntaxRef = useRef(markdownSyntax)
  markdownSyntaxRef.current = markdownSyntax
  const resetParseCachesRef = useRef(null)
  const inlineMathDeleteModeRef = useRef(inlineMathDeleteMode || 'protect')
  inlineMathDeleteModeRef.current = inlineMathDeleteMode || 'protect'
  // The Crepe toolbar remains mounted so changing this setting is immediate and
  // does not recreate a rich editor. The interaction binding reads this ref to
  // decide when the right-click menu should expose text-format actions.
  const selectionToolbarRef = useRef(selectionToolbar !== false)
  selectionToolbarRef.current = selectionToolbar !== false
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  // Crepe can paint its ProseMirror DOM a few synchronous steps before its
  // source baseline and public API are ready. Never accept input in that
  // window: an edit there used to be incorporated into the initial baseline
  // without ever reaching `onChange`, so source mode and saves could lose it.
  const interactionReadyRef = useRef(false)
  const effectiveKeybindingsRef = useRef(effectiveKeybindings)
  effectiveKeybindingsRef.current = effectiveKeybindings
  const hostRef = useRef(null)
  const viewRef = useRef(null)
  // Incremental serializer of this editor (lib/incremental-serialize.js).
  const incrementalSerializerRef = useRef(null)
  const fullSerializerRef = useRef(null)
  const apiRef = useRef(null)
  const crepeRef = useRef(null)
  const lastBlockRef = useRef(null)
  // Re-apply the spellcheck attribute when the pref changes after mount (the
  // initial value is set during create above).
  useEffect(() => {
    const v = viewRef.current
    if (v?.dom) v.dom.setAttribute('spellcheck', spellcheck ? 'true' : 'false')
  }, [spellcheck])
  // Settings › Markdown syntax changed: the same Markdown now parses
  // differently, so drop every cached parse and re-render the document from
  // its current source (nothing is written; the source is unchanged).
  const syntaxKey = `${markdownSyntax?.subscript === true}|${markdownSyntax?.superscript === true}`
  const syntaxKeyRef = useRef(syntaxKey)
  useEffect(() => {
    if (syntaxKeyRef.current === syntaxKey) return
    syntaxKeyRef.current = syntaxKey
    const api = apiRef.current
    // Take the source BEFORE the escape list follows the new setting (a
    // flush afterwards would re-escape literal `a^2^` as `a\^2\^`). Unforced:
    // the committed source as is, unless a rich edit is still pending.
    let markdown = null
    try { markdown = api?.flushMarkdown?.() } catch { markdown = null }
    resetParseCachesRef.current?.()
    if (typeof markdown !== 'string') return
    try { api.replaceMarkdown?.(markdown) } catch { /* editor teardown */ }
  }, [syntaxKey])
  // Keep native selection and scrolling available while making the underlying
  // ProseMirror view genuinely non-editable. A CSS-only lock still accepts
  // paste/drop and lets input rules mutate the document.
  useEffect(() => {
    const view = viewRef.current
    if (!view?.dom) return
    const editable = interactionReadyRef.current && !readOnly
    try { view.setProps({ editable: () => editable }) } catch { /* view is tearing down */ }
    view.dom.contentEditable = editable ? 'true' : 'false'
    view.dom.setAttribute('aria-readonly', readOnly ? 'true' : 'false')
  }, [readOnly])
  // Crepe does not re-position its tooltip until the next selection update.
  // Restore the current one here so enabling the preference is immediate and
  // never requires an editor remount.
  useEffect(() => {
    if (selectionToolbar === false) return
    const view = viewRef.current
    if (!view || view.state.selection.empty) return
    const host = view.dom.closest('.milkdown') || view.dom.parentElement
    const toolbar = host?.querySelector('.milkdown-toolbar')
    if (toolbar) toolbar.dataset.show = 'true'
  }, [selectionToolbar])
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y } viewport coords, or null
  // Esc closes the context menu (native menus, the tab menu). Capture phase,
  // stopped there: ProseMirror's Escape would also select the parent node,
  // and full-screen mode leaves Esc to an open menu.
  const ctxMenuOpen = !!ctxMenu
  useEffect(() => {
    if (!ctxMenuOpen) return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      setCtxMenu(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [ctxMenuOpen])
  // Lightbox: the image src currently shown enlarged, or null.
  const [zoom, setZoom] = useState(null)
  // Mermaid-lightbox pan/zoom state (refs so dragging doesn't re-render per frame).
  // Adapted from @digyear's PR #27 (Mermaid fullscreen lightbox).
  const lightboxScaleRef = useRef(1)
  const lightboxContentRef = useRef(null)
  const lightboxTranslateRef = useRef({ x: 0, y: 0 })
  const [lightboxScale, setLightboxScale] = useState(1)
  const { fitToWindow, showActualSize, zoomIn, zoomOut } = useEditorLightboxControls({
    zoom,
    setZoom,
    scaleRef: lightboxScaleRef,
    translateRef: lightboxTranslateRef,
    contentRef: lightboxContentRef,
    setScaleLabel: setLightboxScale
  })
  // False until Crepe has parsed and rendered the document — drives the loading
  // skeleton. Only large documents (which actually take a moment to render) show
  // it, so small files never flash a placeholder.
  const [loaded, setLoaded] = useState(false)
  // Below this, docs parse fast enough to create synchronously. At or above it we
  // show a skeleton and defer create past a paint, so opening / switching to a
  // biggish doc shows feedback (and lets a queued click through) before the
  // synchronous ProseMirror parse blocks the main thread.
  const isLargeDoc = (initialContent?.length || 0) > 8000
  // Huge docs are split into chunks and parsed incrementally (see splitMarkdown):
  // the first chunk is the editor's initial content, the rest are appended in the
  // background after create(). `chunks` is null for normal-sized docs.
  const chunks = (initialContent?.length || 0) > CHUNK_THRESHOLD ? splitMarkdown(initialContent, CHUNK_SIZE) : null
  const firstContent = chunks ? chunks[0] : initialContent || ''
  // Keep the source snapshot separate from Crepe's canonical serialization.
  // The first is what the user wrote; the second lets us isolate a rich-text
  // transaction instead of replacing untouched source with formatter output.
  const lastMarkdownRef = useRef(initialContent || '')
  const canonicalMarkdownRef = useRef('')
  const programmaticReplaceRef = useRef(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    interactionReadyRef.current = false
    let ready = false
    let destroyed = false
    let hasSyntheticEmptyTitle = false
    let createRaf = 0
    const cleanups = []
    // Sync diagnostics (lib/sync-diagnostics.js): the last input events, and a
    // snapshot taken when sync fails — the report itself is built only when
    // the user opens it.
    const syncEventLog = createSyncEventLog()
    const captureSyncReport = (reason, where) => {
      const doc = viewRef.current?.state.doc
      const source = lastMarkdownRef.current || ''
      // Trace runs (--horsemd-input-trace): keep the exact state of the last
      // failure for the fuzzer — by the time it reads the page, later
      // keystrokes may have moved the document on.
      if (globalThis.__hmSourceReprintHarness) {
        try { globalThis.__hmLastSyncFailure = { reason, where, source, doc: doc?.toJSON() ?? null } } catch { /* report only */ }
      }
      const events = syncEventLog.entries()
      const at = new Date().toISOString()
      return () => {
        let region = null
        try {
          if (doc && crepeRef.current) {
            const ctx = crepeRef.current.editor.ctx
            const sourceDoc = ctx.get(parserCtx)(source)
            const mapOffset = createPmPosToMarkdownOffsetMapper(source, sourceDoc, ctx.get(remarkCtx))
            region = changedRegion({ source, sourceDoc, editorDoc: doc, mapOffset, serialize: ctx.get(serializerCtx) })
          }
        } catch (error) {
          region = { error: error?.message || String(error) }
        }
        return buildSyncReport({
          version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
          platform: window.api?.platform,
          userAgent: navigator.userAgent,
          where,
          reason,
          at,
          source,
          region,
          events
        })
      }
    }
    const canonicalForSource = (markdown) => {
      const canonical = normalizeReviewMarkupMarkdown(markdown)
      if (!hasSyntheticEmptyTitle) return canonical
      // The synthetic title owns every immediately following blank line until
      // the first authored body block. A list input rule can temporarily make
      // Crepe serialize that skeleton as `#\n\n\n- ...`; stripping only two
      // newlines leaks a phantom blank prefix into a brand-new document's
      // source. This branch runs only while the title itself remains empty.
      const emptyTitle = canonical.match(/^#[ \t]*(?:\r?\n)+/)
      if (emptyTitle) return canonical.slice(emptyTitle[0].length)
      // Once the user types in or transforms the optional title, it becomes
      // authored Markdown and participates in every later source delta.
      hasSyntheticEmptyTitle = false
      return canonical
    }
    // A new document's title placeholder (the empty H1 the editor inserts,
    // Typora-style) is editor-only while the user has not touched it: an
    // empty heading is `#` in Markdown, so it would be written as a stray
    // `#` line above what was typed below it. Every other empty heading is
    // written (`#` reads back as an empty heading).
    const withoutSyntheticTitle = (doc) => {
      if (!hasSyntheticEmptyTitle || !doc) return doc
      const first = doc.firstChild
      if (first?.type.name !== 'heading' || first.attrs.level !== 1 || first.content.size !== 0) return doc
      if (doc.childCount > 1) return doc.copy(doc.content.cut(first.nodeSize))
      const paragraph = doc.type.schema.nodes.paragraph
      return paragraph ? doc.copy(doc.content.replaceChild(0, paragraph.create())) : doc
    }
    // Register this editor so a globally-injected toolbar button can find the
    // editor that currently has the selection. Getters read the live refs.
    const self = { host, getView: () => viewRef.current, getApi: () => apiRef.current }
    liveEditors.add(self)
    cleanups.push(() => liveEditors.delete(self))

    const persistImage = createImagePersister({
      docPath,
      getUploadCommand: () => uploadCmdRef.current,
      getT: (key) => tRef.current(key),
      notify: fireToast
    })

    let userEditUntil = 0
    // The last published source reprint printed a list with no authored marker.
    let lastReprintPrintedNewList = false
    // `markdownUpdated` normally catches up immediately, but a mode switch can
    // happen in the narrow gap after a visible ProseMirror transaction. Keep a
    // precise flag for that gap: it preserves the required immediate flush
    // without serializing a 400K+ document again for a reading-only toggle.
    let richFlushPending = false
    let pendingRichBlockKey = null
    let richDirtyReconcileTimer = 0
    let cancelDeferredMarkdownSync = () => {}
    // True while a markdownUpdated callback for the live document is still
    // coming (Milkdown's 200 ms debounce) or queued (heavy-doc deferral).
    let isMarkdownSyncPending = () => false
    // Last document Milkdown's listener delivered (its debounce fired); the
    // loaded document until the first delivery.
    let deliveredDoc = null
    // A select-all replacement waiting for its markdownUpdated callback.
    let wholeDocumentReplacementPending = null
    const currentRichBlockKey = () => {
      const selection = viewRef.current?.state.selection
      const $from = selection?.$from
      if (!$from?.parent?.isTextblock || $from.depth < 1) return null
      try {
        // Use the owning top-level block position, not the textblock's own
        // position. A Markdown input rule can wrap the same paragraph in a
        // bullet/ordered list between two keystrokes; its textblock position
        // then shifts even though the user never moved, which would make a
        // boundary flush persist the intermediate `* <br />` list skeleton.
        // The wrapper starts at the former paragraph position, so depth 1 is
        // stable for that structural transition while still separating a
        // heading, a later list, and other unrelated top-level blocks.
        return `top:${$from.before(1)}`
      } catch {
        return null
      }
    }
    const markUserEdit = (ttl = 8000, { pointer = false } = {}) => {
      // A press arrives before the selection moves, so the current block is
      // the one being LEFT: it must not become the pending block (the first
      // keystroke after clicking elsewhere would then force a full flush).
      const blockKey = pointer ? null : currentRichBlockKey()
      // Milkdown batches markdownUpdated for about 200 ms. If the user edits
      // one block, immediately moves to another, then edits again, a single
      // callback can contain unrelated heading/list/quote deltas that no
      // bounded source mapper can safely own. Commit the completed block while
      // the next block has not mutated yet. Continuous typing in one block
      // remains batched, so this does not serialize the document per keypress.
      if (
        richFlushPending &&
        pendingRichBlockKey &&
        blockKey &&
        blockKey !== pendingRichBlockKey &&
        // Space on a captured `-` / `*` / `+` / ordered marker structurally
        // wraps the SAME paragraph in a list before Milkdown's markdownUpdated
        // callback. During that known transition the top-level PM key can move,
        // but flushing here races ahead of the exact marker-ownership bridge and
        // produces a false source mismatch. Real cross-block edits have no
        // active list input intent and still flush immediately.
        !hasBlockingListInputIntent()
      ) {
        const markdown = apiRef.current?.flushMarkdown?.()
        if (typeof markdown === 'string') onChange?.(markdown, false)
      }
      programmaticReplaceRef.current = null
      userEditUntil = Date.now() + ttl
      richFlushPending = true
      pendingRichBlockKey = blockKey || pendingRichBlockKey
    }
    // Milkdown's listener batches markdownUpdated for 200ms. A user can type
    // and then revert within that window, leaving its final ProseMirror doc
    // equal to the listener's previous doc; Milkdown correctly skips the
    // callback, but HorseMD's immediate dirty hint must then be cleared. This
    // one-shot reconciliation runs only after a real DOM mutation and only
    // while the regular listener has not already settled the change.
    let richDirtyReconcileSince = 0
    const scheduleRichDirtyReconcile = (delayMs = 260, { keepSince = false } = {}) => {
      if (!keepSince || !richDirtyReconcileSince) richDirtyReconcileSince = Date.now()
      if (richDirtyReconcileTimer) clearTimeout(richDirtyReconcileTimer)
      richDirtyReconcileTimer = window.setTimeout(() => {
        richDirtyReconcileTimer = 0
        if (destroyed || !richFlushPending) return
        // The list input-rule callback is authoritative for this structural
        // transition. If Milkdown is slower than the normal 200ms debounce,
        // don't let dirty reconciliation race it with a generic serializer
        // flush; retry after a short interval while the captured intent remains
        // active. If the callback never arrives, normal reconciliation resumes
        // once the bounded intent window expires.
        // Same for an active IME composition: a pause on uncommitted pinyin
        // must not flush transient candidate text (compositionend delivers
        // the committed characters through markdownUpdated).
        if (hasBlockingListInputIntent() || proseComposing(viewRef.current)) {
          scheduleRichDirtyReconcile(120)
          return
        }
        // The regular sync is still on its way: on a large document it is
        // deliberately deferred until typing pauses, and flushing here would
        // run the full reprint + verification in the middle of typing anyway
        // (seconds per pause on Windows). Check again after it had its turn.
        // Bounded: Milkdown never delivers addToHistory:false transactions,
        // so after a few seconds fall back to the flush.
        if (isMarkdownSyncPending() && Date.now() - richDirtyReconcileSince < 3000) {
          scheduleRichDirtyReconcile(400, { keepSince: true })
          return
        }
        richDirtyReconcileSince = 0
        const markdown = apiRef.current?.flushMarkdown?.()
        if (typeof markdown === 'string') onChange?.(markdown, false)
      }, delayMs)
    }
    const hasRecentUserEdit = () => Date.now() <= userEditUntil
    // A document whose sync is worth deferring while typing and warming up
    // after opening. Yuque exports are mostly tag bytes: 350 KB of source is
    // under 100 000 of document content.
    const isLargeSyncDocument = (doc) => (doc?.content?.size || 0) > 50000 ||
      String(lastMarkdownRef.current ?? '').length > 150000
    const clearRichFlushPending = () => {
      cancelDeferredMarkdownSync()
      richFlushPending = false
      pendingRichBlockKey = null
    }
    const pendingRawMarkdownPasteRef = { current: null }
    let pendingMarkdownInputIntent = null
    const isActiveListInputIntent = (intent) =>
      isSourceSyncListInputIntentActive(intent)
    const hasBlockingListInputIntent = () =>
      hasBlockingSourceSyncListInputIntent(
        pendingMarkdownInputIntents,
        pendingMarkdownInputIntent
      )
    // While a list input intent is pending the source reprint still runs
    // first (it is verified against the editor document, so a transient
    // marker state cannot mismatch); the marker the user typed spells the
    // new list. null when two pending intents of one kind disagree — which
    // list got which is unknown, so the intent-owning path decides.
    const pendingListIntentMarkers = () => {
      const bullets = new Set()
      const delimiters = new Set()
      for (const intent of [...pendingMarkdownInputIntents, pendingMarkdownInputIntent]) {
        if (!isActiveListInputIntent(intent)) continue
        if (intent.type === 'bullet-list') bullets.add(intent.marker)
        else delimiters.add(String(intent.marker || '').slice(-1))
      }
      if (bullets.size > 1 || delimiters.size > 1) return null
      return { bullet: [...bullets][0] || null, delimiter: [...delimiters][0] || null }
    }
    // After the reprint published the list the intent was for, its marker is
    // authored source: the intent has nothing left to say and must not reach
    // a later document (stale `1)` / `+`, glued lists).
    // Also when the published reprint printed a list with no authored marker
    // (`new-list-marker`): a late callback (slow machine) arrives after the
    // caret has left the new list, the intent stayed pending, and once a
    // later callback had nothing to write the legacy writer rewrote the list
    // from it (lost the blank line before it; Windows 2026-11-07).
    // The caret's text block is a typed marker still waiting for its Space
    // (the intent is noted on that keydown, before the input rule runs).
    const markerAwaitingSpace = () => {
      const { $head } = viewRef.current?.state.selection || {}
      return Boolean($head?.parent?.isTextblock && /^([-+*]|\d{1,9}[.)])$/.test($head.parent.textContent))
    }
    const settleListIntentsAfterReprint = () => {
      const { $head } = viewRef.current?.state.selection || {}
      let inList = lastReprintPrintedNewList && !markerAwaitingSpace()
      for (let depth = $head?.depth ?? 0; !inList && depth > 0; depth -= 1) {
        if ($head.node(depth).type.name === 'list_item') { inList = true; break }
      }
      if (!inList) return
      if (Array.isArray(globalThis.__hmListIntentTrace)) {
        globalThis.__hmListIntentTrace.push({ phase: 'settled-by-reprint', kept: 0 })
      }
      pendingMarkdownInputIntents = []
      pendingMarkdownInputIntent = null
    }
    // A physical/IME input sequence can create an outer list and a nested list
    // before Milkdown emits its first markdownUpdated callback. Keep every
    // marker intent until that callback serializes the generated document;
    // retaining only the latest intent loses the outer marker (`1.` -> `1)`).
    let pendingMarkdownInputIntents = []
    let appending = false

    // Insert an image at the caret (used by paste / drop of image files). Persists
    // the file first, then drops an inline image node with the resulting src.
    const insertUploadedImage = async (file, fromClipboard = false) => {
      if (readOnlyRef.current) return
      const url = await persistImage(file, fromClipboard)
      const v = viewRef.current
      if (!v || !url) return
      const imgType = v.state.schema.nodes.image
      if (!imgType) return
      const node = imgType.create({ src: url, alt: file.name || '' })
      markUserEdit()
      v.dispatch(v.state.tr.replaceSelectionWith(node, false).scrollIntoView())
    }

    const handleFrontmatterValueChange = ({ view, getPos }) => {
      markUserEdit()
      publishReprintNow(view.state.doc)
    }

    const handleInlineCodeValueChange = () => {
      if (!viewRef.current) return
      markUserEdit()
      publishReprintNow(viewRef.current.state.doc)
    }

    const documentReplacementSourceSyncOwner = createDocumentReplacementSourceSyncOwner({
      formatWholeDocumentSource: formatWholeDocumentReplacementSource
    })
    const sourceSnapshotHistory = createSourceSnapshotHistory()

    let crepe
    let readsAsOneList = null
    let sourceSyncBridge = null
    // One sync verifies the same candidate against the same document several
    // times (reprint escape levels, trace shadow, owners); each is a full
    // parse/serialize, seconds on a 250 KB file. Remember the last of each.
    const lastValidationParse = { markdown: null, doc: null }
    // Parse a candidate through mdast (what Milkdown's parser does inside) and
    // keep the mdast: once published, the candidate is the next sync's
    // committed source, which the reprint engine would otherwise parse again.
    const parseCandidate = (markdown, parser) => {
      if (typeof markdown !== 'string' || markdown.startsWith('\uFEFF')) return parser(markdown)
      let doc
      try {
        // Reparses only the blocks the edit touched (incremental-parse.js);
        // unchanged blocks keep their nodes, so the comparison skips them.
        doc = parseMarkdownCached(crepe.editor.ctx.get(remarkCtx), crepe.editor.ctx.get(schemaCtx), markdown, {
          onMismatch: (report) => {
            traceEditorEvent('incremental-parse-mismatch', report)
            fireToast(`增量解析与整篇解析不一致（${report.length}）`, { sticky: true })
          }
        }).srcDoc
      } catch {
        return parser(markdown)
      }
      parser.prime?.(markdown, doc)
      return doc
    }
    const lastValidationCanonical = { doc: null, markdown: null }
    resetParseCachesRef.current = () => {
      lastValidationParse.markdown = null
      lastValidationParse.doc = null
      lastValidationCanonical.doc = null
      try {
        forgetParses(crepe.editor.ctx.get(remarkCtx))
        crepe.editor.ctx.get(parserCtx).clear?.()
        crepe.hmSyncSubSupUnsafe?.()
      } catch { /* editor not created yet */ }
    }
    const validateTransactionMarkdown = ({ markdown, expectedDoc, semanticOptions = {} }) => {
      const parser = crepe.editor.ctx.get(parserCtx)
      if (lastValidationParse.markdown !== markdown || !lastValidationParse.doc) {
        lastValidationParse.doc = parseCandidate(markdown, parser)
        lastValidationParse.markdown = markdown
      }
      const parsed = lastValidationParse.doc
      // Same meaning = the projection (lib/source-sync/projection.js): one
      // definition for every writer and the save check. It compares lists as
      // the parser reads them, so it is the list check too.
      const projected = areDocumentsEquivalentByProjection(parsed, expectedDoc)
      if (/no-projector/.test(projected.reason || '')) return areSourceDocumentsEquivalent(parsed, expectedDoc, semanticOptions)
      if (projected.equal) return true
      if (Array.isArray(globalThis.__hmSourceIntegrityDiffTrace) && window.api?.inputTraceEnabled === true) {
        globalThis.__hmSourceIntegrityDiffTrace.push({ at: Date.now(), source: 'validate-projection', reason: projected.reason, detail: projected.detail })
        if (globalThis.__hmSourceIntegrityDiffTrace.length > 40) globalThis.__hmSourceIntegrityDiffTrace.shift()
      }
      // Option A (Typora parity): the reprint may spell bold/italic that
      // Markdown cannot delimit there as literal `*`/`_`; nothing else may
      // differ.
      return semanticOptions.relaxOrderedNumbers === true && semanticOptions.allowLiteralEmphasis !== false &&
        areSourceDocumentsEquivalentWithLiteralEmphasis(parsed, expectedDoc, { ...semanticOptions, ignoreAllTableColumnWidths: true }) &&
        literalEmphasisOnly(parsed, expectedDoc)
    }
    // A user-test session launched with `--horsemd-input-trace` keeps the
    // in-page evidence arrays alive from the start, so a reported
    // first-divergence can be read back (CDP attach, or the on-warning dump
    // below) instead of requiring a fresh instrumented repro. Normal builds
    // never initialize these arrays; every consumer stays push-only.
    if (window.api?.inputTraceEnabled === true) {
      for (const key of [
        '__hmPreserveLog',
        '__hmSourceIntegrityTrace',
        '__hmSourceIntegrityDiffTrace',
        '__hmSourceSyncCoordinatorTrace',
        '__hmSourceSyncTransactionJournalTrace',
        '__hmFlushTrace',
        '__hmSourceReprintTrace'
      ]) {
        if (!Array.isArray(globalThis[key])) globalThis[key] = []
      }
    }
    const handleSlashCommand = ({ phase, id, view, token }) => {
      // The slash block is an ordinary edit for the reprint.
      if (phase === 'before') markUserEdit()
      return null
    }

    const traceSourceTransactions = createEditorTransactionTracer()
    const handleSourceTransactions = (transactions, oldState, newState) => {
      traceSourceTransactions(transactions, oldState?.doc, newState?.doc)
      const pendingRawPaste = pendingRawMarkdownPasteRef.current
      const traceRawPasteOwner = (entry) => {
        if (!Array.isArray(globalThis.__hmSourceSyncCoordinatorTrace)) return
        globalThis.__hmSourceSyncCoordinatorTrace.push({
          phase: 'raw-paste-transaction-owner',
          ...entry
        })
      }
      let rawPasteBound = false
      if (pendingRawPaste && !pendingRawPaste.transactionBound) {
        const bound = documentReplacementSourceSyncOwner.bindRawMarkdownPasteTransaction({
          token: pendingRawPaste,
          activeToken: pendingRawMarkdownPasteRef.current,
          transactions,
          oldDoc: oldState?.doc,
          newDoc: newState?.doc
        })
        rawPasteBound = bound.ok === true
        traceRawPasteOwner({
          stage: 'bind',
          ok: bound.ok === true,
          reason: bound.reason || null,
          transactionCount: (transactions || []).filter((transaction) => transaction?.docChanged).length,
          tokenId: pendingRawPaste.tokenId || null
        })
      }
      // Undoing the replacement before markdownUpdated returns the live
      // document to its byte-owning baseline; do not regenerate that baseline.
      if (
        wholeDocumentReplacementPending?.originalDoc?.eq?.(newState?.doc) === true
      ) {
        wholeDocumentReplacementPending = null
      }
      // A selection that covered the complete pre-transaction document owns
      // the complete replacement. Capture this before the optional transaction
      // shadow gate: release builds need the explicit select-all path, while
      // ordinary per-keystroke mapping remains opt-in.
      if (
        ready &&
        !appending &&
        !programmaticReplaceRef.current &&
        hasRecentUserEdit() &&
        isWholeDocumentReplacementBatch({ transactions, oldState, newState })
      ) {
        const captured = documentReplacementSourceSyncOwner.captureWholeDocumentReplacement({
          source: lastMarkdownRef.current,
          canonical: canonicalMarkdownRef.current,
          originalDoc: oldState.doc,
          expectedDoc: newState.doc
        })
        wholeDocumentReplacementPending = captured.ok ? captured.token : null
        pendingMarkdownInputIntent = null
        pendingMarkdownInputIntents = []
      }

      // Raw Markdown paste owns exact clipboard bytes. Milkdown can defer its
      // markdownUpdated callback beyond a source-mode/save boundary, so waiting
      // for that callback lets forced flush publish canonical marker spelling
      // (`*`) before the clipboard owner (`-`) is considered. Once the paste
      // transaction chain is proven, serialize its resulting doc and commit the
      // exact source immediately through the same Coordinator. If serialization
      // or validation is transiently unavailable, keep the token for the normal
      // callback fallback instead of advancing any baseline.
      if (rawPasteBound && pendingRawMarkdownPasteRef.current === pendingRawPaste) {
        try {
          const serializer = crepe.editor.ctx.get(serializerCtx)
          const canonical = canonicalForSource(serializer(newState.doc))
          const ownership = documentReplacementSourceSyncOwner.planRawMarkdownPaste({
            token: pendingRawPaste,
            activeToken: pendingRawMarkdownPasteRef.current,
            currentSource: lastMarkdownRef.current,
            currentCanonical: canonicalMarkdownRef.current,
            canonical,
            expectedDoc: newState.doc
          })
          traceRawPasteOwner({
            stage: 'plan',
            ok: ownership.ok === true,
            reason: ownership.reason || null,
            tokenId: pendingRawPaste.tokenId || null,
            canonicalLength: canonical.length,
            markdownLength: pendingRawPaste.markdown?.length ?? null
          })
          if (ownership.ok) {
            let coordinated
            dispatchingExpectedDoc = newState.doc
            try {
              coordinated = sourceSyncBridge.publishOwned({ ownership })
            } finally {
              dispatchingExpectedDoc = null
            }
            traceRawPasteOwner({
              stage: 'publish',
              ok: coordinated?.ok === true,
              reason: coordinated?.reason || null,
              tokenId: pendingRawPaste.tokenId || null,
              revision: coordinated?.snapshot?.revision ?? null
            })
            if (coordinated?.ok) {
              pendingRawMarkdownPasteRef.current = null
              wholeDocumentReplacementPending = null
              clearRichFlushPending()
              userEditUntil = Date.now() + 1000
              return
            }
          }
        } catch (error) {
          traceRawPasteOwner({
            stage: 'exception',
            ok: false,
            reason: error?.message || error?.name || 'unknown',
            tokenId: pendingRawPaste.tokenId || null
          })
          // Deferred markdownUpdated retains the same token and remains the
          // fail-closed retry path; no source/canonical checkpoint was advanced.
        }
      }

      // A Coordinator snapshot whose doc IS the pre-transaction doc is a proven
      // (doc, source) pair; remember it so undo/redo back to this document can
      // restore its exact bytes (identity check only — no per-keystroke eq).
      // Only once ready: the Coordinator is created lazily on first access and
      // must not snapshot the pre-bootstrap canonical.
      if (ready) {
        const snapshot = sourceSyncBridge.getSnapshot()
        if (
          snapshot.doc === oldState?.doc &&
          snapshot.source === String(lastMarkdownRef.current ?? '') &&
          snapshot.canonical === String(canonicalMarkdownRef.current ?? '')
        ) {
          sourceSnapshotHistory.record({ doc: snapshot.doc, source: snapshot.source })
        }
      }
      // Undo/redo that lands on a recorded document (typically across a
      // source-mode replacement, fuzz seeds 28/36) restores that document's
      // exact source instead of extending the journal with a whole-document
      // step no focused owner or legacy mapper can localize.
      if (
        ready &&
        !viewRef.current?.composing &&
        !appending &&
        !programmaticReplaceRef.current &&
        !pendingRawMarkdownPasteRef.current &&
        isHistoryTransactionBatch(transactions)
      ) {
        let restore = null
        let coordinated = null
        try {
          const serializer = crepe.editor.ctx.get(serializerCtx)
          restore = planHistorySourceRestore({
            history: sourceSnapshotHistory,
            transactions,
            newDoc: newState.doc,
            currentSource: lastMarkdownRef.current,
            currentCanonical: canonicalMarkdownRef.current,
            canonical: canonicalForSource(serializer(newState.doc))
          })
          if (restore.ok) {
            dispatchingExpectedDoc = newState.doc
            try {
              coordinated = sourceSyncBridge.publishOwned({ ownership: restore })
            } finally {
              dispatchingExpectedDoc = null
            }
          }
        } catch (error) {
          restore = { ok: false, reason: error?.message || 'history-restore-exception' }
        }
        if (Array.isArray(globalThis.__hmSourceSyncTransactionJournalTrace)) {
          globalThis.__hmSourceSyncTransactionJournalTrace.push({
            phase: 'history-restore',
            ok: coordinated?.ok === true,
            reason: coordinated?.reason || restore?.reason || null,
            revision: coordinated?.snapshot?.revision ?? null
          })
        }
        if (coordinated?.ok) {
          wholeDocumentReplacementPending = null
          pendingMarkdownInputIntent = null
          pendingMarkdownInputIntents = []
          clearRichFlushPending()
          sourceSnapshotHistory.record({ doc: newState.doc, source: String(lastMarkdownRef.current ?? '') })
          return
        }
      }

      // Editor-only changes (no Markdown): Milkdown's heading-id sync and its
      // trailing empty paragraph after a final table / list / code / quote.
      // Adopted as the committed source's document, so nothing is reprinted
      // for them.
      if (
        ready &&
        !viewRef.current?.composing &&
        !appending &&
        !programmaticReplaceRef.current &&
        !pendingRawMarkdownPasteRef.current &&
        isHeadingIdOnlyChange(transactions, oldState.doc, newState.doc)
      ) {
        if (
          validateTransactionMarkdown({
            markdown: String(lastMarkdownRef.current ?? ''),
            expectedDoc: newState.doc
          }) === true &&
          sourceSyncBridge.adoptEditorOnlyDocument({ doc: newState.doc, reason: 'heading-id-sync' })
        ) {
          if (Array.isArray(globalThis.__hmSourceSyncTransactionJournalTrace)) {
            globalThis.__hmSourceSyncTransactionJournalTrace.push({ phase: 'editor-only-adopted', ok: true, reason: 'heading-id-sync' })
          }
          return
        }
      }

      if (
        ready &&
        !viewRef.current?.composing &&
        !appending &&
        !programmaticReplaceRef.current &&
        !pendingRawMarkdownPasteRef.current &&
        !wholeDocumentReplacementPending &&
        isTrailingEmptyParagraphAppend(transactions, oldState.doc, newState.doc)
      ) {
        try {
          const snapshot = sourceSyncBridge.getSnapshot()
          if (
            snapshot.doc === oldState.doc &&
            snapshot.source === String(lastMarkdownRef.current ?? '') &&
            snapshot.canonical === String(canonicalMarkdownRef.current ?? '') &&
            validateTransactionMarkdown({
              markdown: String(lastMarkdownRef.current ?? ''),
              expectedDoc: newState.doc
            }) === true
          ) {
            const adopted = sourceSyncBridge.adoptEditorOnlyDocument({
              doc: newState.doc,
              reason: 'trailing-empty-paragraph-append'
            })
            if (adopted && Array.isArray(globalThis.__hmSourceSyncTransactionJournalTrace)) {
              globalThis.__hmSourceSyncTransactionJournalTrace.push({
                phase: 'editor-only-adopted',
                ok: true,
                reason: 'trailing-empty-paragraph-append',
                revision: adopted.revision
              })
            }
          }
        } catch {
          // Not adopted: the reprint sees the empty paragraph (no Markdown).
        }
      }
    }

    crepe = createConfiguredCrepe({
      host,
      // Decide the code-block mount mode BEFORE Crepe parses: block-heavy
      // documents (issue #126, 394-fence redis doc) must not eager-mount a
      // CodeMirror per fence.
      defaultValue: (() => {
        const normalized = normalizeReviewMarkupMarkdown(normalizeDisplayMath(firstContent))
        chooseCodeBlockMountMode(normalized)
        return normalized
      })(),
      getT: (key) => tRef.current(key),
      persistImage,
      notify: fireToast,
      copyText: copyToClipboard,
      getInlineMathDeleteMode: () => inlineMathDeleteModeRef.current,
      getMarkdownSyntax: () => markdownSyntaxRef.current || {},
      markUserEdit,
      isReadOnly: () => readOnlyRef.current,
      onFrontmatterValueChange: handleFrontmatterValueChange,
      onInlineCodeValueChange: handleInlineCodeValueChange,
      onSlashCommand: handleSlashCommand,
      onSourceTransactions: handleSourceTransactions,
      isProgrammaticChange: () => Boolean(programmaticReplaceRef.current),
      readsAsOneList: (doc) => (readsAsOneList ? readsAsOneList(doc) : new Set())
    })
    crepeRef.current = crepe
    const serializerStyleHolder = createSerializerStyleHolder(firstContent)

    // Keep a small exact set of source/canonical pairs that have already been
    // proven or were created directly by opening the author's file. The store
    // now lives behind the SourceSyncCoordinator contract, while all legacy
    // validation rules and trace fields remain byte-for-byte compatible.
    const sourceIntegrityCheckpoints = createSourceSyncCheckpointStore({ limit: 4 })
    const validateSourceCandidate = createSourceIntegrityValidator({
      getParser: () => crepe.editor.ctx.get(parserCtx),
      getSerializer: () => crepe.editor.ctx.get(serializerCtx),
      getExpectedDoc: () => withoutSyntheticTitle(viewRef.current?.state.doc),
      getAuthoredSource: () => lastMarkdownRef.current,
      getCanonicalBaseline: () => canonicalMarkdownRef.current,
      canonicalForSource,
      checkpointStore: sourceIntegrityCheckpoints,
      getTrace: () => globalThis.__hmSourceIntegrityTrace
    })
    let dispatchingExpectedDoc = null
    // Source reprint shadow mode (R2, docs/source-reprint-architecture.md):
    // under input trace only, compute what the reprint engine would publish at
    // every publication and every refused sync, without affecting either.
    // Blockquotes whose last child is the editor's empty paragraph (e.g. Enter
    // out of a quoted list): no Markdown encoding, admitted by exact path.
    const trailingEmptyQuotePaths = (doc) => {
      const paths = []
      const walk = (node, path) => {
        if (node.type.name === 'blockquote' && node.childCount >= 2) {
          const last = node.lastChild
          if (last?.type.name === 'paragraph' && last.content.size === 0) paths.push(path)
        }
        node.forEach((child, _offset, index) => {
          if (!child.isTextblock && !child.isLeaf) walk(child, [...path, index])
        })
      }
      walk(doc, [])
      return paths
    }
    const reprintDeps = () => ({
      parse: (markdown) => crepe.editor.ctx.get(parserCtx)(markdown),
      // Same as `parse`, from the mdast the engine already built.
      parseTree: (tree) => {
        const state = new ParserState(crepe.editor.ctx.get(schemaCtx))
        state.next(tree)
        return state.toDoc()
      },
      remark: crepe.editor.ctx.get(remarkCtx),
      serialize: (node) => crepe.editor.ctx.get(serializerCtx)(node),
      // The candidate reads back as the editor document: one definition,
      // the projection (lib/source-sync/projection.js; docs/reprint-root-
      // cause-plan.md P2) — no list of exceptions. `literalEmphasis`: Option
      // A (user decision 2026-10-10: bold / italic Markdown cannot delimit
      // there written as literal `*`), asked only after every exact spelling
      // failed; it still goes through the older comparison, which knows it.
      equivalent: (markdown, expectedDoc, { literalEmphasis = true } = {}) => {
        const parser = crepe.editor.ctx.get(parserCtx)
        if (lastValidationParse.markdown !== markdown || !lastValidationParse.doc) {
          lastValidationParse.doc = parseCandidate(markdown, parser)
          lastValidationParse.markdown = markdown
        }
        const verdict = areDocumentsEquivalentByProjection(lastValidationParse.doc, expectedDoc)
        if (verdict.equal) return true
        if (Array.isArray(globalThis.__hmSourceIntegrityDiffTrace) && window.api?.inputTraceEnabled === true) {
          globalThis.__hmSourceIntegrityDiffTrace.push({ at: Date.now(), source: 'reprint-projection', reason: verdict.reason, detail: verdict.detail })
          if (globalThis.__hmSourceIntegrityDiffTrace.length > 40) globalThis.__hmSourceIntegrityDiffTrace.shift()
        }
        if (!literalEmphasis) return false
        return validateTransactionMarkdown({
          markdown,
          expectedDoc,
          semanticOptions: {
            ignoreTrailingEmptyBlockquoteParagraphPaths: trailingEmptyQuotePaths(expectedDoc),
            ignoreAllTableColumnWidths: true,
            ignoreEmptyContainerParagraphs: true,
            relaxOrderedNumbers: true,
            allowLiteralEmphasis: true
          }
        }) === true && literalEmphasisOnly(lastValidationParse.doc, expectedDoc)
      }
    })
    // Which of the editor's directly adjacent lists the file reads as one
    // (editor-list-join.js): the edit printed against the current source,
    // typed list markers included. Unverified on purpose — only the list
    // markers it writes are read.
    readsAsOneList = (doc) => {
      const source = String(lastMarkdownRef.current ?? '')
      const printed = reprintSource({ ...reprintDeps(), source, editorDoc: doc, escape: 'minimal', newListMarkers: pendingListIntentMarkers() })
      return printed?.ok ? listsReadAsOne(printed.markdown, doc, crepe.editor.ctx.get(remarkCtx)) : new Set()
    }
    const shadowReprint = (phase, { previousSource, publishedMarkdown = null, doc }) => {
      if (window.api?.inputTraceEnabled !== true || !doc || typeof previousSource !== 'string') return
      if (!Array.isArray(globalThis.__hmSourceReprintShadowTrace)) globalThis.__hmSourceReprintShadowTrace = []
      const started = performance.now()
      if (!Array.isArray(globalThis.__hmSourceIntegrityDiffTrace)) globalThis.__hmSourceIntegrityDiffTrace = []
      const diffMark = globalThis.__hmSourceIntegrityDiffTrace.length
      let result
      try {
        result = reprintVerified({ ...reprintDeps(), source: previousSource, editorDoc: doc })
      } catch (error) {
        result = { ok: false, reason: `threw:${error?.message || error}` }
      }
      // First semantic difference of the engine's own verification (why it
      // failed), for fuzz triage.
      const engineDiff = !result.ok && globalThis.__hmSourceIntegrityDiffTrace.length > diffMark
        ? globalThis.__hmSourceIntegrityDiffTrace[globalThis.__hmSourceIntegrityDiffTrace.length - 1]
        : null
      const sameAsCurrent = publishedMarkdown == null ? null : result.markdown === publishedMarkdown
      globalThis.__hmSourceReprintShadowTrace.push({
        phase,
        at: Date.now(),
        ok: result.ok === true,
        verified: result.verified === true,
        reason: result.reason || null,
        sameAsCurrent,
        levels: (result.notes || []).map((note) => note.level).filter(Boolean),
        ms: Math.round(performance.now() - started),
        ...(result.ok && sameAsCurrent === false
          ? { previous: previousSource, current: publishedMarkdown, reprinted: result.markdown }
          : {}),
        ...(!result.ok ? {
          previous: previousSource,
          attempted: result.markdown ?? null,
          engineDiff: engineDiff ? JSON.stringify(engineDiff).slice(0, 1500) : null,
          notes: (result.notes || []).slice(0, 12)
        } : {})
      })
      if (globalThis.__hmSourceReprintShadowTrace.length > 400) globalThis.__hmSourceReprintShadowTrace.shift()
    }
    // The source reprint is the only rich → source writer
    // (docs/source-reprint-architecture.md, docs/reprint-root-cause-plan.md):
    // the editor document is reprinted against the committed source, verified
    // directly against that document, then published through the Coordinator.
    // When even its whole-document print fails the guard, the edit pauses.
    let publishingReprint = false
    // The opened document and its source: the editor document paired with
    // the source before the first edit (the Coordinator's snapshot is made
    // lazily, on that edit, from the edited document).
    let openedSourcePair = null
    const publishReprint = ({ canonical, boundary, notifyChange = true, newListMarkers = null, force = false }) => {
      const trace = (entry) => {
        if (!Array.isArray(globalThis.__hmSourceReprintTrace)) return
        // Why the reprint did not publish, counted for the session (the
        // fallback writers run after these).
        if (entry.phase !== 'published') {
          const tally = (globalThis.__hmReprintTally ||= {})
          const key = `${boundary}|${entry.phase}|${entry.reason || '-'}`
          tally[key] = (tally[key] || 0) + 1
        }
        globalThis.__hmSourceReprintTrace.push({ boundary, ...entry })
        if (globalThis.__hmSourceReprintTrace.length > 100) globalThis.__hmSourceReprintTrace.shift()
      }
      if (!force && proseComposing(viewRef.current)) {
        trace({ phase: 'skipped', reason: 'composing' })
        return null
      }
      const doc = withoutSyntheticTitle(dispatchingExpectedDoc ?? viewRef.current?.state.doc)
      const source = String(lastMarkdownRef.current ?? '')
      if (!doc || typeof canonical !== 'string') return null
      let result
      try {
        // The editor document paired with `source` (Coordinator checkpoint):
        // lets the engine see editor-only edits such as removing an empty line.
        // (Only once ready: the Coordinator is created lazily on first access.)
        const snapshot = ready ? sourceSyncBridge?.getSnapshot?.() : null
        const paired = [snapshot, openedSourcePair].find((pair) => pair?.doc && pair.source === source)
        const previousDoc = paired && paired.doc !== doc ? paired.doc : null
        result = reprintVerified({ ...reprintDeps(), source, editorDoc: doc, previousDoc, newListMarkers })
      } catch {
        trace({ phase: 'declined', reason: 'threw' })
        return null
      }
      if (!result?.ok || !result.verified) {
        trace({ phase: 'declined', reason: result?.reason || 'unverified' })
        return null
      }
      const levels = (result.notes || []).map((note) => note.level).filter(Boolean)
      const proof = Object.freeze({
        kind: 'source-reprint-proof',
        levels: Object.freeze(levels),
        escape: result.escape,
        trailingEmptyBlockquotePaths: trailingEmptyQuotePaths(doc)
      })
      const reprintResult = Object.freeze({
        markdown: result.markdown,
        preserved: true,
        reason: 'source-reprint',
        integrityProof: proof
      })
      const ownership = Object.freeze({
        ok: true,
        decision: 'owned',
        owner: SOURCE_SYNC_OWNERS.TRANSACTION,
        family: 'source-reprint',
        boundary,
        reason: 'source-reprint',
        proof,
        result: reprintResult,
        canonical,
        expectedDoc: doc
      })
      let coordinated = null
      publishingReprint = true
      try {
        coordinated = sourceSyncBridge.publishOwned({ ownership, notifyChange, boundary })
      } catch {
        coordinated = null
      } finally {
        publishingReprint = false
      }
      trace({ phase: coordinated?.ok ? 'published' : 'rejected', reason: coordinated?.reason || null, levels })
      if (!coordinated?.ok) return null
      lastReprintPrintedNewList = levels.includes('new-list-marker')
      wholeDocumentReplacementPending = null
      return result.markdown
    }
    // A command that changed the document itself (list conversion, slash
    // block, front matter / inline code value): reprint-only publishes the
    // reprint of the live document right away; nothing else writes it.
    const publishReprintNow = (doc) => {
      const canonical = canonicalForSource(crepe.editor.ctx.get(serializerCtx)(doc))
      const published = publishReprint({ canonical, boundary: 'source-reprint-command', notifyChange: true })
      if (published == null) {
        reportSourceSyncFailure('source-reprint-failed')
        return false
      }
      clearRichFlushPending()
      return true
    }
    sourceSyncBridge = createEditorSourceSyncBridge({
      checkpointStore: sourceIntegrityCheckpoints,
      getSource: () => lastMarkdownRef.current,
      getCanonical: () => canonicalMarkdownRef.current,
      // During dispatch (handleSourceTransactions runs before
      // view.updateState) a publication about the dispatched document must be
      // checked against THAT document, not the still-old view state.
      getExpectedDoc: () => withoutSyntheticTitle(dispatchingExpectedDoc ?? viewRef.current?.state.doc),
      setSource: (markdown) => {
        const previous = lastMarkdownRef.current
        lastMarkdownRef.current = markdown
        if (previous !== markdown && !publishingReprint) {
          shadowReprint('publish', {
            previousSource: previous,
            publishedMarkdown: markdown,
            doc: dispatchingExpectedDoc ?? viewRef.current?.state.doc
          })
        }
      },
      setCanonical: (canonical) => { canonicalMarkdownRef.current = canonical },
      onChange: (markdown) => onChange?.(markdown, false),
      validateCandidate: validateSourceCandidate,
      trace: (entry) => {
        if (!Array.isArray(globalThis.__hmSourceSyncCoordinatorTrace)) return
        globalThis.__hmSourceSyncCoordinatorTrace.push(entry)
        // Which writer published, counted for the whole session (the trace
        // keeps only the last 100): how much the fallback writers still do.
        if (entry?.phase === 'published') {
          const tally = (globalThis.__hmPublishTally ||= {})
          const key = `${entry.family || '?'}|${entry.reason || '?'}`
          tally[key] = (tally[key] || 0) + 1
          // A fallback writer published: what the reprint did just before.
          if (entry.family !== 'source-reprint') {
            const last = (globalThis.__hmSourceReprintTrace || []).at(-1)
            const cause = last ? `${last.boundary}|${last.phase}|${last.reason || (last.phase === 'gated' ? ['paste', 'list', 'whole', 'intent'].filter((flag) => last[flag]).join('+') : '-')}` : 'no-reprint-trace'
            const causes = (globalThis.__hmLegacyCause ||= {})
            causes[`${key} <- ${cause}`] = (causes[`${key} <- ${cause}`] || 0) + 1
          }
        }
        if (globalThis.__hmSourceSyncCoordinatorTrace.length > 100) {
          globalThis.__hmSourceSyncCoordinatorTrace.shift()
        }
      }
    })
    let lastSourceSyncWarning = null
    const reportSourceSyncFailure = (reason, { rescue = true } = {}) => {
      // Last resort before pausing: the source reprint of the live document,
      // verified directly against it — unless the reprint itself just failed
      // (it would only fail again).
      if (rescue && reason !== 'source-reprint-failed') try {
        const doc = viewRef.current?.state.doc
        if (doc && !proseComposing(viewRef.current)) {
          const canonical = canonicalForSource(crepe.editor.ctx.get(serializerCtx)(doc))
          const rescued = publishReprint({ canonical, boundary: 'source-reprint-rescue', notifyChange: true, newListMarkers: pendingListIntentMarkers() })
          if (rescued != null) {
            clearRichFlushPending()
            return true
          }
        }
      } catch {
        // fall through to the established failure handling
      }
      const now = Date.now()
      const signature = String(reason || 'source-document-mismatch')
      if (lastSourceSyncWarning?.signature === signature && now - lastSourceSyncWarning.at < 1500) return
      lastSourceSyncWarning = { signature, at: now }
      shadowReprint('failure', { previousSource: lastMarkdownRef.current, doc: viewRef.current?.state.doc })
      traceEditorEvent('source-sync-integrity-failure', { reason: signature })
      // Persist the in-page decision evidence next to the input log so a
      // user-test divergence can be diagnosed after the app quits. Doc-shaped
      // fields (parsed/expected/candidate) are dropped — digests, reasons,
      // steps and proofs are what locate a first-divergence.
      if (window.api?.inputTraceEnabled === true) {
        const tail = (key, size) => (Array.isArray(globalThis[key]) ? globalThis[key].slice(-size) : [])
        traceEditorEvent('source-sync-evidence-dump', {
          reason: signature,
          diff: tail('__hmSourceIntegrityDiffTrace', 6),
          preserve: tail('__hmPreserveLog', 12).map(({ source, previous, next, markdown, ...entry }) => entry),
          integrity: tail('__hmSourceIntegrityTrace', 12).map((entry) => ({
            ok: entry?.ok,
            semanticOk: entry?.semanticOk,
            listSlotsMatch: entry?.listSlotsMatch,
            preservationReason: entry?.preservationReason,
            validationSite: entry?.validationSite,
            candidateTail: String(entry?.candidate || '').slice(-300),
            canonicalTail: String(entry?.canonical || '').slice(-300)
          })),
          coordinator: tail('__hmSourceSyncCoordinatorTrace', 12),
          journal: tail('__hmSourceSyncTransactionJournalTrace', 12),
          flush: tail('__hmFlushTrace', 8)
        })
      }
      fireToast(tRef.current('save.sourceSyncMismatch'), {
        sticky: true,
        action: syncReportAction(captureSyncReport(signature, 'edit'), tRef.current('syncReport.button'), tRef.current('syncReport.hint'))
      })
    }

    // Block controls live in editor-block-controls.js; mount them here and
    // reuse the same conversion path across shortcuts, menus and toolbars.
    const { setBlock: setEditableBlock, canConvertCurrentBlockToList, convertCurrentBlockToList, reportActiveBlock } = createBlockControls({
      viewRef,
      setCtxMenu,
      onActiveBlock,
      lastBlockRef
    })
    const setBlock = (id, blockPos = null) => {
      if (readOnlyRef.current) return false
      markUserEdit()
      return setEditableBlock(id, blockPos)
    }
    const convertBlockToList = (targetType, blockPos) => {
      if (readOnlyRef.current) return false
      const converted = convertCurrentBlockToList(targetType, blockPos)
      if (!converted) return converted
      markUserEdit()
      // A command: Milkdown may report the change only on a later input, so
      // the reprint of the converted document is published now.
      publishReprintNow(viewRef.current.state.doc)
      return converted
    }
    const canConvertBlockToList = (blockPos) => !readOnlyRef.current && canConvertCurrentBlockToList(blockPos)
    const convertList = (targetType, listPos) => {
      if (readOnlyRef.current) return false
      const view = viewRef.current
      if (!view) return false
      markUserEdit()
      if (!convertListAtSelection(view, targetType, listPos)) return false
      publishReprintNow(view.state.doc)
      view.focus()
      setCtxMenu(null)
      return true
    }

    // IMPORTANT: register listeners BEFORE create(). Crepe wires them during
    // create(), so registering afterwards means `markdownUpdated` never fires —
    // which left tab.content (outline, word count, dirty state, and saves!)
    // frozen at the initial value while the editor was actually edited.
    //
    // `appending` is set while the remaining chunks of a huge doc are being
    // parsed+inserted in the background — those dispatches fire markdownUpdated
    // too, and we must ignore them so tab.content isn't spammed with partial
    // docs. Only real user edits propagate.
    crepe.on((api) => {
      const handleMarkdownUpdatedImpl = (_ctx, md) => {
        const canonical = canonicalForSource(md)
        if (programmaticReplaceRef.current) {
          wholeDocumentReplacementPending = null
          // replaceAll can publish more than one Markdown transaction. Keep all
          // of them outside the user-edit path until the next explicit input
          // calls markUserEdit; consuming only the first callback is racy.
          canonicalMarkdownRef.current = canonical
          return
        }
        // IME composition (pinyin / cangjie / kana …) pushes the in-flight
        // candidate text into the document. Processing markdownUpdated
        // mid-composition captures that transient text and corrupts the source
        // (e.g. "测试" ends up as pinyin fragments "c", "ce", "s"). Defer: PM's
        // `view.composing` is true only while a composition is active, and
        // compositionend fires a final markdownUpdated with the committed
        // characters, which is the only state worth preserving.
        if (proseComposing(viewRef.current)) return
        const pendingPaste = pendingRawMarkdownPasteRef.current
        const pendingWholeDocumentReplacement = wholeDocumentReplacementPending
        if (ready && !appending && (pendingPaste || pendingWholeDocumentReplacement || hasRecentUserEdit())) {
          // A raw Markdown paste / whole-document replacement first tries to
          // keep its own bytes (the clipboard, the replacement text). When
          // they cannot be kept, it goes to the source reprint like every
          // other edit (#171).
          let pasteTokenReleased = false
          if (pendingPaste || pendingWholeDocumentReplacement) {
            if (Array.isArray(globalThis.__hmSourceReprintTrace)) {
              const gate = pendingPaste ? 'paste' : 'whole-document'
              const tally = (globalThis.__hmReprintTally ||= {})
              tally[`source-reprint-markdown-updated|gated|${gate}`] = (tally[`source-reprint-markdown-updated|gated|${gate}`] || 0) + 1
              globalThis.__hmSourceReprintTrace.push({ boundary: 'source-reprint-markdown-updated', phase: 'gated', paste: Boolean(pendingPaste), whole: Boolean(pendingWholeDocumentReplacement) })
            }
            const currentDoc = viewRef.current?.state.doc
            const ownership = pendingPaste
              ? documentReplacementSourceSyncOwner.planRawMarkdownPaste({
                  token: pendingPaste,
                  activeToken: pendingRawMarkdownPasteRef.current,
                  currentSource: lastMarkdownRef.current,
                  currentCanonical: canonicalMarkdownRef.current,
                  canonical,
                  expectedDoc: currentDoc
                })
              : documentReplacementSourceSyncOwner.planWholeDocumentReplacement({
                  token: pendingWholeDocumentReplacement,
                  activeToken: wholeDocumentReplacementPending,
                  currentSource: lastMarkdownRef.current,
                  currentCanonical: canonicalMarkdownRef.current,
                  canonical,
                  replacementCanonical: generatedScratchMarkdown(canonical),
                  expectedDoc: currentDoc
                })
            // A multi-transaction paste lets the first transaction's callback
            // publish and advance the baseline before this one runs, so the
            // token can be stale here (plan) or at publish time: release it and
            // let the reprint take the edit.
            const coordinatedReplacement = ownership.ok ? sourceSyncBridge.publishOwned({ ownership }) : null
            if (coordinatedReplacement?.ok) {
              wholeDocumentReplacementPending = null
              clearRichFlushPending()
              pendingRawMarkdownPasteRef.current = null
              userEditUntil = Date.now() + 1000
              return
            }
            pendingRawMarkdownPasteRef.current = null
            wholeDocumentReplacementPending = null
            pasteTokenReleased = true
            traceEditorEvent('paste-token-released', {
              stage: ownership.ok ? 'publish' : 'plan',
              reason: (ownership.ok ? coordinatedReplacement?.reason : ownership.reason) || null
            })
          }
          const hasPendingListIntent = hasBlockingListInputIntent()
          const intentMarkers = hasPendingListIntent ? pendingListIntentMarkers() : null
          const reprinted = publishReprint({
            canonical,
            boundary: pasteTokenReleased ? 'source-reprint-after-paste' : 'source-reprint-markdown-updated',
            notifyChange: true,
            newListMarkers: intentMarkers
          })
          if (reprinted != null) {
            if (hasPendingListIntent) settleListIntentsAfterReprint()
            clearRichFlushPending()
            userEditUntil = Date.now() + 1000
            return
          }
          // No other writer takes the edit: the pause (the reprint's own
          // ladder already tried every degraded print).
          reportSourceSyncFailure('source-reprint-failed')
        }
      }
      // Typing-yield scheduling (P7c-latency, user report 2026-09-13): on a
      // large document the sync pipeline (canonicalize + preserve + validate,
      // ~1s+ measured on the 333K redis doc) runs on every markdownUpdated
      // and saturates the main thread BETWEEN keystrokes — the user types and
      // characters appear only after ~90ms+ per-key lag. IME composition
      // already defers the whole callback for exactly this reason; extend the
      // same policy to plain typing, ADAPTIVELY: only when the last pipeline
      // run exceeded SYNC_DEFER_THRESHOLD_MS (small docs never defer), and
      // only while the user is actively editing. The trailing idle timer
      // processes the LATEST markdown (later callbacks reschedule it), with a
      // hard cap so continuous typing still syncs periodically. Journals
      // accumulate across revisions by design, and forced-flush boundaries
      // (mode switch, save, export) process immediately — correctness is
      // unchanged, only WHEN the idle-time pipeline runs.
      let markdownSyncLastMs = 0
      let markdownSyncDeferTimer = null
      let markdownSyncDeferSince = 0
      const SYNC_DEFER_THRESHOLD_MS = 150
      const SYNC_DEFER_IDLE_MS = 600
      const SYNC_DEFER_MAX_MS = 5000
      cancelDeferredMarkdownSync = () => {
        if (markdownSyncDeferTimer) clearTimeout(markdownSyncDeferTimer)
        markdownSyncDeferTimer = null
        markdownSyncDeferSince = 0
      }
      const runMarkdownSyncPipeline = (md) => {
        // Immediate execution and forced flush invalidate older queued work.
        cancelDeferredMarkdownSync()
        const started = performance.now()
        try {
          handleMarkdownUpdatedImpl(null, md)
        } finally {
          markdownSyncLastMs = performance.now() - started
        }
      }
      // Listen to `updated` (the document), not `markdownUpdated`: Milkdown
      // serializes the whole document for markdownUpdated listeners on every
      // 200 ms typing pause, even while a large document's sync is deferred
      // and that string is never used (~0.5 s per pause on Windows). The
      // document is serialized here only when the pipeline runs now (the
      // memoized serializer, so the pipeline's own calls reuse it).
      isMarkdownSyncPending = () => {
        if (markdownSyncDeferTimer) return true
        const doc = viewRef.current?.state.doc
        // Milkdown only skips its callback when the document equals the one
        // it delivered last (e.g. typed and reverted): then nothing is coming.
        return Boolean(doc && deliveredDoc && doc !== deliveredDoc && !doc.eq(deliveredDoc))
      }
      api.updated((_ctx, doc) => {
        deliveredDoc = doc
        // Cold start: the FIRST callback on a large document must not pay the
        // full pipeline synchronously just to learn it is heavy (CPU profile
        // of the redis doc: whole-doc remark reparse dominates). Seed the
        // metric from the document size; a real measurement replaces it after
        // the first deferred run.
        if (markdownSyncLastMs === 0 && doc?.content?.size > 100000) {
          markdownSyncLastMs = 1000
        }
        // A large document stays deferred while typing even once its sync is
        // fast (incremental parse): a sync per keystroke still costs more
        // than one after the pause.
        const heavyDocPipeline = markdownSyncLastMs > SYNC_DEFER_THRESHOLD_MS || isLargeSyncDocument(doc)
        const activelyEditing = ready && !appending &&
          !pendingRawMarkdownPasteRef.current && !wholeDocumentReplacementPending &&
          !programmaticReplaceRef.current && !proseComposing(viewRef.current) &&
          hasRecentUserEdit()
        if (heavyDocPipeline && activelyEditing) {
          const overdue = markdownSyncDeferSince > 0 &&
            Date.now() - markdownSyncDeferSince >= SYNC_DEFER_MAX_MS
          if (!overdue) {
            if (markdownSyncDeferTimer) clearTimeout(markdownSyncDeferTimer)
            else markdownSyncDeferSince = Date.now()
            markdownSyncDeferTimer = setTimeout(() => {
              markdownSyncDeferTimer = null
              markdownSyncDeferSince = 0
              const view = viewRef.current
              if (!view || proseComposing(view) || !richFlushPending) return
              // PM may have advanced since Milkdown supplied this callback,
              // even before its next callback arrives. Pair candidate bytes
              // and expectedDoc from the SAME live document at execution time.
              try {
                const currentMarkdown = crepe.editor.ctx.get(serializerCtx)(view.state.doc)
                runMarkdownSyncPipeline(currentMarkdown)
              } catch {
                reportSourceSyncFailure('deferred-source-serialization-failed')
              }
            }, SYNC_DEFER_IDLE_MS)
            return
          }
          markdownSyncDeferSince = 0
        }
        let md
        try {
          md = crepe.editor.ctx.get(serializerCtx)(doc)
        } catch {
          reportSourceSyncFailure('source-serialization-failed')
          return
        }
        runMarkdownSyncPipeline(md)
      })
      cleanups.push(() => cancelDeferredMarkdownSync())
    })

    const runCreate = () =>
      crepe
        .create()
        .then(() => {
          if (destroyed) {
            crepe.destroy()
            return
          }
          // Mark input rules fire only on what was just typed, never inside
          // inline code (Milkdown's underscore rule lacked its `$` anchor).
          try {
            guardMarkInputRules(crepe.editor.ctx.get(inputRulesCtx), crepe.editor.ctx.get(schemaCtx))
          } catch { /* keep Milkdown's rules */ }
          // Reuse parses of the same Markdown across the sync's checks.
          try {
            crepe.editor.ctx.set(parserCtx, memoizeLastParses(crepe.editor.ctx.get(parserCtx)))
          } catch { /* keep the plain parser */ }
          // Serializing the whole document is ~0.4 s on a 350 KB file and one
          // sync did it up to three times for the same document (Milkdown's
          // listener, the flush, the validator). Documents are immutable, so
          // the result is reused per document — and per serializer style
          // object, which source-mode replaceMarkdown swaps out.
          try {
            const baseSerializer = crepe.editor.ctx.get(serializerCtx)
            const serialized = new WeakMap()
            // Milkdown's heading-id plugin follows every heading edit with a
            // transaction that only rewrites heading `id`s, and the heading
            // serializer writes `level` only: such a document serializes to
            // the same bytes as the one before it. The sync used to
            // serialize the whole document again for it twice (~0.1 s each
            // on Windows for a 250 K-char file) on every heading change.
            const recent = []
            const incrementalSerializer = createIncrementalSerializer({
              serialize: baseSerializer,
              scheduleIdle: (run) => (typeof requestIdleCallback === 'function'
                ? requestIdleCallback(run, { timeout: 2000 })
                : setTimeout(run, 50)),
              check: () => globalThis.__hmIncrementalSerializeCheck === true,
              isPrimary: (doc) => doc === viewRef.current?.state.doc,
              onMismatch: (report) => {
                traceEditorEvent('incremental-serialize-mismatch', report)
                if (globalThis.__hmIncrementalSerializeCheck === true) {
                  fireToast(`增量序列化与整篇序列化不一致（${report.reason}）`, { sticky: true })
                }
              }
            })
            incrementalSerializerRef.current = incrementalSerializer
            cleanups.push(() => incrementalSerializer.dispose())
            fullSerializerRef.current = baseSerializer
            // Diagnostics (perf benches): every open editor's counters. The
            // entry is removed on destroy — it captures this editor, so a
            // closed tab would otherwise keep its whole editor alive.
            const diagnostics = {
              stats: incrementalSerializer.stats,
              children: () => viewRef.current?.state.doc.childCount ?? 0
            }
            ;(globalThis.__hmIncrementalSerializeAll ??= []).push(diagnostics)
            cleanups.push(() => {
              const all = globalThis.__hmIncrementalSerializeAll
              const index = all ? all.indexOf(diagnostics) : -1
              if (index >= 0) all.splice(index, 1)
            })
            const memoSerializer = (doc) => {
              const keyed = doc && typeof doc === 'object'
              const style = serializerStyleHolder.style
              const hit = keyed ? serialized.get(doc) : null
              if (hit && hit.style === style) return hit.markdown
              if (keyed) {
                const twin = recent.find((entry) => entry.style === style && entry.doc.deref?.() && sameIgnoringHeadingIds(entry.doc.deref(), doc))
                if (twin) {
                  serialized.set(doc, { style, markdown: twin.markdown })
                  incrementalSerializer.adoptEquivalent(twin.doc.deref(), doc)
                  return twin.markdown
                }
              }
              // Large documents: only the changed blocks are serialized again
              // (lib/incremental-serialize.js; proven per call, else full).
              const markdown = keyed ? incrementalSerializer.serialize(doc, style) : baseSerializer(doc)
              if (keyed) {
                serialized.set(doc, { style, markdown })
                recent.unshift({ doc: new WeakRef(doc), style, markdown })
                recent.length = Math.min(recent.length, 2)
              }
              return markdown
            }
            crepe.editor.ctx.set(serializerCtx, memoSerializer)
          } catch { /* keep the plain serializer */ }

          // P7 root fix: mirror the authored list spelling in the serializer
          // (bullet, ordered delimiter, loose/tight, hard-break, strong). The
          // serializer's defaults (`*`, padded, `1)`) made every authored
          // compact `-`/`1.` document permanently diverge from its own
          // canonical form, which is the structural source of the whole
          // "diverged list" warning family. Style application is per editor
          // instance; source-mode replaceMarkdown() re-detects on new bytes.
          try {
            const styledRemark = crepe.editor.ctx.get(remarkCtx)
            applySerializerStyleToRemark(styledRemark, serializerStyleHolder)
          } catch {
            /* keep the stock serializer if the context is unavailable */
          }
        // Milkdown stores the ProseMirror view in its context — `editor.view`
        // does not exist in this version, which previously left `view`
        // undefined and silently disabled every view-dependent feature.
        let view
        try {
          view = crepe.editor.ctx.get(editorViewCtx)
        } catch {
          view = crepe.editor?.view
        }
        viewRef.current = view

        // Issue #10 (belt-and-suspenders): guarantee the inline-code mark is
        // non-inclusive on the live schema, in case Crepe's plugin order left the
        // extendSchema override (above) ineffective. ResolvedPos.marks() reads
        // `mark.type.spec.inclusive === false` to drop the mark at a span's end,
        // so the caret exits `code` on the next character either way.
        try {
          const icMark = view?.state.schema.marks.inlineCode
          if (icMark && icMark.spec.inclusive !== false) icMark.spec.inclusive = false
        } catch {
          /* schema shape changed — extendSchema override still applies */
        }

        // Typora-theme hooks: most Typora themes target `#write` (the content
        // container) and `.markdown-body`. Tagging the ProseMirror element with
        // both lets a migrated Typora CSS style our editor. (Several editors can
        // be mounted at once, so `id="write"` may repeat — invalid HTML but
        // harmless: CSS `#write` still matches all, and we never getElementById it.)
        if (view?.dom) {
          view.dom.id = 'write'
          view.dom.classList.add('markdown-body')
          // English spell-check (red wavy underline) on the contenteditable.
          // Default off (settings.spellcheck). Other surfaces (source textarea,
          // inputs) opt out individually via spellCheck={false}.
          view.dom.setAttribute('spellcheck', spellcheckRef.current ? 'true' : 'false')
          view.dom.setAttribute('aria-readonly', readOnlyRef.current ? 'true' : 'false')
          // Keep the freshly-created DOM non-editable until its canonical
          // source baseline has been captured below. See interactionReadyRef.
          try { view.setProps({ editable: () => interactionReadyRef.current && !readOnlyRef.current }) } catch { /* */ }
          view.dom.contentEditable = 'false'
          view.dom.dataset.horsemdReady = 'false'
        }

        // Content is in the DOM now — remove the loading skeleton SYNCHRONOUSLY
        // (flushSync) so it's gone before the heavy getMarkdown + onChange work
        // below. A plain setState here would be batched and its repaint blocked by
        // that work, leaving the skeleton visibly overlapping the rendered text
        // for hundreds of ms (worse when toggling source↔rich on a big doc).
        flushSync(() => setLoaded(true))

        mountEditorDomBindings({
          view,
          viewRef,
          host,
          docPath,
          crepe,
          liveEditors,
          self,
          cleanups,
          markUserEdit,
          onRichEditPending: (delayMs) => {
            onRichEditPending?.()
            scheduleRichDirtyReconcile(delayMs)
          },
          insertUploadedImage,
          prepareRawMarkdownPaste: ({ markdown, from, to }) => {
            const source = lastMarkdownRef.current || ''
            const canonical = canonicalMarkdownRef.current || ''
            const oldDoc = view.state.doc
            let next = markdown
            const replacesWholeDocument = from <= 1 && to >= oldDoc.content.size
            if (source && !replacesWholeDocument) {
              try {
                const remark = crepe.editor.ctx.get(remarkCtx)
                const rawFrom = pmPosToMarkdownOffset(source, from, view.state.doc, remark)
                const rawTo = pmPosToMarkdownOffset(source, to, view.state.doc, remark)
                if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo)) return null
                // Never between the CR and LF of a line ending (a mapped
                // offset can land there in a CRLF file: `正文。\r` + paste).
                const outsideCrlf = (offset) => (source[offset - 1] === '\r' && source[offset] === '\n' ? offset - 1 : offset)
                const start = outsideCrlf(Math.min(rawFrom, rawTo))
                const end = outsideCrlf(Math.max(rawFrom, rawTo))
                let before = source.slice(0, start)
                let after = source.slice(end)
                // The pasted lines take the line ending of the line they land
                // on (the clipboard's own made a CRLF file mixed, #171).
                const eol = localLineEnding(source, start)
                const pasted = markdown.replace(/\r?\n/g, eol)
                // Pasted into an empty top-level paragraph (a new line after
                // Enter): that line has no bytes in the source, so the paste
                // landed right against the block before it (`尾段\n## 标题`).
                // The pasted blocks get a blank line on each side (Typora).
                const $from = oldDoc.resolve(from)
                if (from === to && $from.depth === 1 && $from.parent.type.name === 'paragraph' && !$from.parent.content.size) {
                  if (before.trim()) before = before.replace(/[ \t]*(?:\r?\n[ \t]*)*$/, '') + eol + eol
                  const tail = after.replace(/^(?:[ \t]*\r?\n)+/, '')
                  after = tail.trim() ? eol + eol + tail : (/\n$/.test(source) ? eol : '')
                  next = before + pasted.replace(/(?:\r?\n)+$/, '') + after
                } else {
                  next = before + pasted + after
                }
              } catch {
                return null
              }
            }
            const captured = documentReplacementSourceSyncOwner.captureRawMarkdownPaste({
              source,
              canonical,
              oldDoc,
              markdown: next,
              from,
              to,
              replacesWholeDocument
            })
            if (!captured.ok) return null
            const pending = captured.token
            pendingRawMarkdownPasteRef.current = pending
            return () => {
              if (pendingRawMarkdownPasteRef.current === pending) {
                pendingRawMarkdownPasteRef.current = null
              }
            }
          },
          reportActiveBlock,
          setBlock,
          canConvertBlockToList,
          getListConversionContext,
          setCtxMenu,
          setZoom,
          getT: (key) => tRef.current(key),
          getKeybindings: () => effectiveKeybindingsRef.current,
          getSelectionToolbarEnabled: () => selectionToolbarRef.current,
          onMarkdownInputIntent: (intent) => {
            // The marker the user typed spells the new list in the reprint
            // (pendingListIntentMarkers).
            pendingMarkdownInputIntent = {
              ...intent,
              at: Date.now(),
              source: lastMarkdownRef.current,
              batchUntil: Date.now() + 3000
            }
            if (Array.isArray(globalThis.__hmListIntentTrace)) {
              globalThis.__hmListIntentTrace.push({
                marker: intent.marker,
                sourceLength: lastMarkdownRef.current.length
              })
            }
            // Intents are valid only against the source snapshot in which the
            // marker was captured. A previous list input can remain in the
            // queue when its markdownUpdated callback is deferred; if the user
            // then edits another block and starts a new list, carrying that old
            // intent forward lets it rewrite the new list with stale offsets
            // and serializer defaults (`1`, `-`, `*`, and a phantom next row).
            // Keep multiple intents only when they belong to the same current
            // source snapshot (the outer + nested input-rule batch case).
            pendingMarkdownInputIntents = [
              ...pendingMarkdownInputIntents.filter((pending) =>
                isActiveListInputIntent(pending) &&
                pending.source === lastMarkdownRef.current
              ),

              pendingMarkdownInputIntent
            ]
            if (Array.isArray(globalThis.__hmListIntentTrace)) {
              globalThis.__hmListIntentTrace.push({
                phase: 'prune-stale-input-intents',
                kept: pendingMarkdownInputIntents.length,
                sourceLength: lastMarkdownRef.current.length
              })
            }
            traceEditorEvent('markdown-input-intent', pendingMarkdownInputIntent)
          },
          isReadOnly: () => readOnlyRef.current,
          isDestroyed: () => destroyed
        })

        mountEditorInputTrace({
          host,
          view,
          cleanups
        })
        mountSyncEventLog({ view, log: syncEventLog, cleanups })

        // Typora-style new document: first line is an empty Heading 1 (title),
        // with an empty paragraph below it. The title is there if you want it,
        // but the body block lets you skip the title and start writing straight
        // away (click it or press ↓). Done before the baseline below so the new
        // tab isn't marked dirty.
        if (view && !readOnlyRef.current) {
          const { state } = view
          const doc = state.doc
          const first = doc.firstChild
          const headingType = state.schema.nodes.heading
          const paragraphType = state.schema.nodes.paragraph
          if (
            headingType &&
            paragraphType &&
            doc.childCount === 1 &&
            first &&
            first.type.name === 'paragraph' &&
            first.content.size === 0
          ) {
            hasSyntheticEmptyTitle = true
            let tr = state.tr.setNodeMarkup(0, headingType, { level: 1 })
            tr = tr.insert(tr.doc.content.size, paragraphType.create())
            // Leave the cursor in the title; the body paragraph is one ↓ / click away.
            tr = tr.setSelection(TextSelection.create(tr.doc, 1))
            view.dispatch(tr)
          }
        }

        const api = createEditorApi({
          viewRef,
          crepe,
          crepeRef,
          lastMarkdownRef,
          canonicalMarkdownRef,
          programmaticReplaceRef,
          serializerStyleHolder,
          hasPendingRichFlush: () => richFlushPending,
          clearPendingRichFlush: clearRichFlushPending,
          // ProseMirror documents are immutable: the same object means not a
          // single change since the Coordinator verified the source for it.
          isLiveDocCommitted: () => {
            if (!ready) return false
            const doc = viewRef.current?.state.doc
            if (!doc) return false
            // Equal content (Node.eq: same types, attrs, marks and text) has
            // the same Markdown, e.g. a character typed and deleted again.
            const pairs = (pair) => Boolean(pair?.doc && (pair.doc === doc || pair.doc.eq(doc)) &&
              pair.source === lastMarkdownRef.current &&
              pair.canonical === canonicalMarkdownRef.current)
            return pairs(sourceSyncBridge?.getSnapshot?.())
          },
          recordSourceSnapshot: sourceSnapshotHistory.record,
          canonicalForSource,
          setBlock,
          markUserEdit,
          onStructureChange,
          isDestroyed: () => destroyed,
          getT: (key) => tRef.current(key),
          notify: fireToast,
          publishReprint: ({ canonical }) => {
            const intentPending = hasBlockingListInputIntent()
            const newListMarkers = intentPending ? pendingListIntentMarkers() : null
            // A save / source switch writes what the editor holds, composing or not.
            const published = publishReprint({ canonical, boundary: 'source-reprint-forced-flush', notifyChange: false, newListMarkers, force: true })
            if (published != null) {
              if (intentPending) settleListIntentsAfterReprint()
              // A pending paste is in the published source now.
              pendingRawMarkdownPasteRef.current = null
            }
            return published
          },
          reportSourceSyncFailure
        })
        api.convertList = convertList
        api.convertBlockToList = convertBlockToList
        const {
          getPdfSource,
          getMarkdown,
          toggleHighlight,
          applyReviewMarkup,
          replaceMarkdown,
          flushMarkdown,
          flushMarkdownSettled,
          getRecoveryMarkdown,
          restoreMarkdownOffset,
          markdownOffsetFromSelection,
          markdownOffsetFromViewportTop
        } = api
        apiRef.current = api
        // DEV-only CDP test hook (scripts/test-substitution.mjs). Exposes the
        // active editor so the harness can drive the REAL 替换 command, read
        // markdown, and simulate a markdown paste (parser + remark plugins, so
        // `{~~old~>new~~}` reconstructs like a real paste). Stripped in prod
        // builds (import.meta.env.DEV is false after `npm run build`).
        if (import.meta.env && import.meta.env.DEV) {
          window.__horsemd = Object.assign(window.__horsemd || {}, {
            getView: () => viewRef.current,
            getMarkdown,
            applyReviewMarkup,
            focus: () => {
              viewRef.current && viewRef.current.focus()
              return true
            },
            selectRange: (from, to) => {
              const v = viewRef.current
              if (!v) return 'no-view'
              v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)))
              v.focus()
              return true
            },
            clear: () => {
              const v = viewRef.current
              if (!v) return 'no-view'
              v.dispatch(v.state.tr.delete(0, v.state.doc.content.size))
              return true
            },
            cursorEnd: () => {
              const v = viewRef.current
              if (!v) return 'no-view'
              const end = v.state.doc.content.size
              v.dispatch(
                v.state.tr
                  .setSelection(TextSelection.near(v.state.doc.resolve(end), -1))
                  .scrollIntoView()
              )
              v.focus()
              return end
            },
            getHtml: () => {
              const v = viewRef.current
              return v ? v.dom.innerHTML : 'no-view'
            },
            pasteMarkdown: (md) => {
              const v = viewRef.current
              if (!v) return 'no-view'
              try {
                const parser = crepe.editor.ctx.get(parserCtx)
                const parsed = parser(md)
                const endPos = v.state.doc.content.size
                v.dispatch(v.state.tr.insert(endPos, parsed.content).scrollIntoView())
                return true
              } catch (e) {
                return 'err:' + (e && e.message ? e.message : e)
              }
            }
          })
        }
        onReady?.({
          setBlock,
          getView: () => viewRef.current,
          getPdfSource,
          getMarkdown,
          toggleHighlight,
          applyReviewMarkup,
          replaceMarkdown,
          flushMarkdown,
          flushMarkdownSettled,
          getRecoveryMarkdown,
          getSyncReport: (where) => captureSyncReport('rich-edit-not-mapped', where),
          restoreMarkdownOffset,
          markdownOffsetFromSelection,
          markdownOffsetFromViewportTop
        })

        // Append the remaining chunks of a huge doc in the background so the open
        // never freezes the main thread. The editor is read-only during load to
        // avoid edit/append races; restored after. Yields via setTimeout (NOT
        // requestIdleCallback — that stops firing when the window is occluded,
        // which would leave the final yield pending and the editor read-only).
        // Record Crepe's canonical baseline without replacing the tab's original
        // source. Opening a rich document must never add blank lines, escapes,
        // or list-marker changes before the user edits anything.
        const finishInitial = (recordCanonical) => {
          if (destroyed) return
          if (recordCanonical) {
            try {
              // Source-mode switches and saves serialize `view.state.doc`
              // through serializerCtx (see editor-api.js). Capture the initial
              // baseline through that exact path too: Crepe's cached
              // getMarkdown() can differ in trailing list newlines, making a
              // no-op source switch look like an edit and rewrite source bytes.
              const serializer = crepe.editor.ctx.get(serializerCtx)
              canonicalMarkdownRef.current = canonicalForSource(serializer(view.state.doc))
            } catch {
              try {
                canonicalMarkdownRef.current = canonicalForSource(crepe.getMarkdown())
              } catch { /* editor teardown */ }
            }
          }
          sourceIntegrityCheckpoints.trust(
            lastMarkdownRef.current,
            canonicalMarkdownRef.current,
            { owner: 'bootstrap', reason: 'initial-editor-source-pair' }
          )
          ready = true
          openedSourcePair = { doc: viewRef.current?.state.doc || null, source: lastMarkdownRef.current }
          if (!deliveredDoc) deliveredDoc = viewRef.current?.state.doc || null
          interactionReadyRef.current = true
          // Large documents: warm the sync caches while idle after opening.
          // The first edit's sync would otherwise parse the whole committed
          // source and compute every block's comparison form (~0.3 s for a
          // 350 KB Yuque export on an M-series Mac). Skipped once editing has
          // started (that sync fills the same caches).
          if (isLargeSyncDocument(view.state.doc)) {
            const warm = () => {
              globalThis.__hmSyncWarmup = { at: Date.now(), skipped: true }
              if (destroyed || hasRecentUserEdit() || proseComposing(viewRef.current)) return
              const started = performance.now()
              globalThis.__hmSyncWarmup.skipped = false
              try {
                const source = String(lastMarkdownRef.current ?? '').replace(/^\uFEFF/, '')
                if (!source) return
                const entry = parseMarkdownCached(crepe.editor.ctx.get(remarkCtx), crepe.editor.ctx.get(schemaCtx), source)
                const liveDoc = viewRef.current?.state.doc
                if (liveDoc && entry?.srcDoc) {
                  areSourceDocumentsEquivalent(entry.srcDoc, liveDoc, {
                    ignoreAllTableColumnWidths: true,
                    ignoreEmptyContainerParagraphs: true,
                    recordDifference: false
                  })
                }
              } catch { /* warm-up only */ }
              globalThis.__hmSyncWarmup.ms = Math.round(performance.now() - started)
            }
            const warmTimer = setTimeout(() => {
              if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 3000 })
              else warm()
            }, 1000)
            cleanups.push(() => clearTimeout(warmTimer))
          }
          // The Markdown meaning of a document (lib/source-sync/projection.js,
          // P2): parse(serialize(doc)) with this editor's parser and serializer.
          registerProjector(view.state.schema, {
            // Unmemoized: block projections are many small parses, and the
            // memo (last 3) holds the document's own parses.
            parse: (markdown) => { const parser = crepe.editor.ctx.get(parserCtx); return (parser.unmemoized || parser)(markdown) },
            serialize: (doc) => crepe.editor.ctx.get(serializerCtx)(doc)
          })
          // Test-only harness for the source reprint engine (R1, see
          // docs/source-reprint-architecture.md): the real Crepe parser,
          // serializer and remark chain, exposed only under input trace.
          if (window.api?.inputTraceEnabled === true) {
            const harness = globalThis.__hmSourceReprintHarness = {
              parse: (markdown) => crepe.editor.ctx.get(parserCtx)(markdown),
              // Sync diagnostics test (test:sync-report-ui): a failure that
              // skips the degraded rescue, as a real unmappable edit would,
              // with the source left at its last synced state (`staleSource`).
              forceSyncFailure: (reason, staleSource) => {
                if (typeof staleSource === 'string') lastMarkdownRef.current = staleSource
                return reportSourceSyncFailure(reason, { rescue: false })
              },
              parseTree: (markdown) => { const r = crepe.editor.ctx.get(remarkCtx); return reprintDeps().parseTree(r.runSync(r.parse(markdown), markdown)) },
              serialize: (doc) => crepe.editor.ctx.get(serializerCtx)(doc),
              project: (doc) => projectDocument(doc),
              // Milkdown's serializer without lib/inline-serializer.js.
              serializeMilkdown: (doc) => createMilkdownSerializer(view.state.schema, crepe.editor.ctx.get(remarkCtx))(doc),
              remark: () => crepe.editor.ctx.get(remarkCtx),
              schema: () => view.state.schema,
              liveDoc: () => viewRef.current?.state.doc,
              view: () => viewRef.current,
              docFromJSON: (json) => view.state.schema.nodeFromJSON(json),
              liveSource: () => lastMarkdownRef.current,
              equivalent: (markdown, doc) => validateTransactionMarkdown({ markdown, expectedDoc: doc }) === true,
              // The comparison the source reprint verifies with (empty
              // container paragraphs, ordered numbers, table widths
              // relaxed), without Option A's literal `*`.
              equivalentForReprint: (markdown, doc) => reprintDeps().equivalent(markdown, doc, { literalEmphasis: false }),
              reprint: (source, doc, previousDoc = null) => reprintVerified({ ...reprintDeps(), source, editorDoc: doc, previousDoc })
              ,
              // One reprint level, unverified (diagnostics).
              reprintAt: (source, doc, escape) => reprintSource({ ...reprintDeps(), source, editorDoc: doc, escape })
              ,
              // Lists of `doc` that `markdown` reads as one with the list above
              // (list-boundaries.js; what editor-list-join.js joins).
              listsReadAsOne: (markdown, doc) => [...listsReadAsOne(markdown, doc, crepe.editor.ctx.get(remarkCtx))].map((node) => node.textContent)
              ,
              // Incremental serialization (lib/incremental-serialize.js):
              // counters, and serialize a document through it (the test then
              // compares with `serialize` of a fresh full serializer).
              incrementalSerializeStats: () => ({ ...incrementalSerializerRef.current?.stats, enabled: incrementalSerializerRef.current?.enabled }),
              serializeFull: (doc) => fullSerializerRef.current?.(doc),
              newTransform: (doc) => new Transform(doc),
              // editor-inline-code-atoms.js on a test transform.
              stripCodeFromAtoms: (tr) => stripCodeFromAtoms(tr),
              // Start over from the live document (as after opening it).
              incrementalSerializeRebase: () => {
                const live = viewRef.current?.state.doc
                incrementalSerializerRef.current?.forget()
                return live ? incrementalSerializerRef.current?.serialize(live, serializerStyleHolder.style)?.length : null
              },
              // Differential check of the incremental parse: each text is
              // parsed incrementally from the previous RESULT (so splices
              // build on splices) and compared with a full parse.
              incrementalParseChain: (texts) => {
                const remark = crepe.editor.ctx.get(remarkCtx)
                const schema = view.state.schema
                let base = parseMarkdownFull(remark, schema, texts[0])
                const out = { used: 0, full: 0, mismatches: [] }
                for (let index = 1; index < texts.length; index += 1) {
                  const markdown = texts[index]
                  const full = parseMarkdownFull(remark, schema, markdown)
                  let entry = null
                  try { entry = incrementalParse(base, markdown, remark, schema) } catch (error) { out.mismatches.push({ index, threw: String(error?.stack || error).slice(0, 400) }) }
                  if (!entry) { out.full += 1; base = full; continue }
                  out.used += 1
                  const docSame = full.srcDoc.eq(entry.srcDoc)
                  const treeSame = JSON.stringify(full.mdRoot) === JSON.stringify(entry.mdRoot)
                  const countsSame = JSON.stringify(full.counts) === JSON.stringify(entry.counts)
                  if (!docSame || !treeSame || !countsSame) {
                    out.mismatches.push({ index, docSame, treeSame, countsSame, previous: texts[index - 1], markdown })
                    base = full
                  } else base = entry
                }
                return out
              },
              debugIncremental: (previous, markdown) => {
                const remark = crepe.editor.ctx.get(remarkCtx)
                const schema = view.state.schema
                const base = parseMarkdownFull(remark, schema, previous)
                const entry = incrementalParse(base, markdown, remark, schema)
                const full = parseMarkdownFull(remark, schema, markdown)
                if (!entry) return { used: false }
                const strip = (n) => JSON.stringify(n, (k, v) => (k === 'position' ? undefined : v))
                const kids = (root) => root.children.map((c) => ({ type: c.type, s: c.position?.start?.offset, e: c.position?.end?.offset }))
                const fk = full.mdRoot.children, ek = entry.mdRoot.children
                let first = -1
                for (let i = 0; i < Math.max(fk.length, ek.length); i += 1) if (JSON.stringify(fk[i]) !== JSON.stringify(ek[i])) { first = i; break }
                return { window: entry.incremental, first, fullKid: fk[first] && { type: fk[first].type, pos: fk[first].position, text: markdown.slice(fk[first].position?.start?.offset, fk[first].position?.end?.offset).slice(0, 300), sameNoPos: strip(fk[first]) === strip(ek[first]) }, incKid: ek[first] && { type: ek[first].type, pos: ek[first].position, text: markdown.slice(ek[first].position?.start?.offset, ek[first].position?.end?.offset).slice(0, 300) }, fullKids: kids(full.mdRoot).slice(Math.max(0, first - 3), first + 3), incKids: kids(entry.mdRoot).slice(Math.max(0, first - 3), first + 3), baseKids: kids(base.mdRoot) }
              },
              semanticMemoCheck: (left, right, options = {}) => {
                const previous = globalThis.__hmSemanticMemoCheck
                globalThis.__hmSemanticMemoCheck = true
                const before = (globalThis.__hmSemanticMemoMismatch || []).length
                try { areSourceDocumentsEquivalent(left, right, options) } finally { globalThis.__hmSemanticMemoCheck = previous }
                return (globalThis.__hmSemanticMemoMismatch || []).length === before
              }
            }
            // It captures this editor: drop it with the editor (a closed tab
            // must not stay in memory through it).
            cleanups.push(() => {
              if (globalThis.__hmSourceReprintHarness === harness) delete globalThis.__hmSourceReprintHarness
            })
          }
          try { view.setProps({ editable: () => !readOnlyRef.current }) } catch { /* editor teardown */ }
          if (view.dom) {
            view.dom.contentEditable = readOnlyRef.current ? 'false' : 'true'
            view.dom.setAttribute('aria-readonly', readOnlyRef.current ? 'true' : 'false')
            view.dom.dataset.horsemdReady = 'true'
          }
          reportActiveBlock()
        }
        if (chunks) {
          // chunks[0] is already rendered; append the rest in the background,
          // then finish (no rebase). `appending` suppresses onChange while the
          // doc streams in (see the markdownUpdated handler) — managed here, not
          // inside appendChunks, so the flag stays in this closure.
          const rest = chunks.slice(1)
          if (rest.length) appending = true
          appendChunks({
            rest,
            view,
            getParser: () => { try { return crepe.editor.ctx.get(parserCtx) } catch { return null } },
            isDestroyed: () => destroyed,
            getEditable: () => !readOnlyRef.current,
            onLoadingChange,
            onStructureChange
          }).then(() => {
            if (rest.length) appending = false
            // Source preservation needs the serializer snapshot of the complete
            // document before the first user transaction. Recording it does not
            // rebase or write the authored Markdown; without it, the first rich
            // edit after chunked loading is conservatively discarded because the
            // mapper has no previous canonical state to compare against.
            if (!destroyed) finishInitial(true)
          })
        } else if (isLargeDoc) {
          requestAnimationFrame(() => requestAnimationFrame(() => finishInitial(true)))
        } else {
          finishInitial(true)
        }
      })
      .catch((err) => console.error('Crepe init failed', err))

    // For large docs, defer create() past a paint so the loading skeleton is
    // actually shown before create() blocks the main thread parsing/rendering —
    // otherwise switching to (or first opening) a big tab freezes on the
    // previous view with no feedback. Small docs create immediately.
    if (isLargeDoc) {
      createRaf = requestAnimationFrame(() => {
        createRaf = requestAnimationFrame(() => {
          if (!destroyed) runCreate()
        })
      })
    } else {
      runCreate()
    }

    return () => {
      destroyed = true
      if (createRaf) cancelAnimationFrame(createRaf)
      if (richDirtyReconcileTimer) clearTimeout(richDirtyReconcileTimer)
      cleanups.forEach((fn) => {
        try {
          fn()
        } catch {
          /* ignore */
        }
      })
      viewRef.current = null
      crepeRef.current = null
      try {
        crepe.destroy()
      } catch {
        /* ignore */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-localize the image caption / upload text when the language changes. The
  // editor isn't re-created, so we (1) update the config for images rendered
  // later, and (2) patch the placeholder on any caption inputs already in the
  // DOM — the image-block component caches the config and won't re-read it.
  useEffect(() => {
    const crepe = crepeRef.current
    if (crepe) {
      try {
        crepe.editor.action((ctx) => applyImageText(ctx, t))
      } catch {
        /* editor not ready yet */
      }
    }
    const root = hostRef.current
    if (root) {
      root.querySelectorAll('input.caption-input').forEach((inp) => {
        inp.placeholder = t('image.caption')
      })
    }
  }, [t])

  // The floating bar and context menu reuse the same conversion path as the
  // keyboard shortcuts (defined inside the effect, reached through apiRef).
  const pickBlock = (id) => {
    const changed = apiRef.current?.setBlock(id, ctxMenu?.blockPos) === true
    if (!changed) setCtxMenu(null)
    return changed
  }
  const pickHeadingFold = (meta) => {
    setCtxMenu(null)
    runHeadingFold(viewRef.current, meta)
  }
  const pickListConversion = (targetType, listPos, anchorPos) =>
    apiRef.current?.convertList(targetType, listPos, anchorPos)
  const pickBlockListConversion = (targetType, blockPos) => apiRef.current?.convertBlockToList(targetType, blockPos)
  const pickTextFormat = (format, selection) => {
    const applied = apiRef.current?.applyTextFormat(format, selection)
    if (applied) setCtxMenu(null)
    return applied
  }
  const pickReviewMarkup = (kind, selection) => {
    const applied = apiRef.current?.applyReviewMarkup(kind, selection)
    if (applied) setCtxMenu(null)
    return applied
  }

  return (
    <>
      {/* Placeholder text is baked into the Crepe editor at create() and won't
          follow a language switch. Expose the current translation as a CSS var
          (re-rendered on lang change) and let CSS prefer it over the editor's
          static data-placeholder. */}
      <div
        className="editor-host"
        ref={hostRef}
        style={{ '--hm-placeholder': JSON.stringify(t('editor.placeholder')) }}
      />

      {/* Loading skeleton — pulsing gray bars shown while a large document is
          still parsing/rendering. Gated on document size so small files (which
          load instantly) never flash a placeholder. */}
      {!loaded && isLargeDoc && (
        <div className="editor-skeleton" aria-hidden="true">
          <div className="skel-line skel-title" />
          <div className="skel-line" style={{ width: '94%' }} />
          <div className="skel-line" style={{ width: '99%' }} />
          <div className="skel-line" style={{ width: '86%' }} />
          <div className="skel-line skel-gap" style={{ width: '64%' }} />
          <div className="skel-line" style={{ width: '97%' }} />
          <div className="skel-line" style={{ width: '90%' }} />
          <div className="skel-line" style={{ width: '72%' }} />
          <div className="skel-line skel-gap" style={{ width: '50%' }} />
          <div className="skel-line" style={{ width: '93%' }} />
          <div className="skel-line" style={{ width: '80%' }} />
        </div>
      )}

      {ctxMenu && (
        <>
          <div className="menu-backdrop" onMouseDown={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }} />
          <div className={`block-ctxmenu${ctxMenu.x > window.innerWidth - 410 ? ' block-ctxmenu-submenus-left' : ''}`} style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 210),
            top: Math.max(8, Math.min(ctxMenu.y, window.innerHeight - 360))
          }}>
            <button
              className="block-menu-item"
              data-context-copy
              disabled={!ctxMenu.copySelection}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const copied = ctxMenu.copySelection?.copy() === true
                setCtxMenu(null)
                if (!copied) fireToast(t('editor.copyFailed'))
              }}
            >
              <span className="block-menu-short" aria-hidden="true">⧉</span>
              <span className="block-menu-name">{t('editor.copy')}</span>
              <span className="block-menu-sc">{window.api?.platform === 'darwin' ? '⌘C' : 'Ctrl+C'}</span>
            </button>
            <button
              className="block-menu-item"
              data-context-copy-plain
              disabled={!ctxMenu.copySelection}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const copied = ctxMenu.copySelection?.copy({ plainOnly: true }) === true
                setCtxMenu(null)
                if (!copied) fireToast(t('editor.copyFailed'))
              }}
            >
              <span className="block-menu-short" aria-hidden="true">T</span>
              <span className="block-menu-name">{t('editor.copyPlain')}</span>
            </button>
            {ctxMenu.headingFold && (ctxMenu.headingFold.foldable || ctxMenu.headingFold.anyFolded) && (
              <>
                <div className="block-menu-divider" />
                {ctxMenu.headingFold.foldable && (
                  <button
                    className="block-menu-item"
                    data-heading-fold="toggle"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickHeadingFold({ action: 'toggle', pos: ctxMenu.headingFold.pos })}
                  >
                    <span className="block-menu-short" aria-hidden="true">{ctxMenu.headingFold.folded ? '▸' : '▾'}</span>
                    <span className="block-menu-name">{t(ctxMenu.headingFold.folded ? 'fold.menu.unfold' : 'fold.menu.fold')}</span>
                    <span className="block-menu-sc">{getCommandShortcut('editor.fold.toggle', effectiveKeybindings)}</span>
                  </button>
                )}
                <button
                  className="block-menu-item"
                  data-heading-fold="level"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickHeadingFold({ action: 'level', level: ctxMenu.headingFold.level, fold: true })}
                >
                  <span className="block-menu-short" aria-hidden="true">H{ctxMenu.headingFold.level}</span>
                  <span className="block-menu-name">{t('fold.menu.foldLevel', { level: ctxMenu.headingFold.level })}</span>
                </button>
                {ctxMenu.headingFold.anyFolded && (
                  <button
                    className="block-menu-item"
                    data-heading-fold="unfoldAll"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickHeadingFold({ action: 'unfoldAll' })}
                  >
                    <span className="block-menu-short" aria-hidden="true">▾</span>
                    <span className="block-menu-name">{t('fold.menu.unfoldAll')}</span>
                    <span className="block-menu-sc">{getCommandShortcut('editor.fold.none', effectiveKeybindings)}</span>
                  </button>
                )}
              </>
            )}
            {!ctxMenu.copyOnly && (<>
            <div className="block-menu-divider" />
            {ctxMenu.showTextFormatting && (
              <>
                <div className="block-menu-submenu-parent">
                  <button className="block-menu-item block-menu-submenu-trigger" data-context-submenu-trigger="format" aria-haspopup="menu">
                    <span className="block-menu-short">Aa</span>
                    <span className="block-menu-name">{t('editor.textFormatting')}</span>
                    <span className="block-menu-arrow" aria-hidden="true">›</span>
                  </button>
                  <div className="block-menu-submenu" data-context-submenu="format" role="menu">
                    {[
                      ['bold', 'tb.bold'],
                      ['italic', 'tb.italic'],
                      ['strike', 'tb.strike'],
                      ['code', 'tb.code'],
                      ['link', 'tb.link'],
                      ['highlight', 'tb.highlight']
                    ].map(([format, labelKey]) => (
                      <button
                        key={format}
                        className="block-menu-item block-text-format"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pickTextFormat(format, ctxMenu.selection)}
                      >
                        <span className="block-menu-short">{format === 'bold' ? 'B' : format === 'italic' ? 'I' : format === 'strike' ? 'S' : format === 'code' ? '</>' : format === 'link' ? '↗' : '▰'}</span>
                        <span className="block-menu-name">{t(labelKey)}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="block-menu-divider" />
                <div className="block-menu-submenu-parent">
                  <button className="block-menu-item block-menu-submenu-trigger" data-context-submenu-trigger="review" aria-haspopup="menu">
                    <span className="block-menu-short">↹</span>
                    <span className="block-menu-name">{t('review.toolbar')}</span>
                    <span className="block-menu-arrow" aria-hidden="true">›</span>
                  </button>
                  <div className="block-menu-submenu" data-context-submenu="review" role="menu">
                    {[
                      [REVIEW_KINDS.addition, 'review.add', '+'],
                      [REVIEW_KINDS.deletion, 'review.delete', '-'],
                      [REVIEW_KINDS.substitution, 'review.substitute', '→'],
                      [REVIEW_KINDS.highlight, 'review.highlight', '▣']
                    ].map(([kind, labelKey, symbol]) => (
                      <button
                        key={kind}
                        className="block-menu-item block-review-action"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pickReviewMarkup(kind, ctxMenu.selection)}
                      >
                        <span className="block-menu-short">{symbol}</span>
                        <span className="block-menu-name">{t(labelKey)}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="block-menu-divider" />
              </>
            )}
            {!ctxMenu.listConversion && (
              <div className="block-menu-submenu-parent">
                <button className="block-menu-item block-menu-submenu-trigger" data-context-submenu-trigger="block" aria-haspopup="menu">
                  <span className="block-menu-short">H</span>
                  <span className="block-menu-name">{t('block.turnInto')}</span>
                  <span className="block-menu-arrow" aria-hidden="true">›</span>
                </button>
                <div className="block-menu-submenu" data-context-submenu="block" role="menu">
                  {BLOCK_TYPES.map((b) => (
                    <button key={b.id} className="block-menu-item" onMouseDown={(e) => e.preventDefault()} onClick={() => pickBlock(b.id)}>
                      <span className="block-menu-short">{b.short}</span>
                      <span className="block-menu-name">{t('block.' + b.id)}</span>
                      <span className="block-menu-sc">{getCommandShortcut(b.commandId, effectiveKeybindings)}</span>
                    </button>
                  ))}
                  {ctxMenu.blockListConvertible && (
                    <>
                      <div className="block-menu-divider" />
                      {['bullet_list', 'ordered_list', 'task_list'].map((targetType) => (
                        <button
                          key={targetType}
                          data-block-list-conversion={targetType}
                          className="block-menu-item block-list-conversion"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => pickBlockListConversion(targetType, ctxMenu.blockPos)}
                        >
                          <span className="block-menu-short">
                            {targetType === 'ordered_list' ? '1.' : targetType === 'task_list' ? '☐' : '-'}
                          </span>
                          <span className="block-menu-name">{t('list.convertTo.' + targetType)}</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </div>
            )}
            {ctxMenu.listConversion && (
              <div className="block-menu-submenu-parent">
                <button className="block-menu-item block-menu-submenu-trigger" data-context-submenu-trigger="list" aria-haspopup="menu">
                  <span className="block-menu-short">☷</span>
                  <span className="block-menu-name">{t('list.convert')}</span>
                  <span className="block-menu-arrow" aria-hidden="true">›</span>
                </button>
                <div className="block-menu-submenu" data-context-submenu="list" role="menu">
                  {ctxMenu.listConversion.actions.map((action) => (
                    <button
                      key={action.targetType}
                      data-list-conversion={action.targetType}
                      className="block-menu-item block-list-conversion"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickListConversion(
                        action.targetType,
                        ctxMenu.listConversion.listPos,
                        ctxMenu.listConversion.anchorPos
                      )}
                    >
                      <span className="block-menu-short">
                        {action.targetType === 'ordered_list' ? '1.' : action.targetType === 'task_list' ? '☐' : '-'}
                      </span>
                      <span className="block-menu-name">
                        {t('list.convertTo.' + action.targetType)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {onToggleSourceRichSplit && (
              <>
                <div className="block-menu-divider" />
                <button
                  data-source-rich-toggle
                  className="block-menu-item hm-source-rich-menu-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setCtxMenu(null)
                    onToggleSourceRichSplit()
                  }}
                >
                  <span className="block-menu-short">▯</span>
                  <span className="block-menu-name">
                    {t('status.sourceRich')}
                  </span>
                </button>
              </>
            )}
            </>)}
          </div>
        </>
      )}

      {zoom && (
        <div
          className="hm-image-lightbox"
          onClick={() => setZoom(null)}
          role="dialog"
          aria-modal="true"
        >
          {zoom.type === 'svg'
            ? <div ref={lightboxContentRef} className="hm-lightbox-svg" dangerouslySetInnerHTML={{ __html: zoom.html }} onClick={(e) => e.stopPropagation()} />
            : <img ref={lightboxContentRef} src={zoom.src} alt="" className={isVectorImageSrc(zoom.src) ? 'hm-lightbox-vector' : undefined} onLoad={fitVectorLightboxImage} onClick={(e) => e.stopPropagation()} />
          }
          <div className="hm-lightbox-controls" onClick={(e) => e.stopPropagation()}>
            <button title={t('lightbox.zoomOut')} aria-label={t('lightbox.zoomOut')} onClick={zoomOut}>
              <Icon name="search-minus" size={18} />
            </button>
            <span className="hm-lightbox-scale" aria-live="polite">{Math.round(lightboxScale * 100)}%</span>
            <button title={t('lightbox.zoomIn')} aria-label={t('lightbox.zoomIn')} onClick={zoomIn}>
              <Icon name="search-plus" size={18} />
            </button>
            <span className="hm-lightbox-control-divider" />
            <button title={t('lightbox.fit')} aria-label={t('lightbox.fit')} onClick={fitToWindow}>
              <Icon name="expand" size={17} />
            </button>
            <button
              className="hm-lightbox-actual"
              title={t('lightbox.actual')}
              aria-label={t('lightbox.actual')}
              onClick={showActualSize}
            >
              1:1
            </button>
          </div>
          <button
            className="hm-lightbox-close"
            title={t('lightbox.close')}
            aria-label={t('lightbox.close')}
            onClick={() => setZoom(null)}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      )}
    </>
  )
}
