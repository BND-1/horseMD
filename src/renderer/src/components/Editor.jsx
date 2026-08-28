import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  editorViewCtx,
  parserCtx,
  remarkCtx,
  serializerCtx
} from '@milkdown/kit/core'
import './editor-codeblock-eager.js' // side effect: root-fix #25 — eager, non-tearing code-block node view
import './editor-table-click.js' // side effect: single click in a table cell places the caret
import { TextSelection } from '@milkdown/prose/state'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import '@milkdown/crepe/theme/common/link-tooltip.css'
// Latex feature styles + the KaTeX stylesheet it @imports (needed for $$…$$
// block-math preview + inline $…$ to render with correct fonts/layout).
import '@milkdown/crepe/theme/common/latex.css'
import { BLOCK_TYPES } from '../blocks.js'
import { useI18n } from '../i18n.jsx'
import { copyToClipboard, fireToast } from '../ui.js'
import { Icon } from './icons.jsx'
import { createImagePersister } from './editor-image-persistence.js'
import { normalizeDisplayMath } from './editor-math.js'
import { splitMarkdown, CHUNK_THRESHOLD, CHUNK_SIZE, appendChunks } from './editor-chunked-parse.js'
import { createBlockControls } from './editor-block-controls.js'
import { convertSourceParagraphLineToList } from './editor-block-list-source.js'
import {
  applySlashBlockSourceIntent,
  captureSlashBlockSourceIntent
} from './editor-slash-source.js'
import { convertListAtSelection, getListConversionContext } from './editor-list-conversion.js'
import { normalizeReviewMarkupMarkdown } from '../reviewMarkup.js'
import { REVIEW_KINDS } from './editor-review.js'
import { createEditorApi } from './editor-api.js'
import { useEditorLightboxControls } from './editor-lightbox.js'
import { applyImageText, createConfiguredCrepe } from './editor-crepe-setup.js'
import { mountEditorDomBindings } from './editor-dom-bindings.js'
import { mountEditorInputTrace, traceEditorEvent } from './editor-input-trace.js'
import { getCommandShortcut } from '../lib/commands/shortcut-labels.js'
import {
  generatedScratchMarkdown,
  preserveRichMarkdownSource,
  preserveGeneratedBulletMarkers,
  preserveOwnedTypedBulletInputRule,
  preserveTransactionOwnedListSubtreeChange,
  replaceMarkdownFrontmatterBlock,
  replaceMarkdownListBlock,
  restoreTypedBulletMarker
} from '../markdown-source-preservation.js'
import { pmPosToMarkdownOffset } from './editor-source-map.js'
import {
  areSourceDocumentsEquivalent,
  formatWholeDocumentReplacementSource,
  isWholeDocumentReplacementBatch,
  mapPlainTextTransactionsToSource
} from '../lib/source-transaction-sync.js'
import { areMarkdownListSlotsEquivalent } from '../lib/source-structure-fingerprint.js'
import {
  createBlockquoteJoinTransactionSourceSyncOwner,
  createBlockquoteParagraphTransactionSourceSyncOwner,
  createBlockquoteSplitTransactionSourceSyncOwner,
  createCodeBlockInfoTransactionSourceSyncOwner,
  createCodeBlockTransactionSourceSyncOwner,
  createDocumentReplacementSourceSyncOwner,
  createEditorSourceSyncBridge,
  createLegacySourceIntegrityValidator,
  createListConversionSnapshotSourceSyncOwner,
  createListSubtreeTransactionSourceSyncOwner,
  createPlainParagraphTransactionSourceSyncOwner,
  createSourceSyncTransactionJournal,
  createSlashBlockSourceSyncOwner,
  createSourceSyncCheckpointStore,
  findSlashCodeBlockAtSelection
} from '../lib/source-sync/index.js'

// Every mounted rich editor registers itself here. A rich-text tab stays mounted
// after its first activation, so several editors (and several Crepe selection
// toolbars) can coexist. The heading button injected into a toolbar resolves its
// target editor at click time — the one that currently owns the selection —
// instead of capturing a single instance, which previously made the button act
// on the wrong (hidden) tab when more than one tab was open.
const liveEditors = new Set()

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
export default function Editor({
  initialContent,
  docPath,
  imageUploadCommand,
  spellcheck,
  inlineMathDeleteMode,
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
  const apiRef = useRef(null)
  const crepeRef = useRef(null)
  const lastBlockRef = useRef(null)
  // Re-apply the spellcheck attribute when the pref changes after mount (the
  // initial value is set during create above).
  useEffect(() => {
    const v = viewRef.current
    if (v?.dom) v.dom.setAttribute('spellcheck', spellcheck ? 'true' : 'false')
  }, [spellcheck])
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
  // A newly-created (or initially empty) document has no authored Markdown
  // layout to preserve yet. During its first rich-text writing session, using
  // the current ProseMirror serialization as the structural source of truth
  // avoids replaying intermediate empty-list transactions into later lists.
  // Existing documents always retain the local-delta preservation path below.
  const generatedScratchRef = useRef(!(initialContent || '').trim())
  // RS-52: after generated scratch removes one empty list item, keep the exact
  // committed source/canonical pair that owns the editor-only trailing empty
  // paragraph. A later fill may reuse the local mapper only while both
  // snapshots still match this checkpoint; any intervening rich transaction
  // makes the token stale automatically.
  const generatedPostListEmptyTransientRef = useRef(null)
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
    // `markdownUpdated` normally catches up immediately, but a mode switch can
    // happen in the narrow gap after a visible ProseMirror transaction. Keep a
    // precise flag for that gap: it preserves the required immediate flush
    // without serializing a 400K+ document again for a reading-only toggle.
    let richFlushPending = false
    let pendingRichBlockKey = null
    let richDirtyReconcileTimer = 0
    let transactionSourcePendingPublish = false
    let transactionSourcePendingDoc = null
    let transactionSourceBlockHints = []
    let transactionSourceQuarantined = false
    // One revision-bound transaction journal spans the listener's deferred
    // callback window. It owns PM transaction/StepMap evidence for every normal
    // edit family; focused owners may consume it, but none may keep a private
    // lifecycle token or silently rebase it after another publication.
    let pendingSourceSyncTransactionJournal = null
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
    const markUserEdit = (ttl = 8000) => {
      const blockKey = currentRichBlockKey()
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
        !isActiveListInputIntent(pendingMarkdownInputIntent)
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
    const scheduleRichDirtyReconcile = (delayMs = 260) => {
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
        if (isActiveListInputIntent(pendingMarkdownInputIntent)) {
          scheduleRichDirtyReconcile(120)
          return
        }
        const markdown = apiRef.current?.flushMarkdown?.()
        if (typeof markdown === 'string') onChange?.(markdown, false)
      }, delayMs)
    }
    const hasRecentUserEdit = () => Date.now() <= userEditUntil
    const clearRichFlushPending = () => {
      richFlushPending = false
      pendingRichBlockKey = null
    }
    const pendingRawMarkdownPasteRef = { current: null }
    let pendingListConversion = null
    let pendingMarkdownInputIntent = null
    const isActiveListInputIntent = (intent) => {
      if (!intent || (intent.type !== 'bullet-list' && intent.type !== 'ordered-list')) return false
      const expiresAt = Number.isFinite(intent.batchUntil)
        ? intent.batchUntil
        : Number(intent.at || 0) + 3000
      return Date.now() < expiresAt
    }
    // A physical/IME input sequence can create an outer list and a nested list
    // before Milkdown emits its first markdownUpdated callback. Keep every
    // marker intent until that callback serializes the generated document;
    // retaining only the latest intent loses the outer marker (`1.` -> `1)`).
    let pendingMarkdownInputIntents = []
    let pendingSlashBlockIntent = null
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
      try {
        const pos = getPos?.()
        if (!Number.isFinite(pos)) return
        // Node-view attribute transactions can be plugin-owned and may not
        // publish Milkdown's cached Markdown immediately. Serialize the exact
        // live PM document so candidate canonical and expectedDoc share one
        // revision at the Coordinator boundary.
        const canonical = canonicalForSource(
          crepe.editor.ctx.get(serializerCtx)(view.state.doc)
        )
        // If markdownUpdated already committed the same live document, this
        // callback is only an acknowledgement and must not publish twice.
        if (canonical === canonicalMarkdownRef.current) return
        const remark = crepe.editor.ctx.get(remarkCtx)
        const sourceOffset = pmPosToMarkdownOffset(lastMarkdownRef.current, pos, view.state.doc, remark)
        const nextOffset = pmPosToMarkdownOffset(canonical, pos, view.state.doc, remark)
        const markdown = Number.isFinite(sourceOffset) && Number.isFinite(nextOffset)
          ? replaceMarkdownFrontmatterBlock({
              source: lastMarkdownRef.current,
              next: canonical,
              sourceOffset,
              nextOffset
            })
          : null
        const result = markdown
          ? {
              markdown,
              preserved: true,
              reason: 'frontmatter-block-change'
            }
          : preserveRichMarkdownSource(
              lastMarkdownRef.current,
              canonicalMarkdownRef.current,
              canonical
            )
        if (result.preserved === false) {
          userEditUntil = Date.now() + 1000
          return
        }
        const coordinated = sourceSyncBridge.publish({
          result,
          canonical,
          expectedDoc: view.state.doc,
          validationSite: 'frontmatter-value-change',
          boundary: 'frontmatter-value-change',
          notifyChange: true
        })
        if (!coordinated?.ok) {
          userEditUntil = Date.now() + 1000
          return
        }
        pendingSourceSyncTransactionJournal = null
        clearRichFlushPending()
      } catch {
        // The live editor remains correct; the normal markdownUpdated callback
        // still owns fallback serialization if a mapper/plugin is unavailable.
      }
    }

    const handleInlineCodeValueChange = () => {
      try {
        // Inline-code transactions are plugin-owned and can run before
        // Crepe's cached getMarkdown() snapshot catches up. Serialize the live
        // ProseMirror document, matching save/source-switch durability rules.
        const view = viewRef.current
        const markdown = view
          ? crepe.editor.ctx.get(serializerCtx)(view.state.doc)
          : crepe.getMarkdown()
        const canonical = canonicalForSource(markdown)
        if (canonical === canonicalMarkdownRef.current) return
        const preserved = preserveRichMarkdownSource(
          lastMarkdownRef.current,
          canonicalMarkdownRef.current,
          canonical
        )
        // Never confirm a canonical baseline for an edit whose authored source
        // ownership was not proven. Advancing here used to hide the failed
        // inline-code transaction until a later save/source switch became
        // permanently fail-closed.
        if (preserved.preserved === false) {
          userEditUntil = Date.now() + 1000
          return
        }
        const coordinated = sourceSyncBridge.publish({
          result: preserved,
          canonical,
          expectedDoc: view?.state.doc,
          validationSite: 'inline-code-value-change',
          boundary: 'inline-code-value-change',
          notifyChange: true
        })
        if (!coordinated?.ok) {
          userEditUntil = Date.now() + 1000
          return
        }
        pendingSourceSyncTransactionJournal = null
        clearRichFlushPending()
      } catch {
        // The editor remains usable if serialization is transiently unavailable;
        // normal markdownUpdated remains the fallback for ordinary input.
      }
    }

    const documentReplacementSourceSyncOwner = createDocumentReplacementSourceSyncOwner({
      formatWholeDocumentSource: formatWholeDocumentReplacementSource
    })
    const listConversionSnapshotSourceSyncOwner = createListConversionSnapshotSourceSyncOwner()
    const slashBlockSourceSyncOwner = createSlashBlockSourceSyncOwner({
      preserve: preserveRichMarkdownSource,
      captureIntent: captureSlashBlockSourceIntent,
      applyIntent: applySlashBlockSourceIntent
    })

    let crepe
    const sourceSyncTransactionJournal = createSourceSyncTransactionJournal()
    const resolveTransactionMarkdownOffset = ({ markdown, pmPos, doc }) => {
      const remark = crepe.editor.ctx.get(remarkCtx)
      return pmPosToMarkdownOffset(markdown, pmPos, doc, remark)
    }
    const validateTransactionMarkdown = ({ markdown, expectedDoc }) => {
      const parser = crepe.editor.ctx.get(parserCtx)
      const serializer = crepe.editor.ctx.get(serializerCtx)
      const parsed = parser(markdown)
      const expectedCanonical = canonicalForSource(serializer(expectedDoc))
      return areSourceDocumentsEquivalent(parsed, expectedDoc) &&
        areMarkdownListSlotsEquivalent(markdown, expectedCanonical, {
          strictOrderedNumbers: true,
          previousMarkdown: canonicalMarkdownRef.current
        })
    }
    const listSubtreeTransactionSourceSyncOwner = createListSubtreeTransactionSourceSyncOwner({
      mapListSubtree: preserveTransactionOwnedListSubtreeChange,
      resolveMarkdownOffset: resolveTransactionMarkdownOffset
    })
    const codeBlockTransactionSourceSyncOwner = createCodeBlockTransactionSourceSyncOwner({
      resolveMarkdownOffset: resolveTransactionMarkdownOffset
    })
    const codeBlockInfoTransactionSourceSyncOwner = createCodeBlockInfoTransactionSourceSyncOwner({
      resolveMarkdownOffset: resolveTransactionMarkdownOffset
    })
    const blockquoteParagraphTransactionSourceSyncOwner =
      createBlockquoteParagraphTransactionSourceSyncOwner({
        resolveMarkdownOffset: resolveTransactionMarkdownOffset,
        validateMarkdown: validateTransactionMarkdown
      })
    const blockquoteSplitTransactionSourceSyncOwner =
      createBlockquoteSplitTransactionSourceSyncOwner({
        resolveMarkdownOffset: resolveTransactionMarkdownOffset,
        validateMarkdown: validateTransactionMarkdown
      })
    const blockquoteJoinTransactionSourceSyncOwner =
      createBlockquoteJoinTransactionSourceSyncOwner({
        resolveMarkdownOffset: resolveTransactionMarkdownOffset,
        validateMarkdown: validateTransactionMarkdown
      })
    // Structural families share one revision-bound journal and one publication
    // loop. Adding quote/table ownership means registering another focused owner
    // here, not adding a new markdownUpdated/forced-flush canonical branch.
    const structuralTransactionSourceSyncOwners = Object.freeze([
      Object.freeze({
        key: 'list-subtree',
        owner: listSubtreeTransactionSourceSyncOwner,
        traceKey: '__hmListSubtreeTransactionTrace',
        boundaries: Object.freeze({
          'markdown-updated': 'transaction-list-subtree-markdown-updated',
          'forced-flush': 'transaction-list-subtree-forced-flush'
        })
      }),
      Object.freeze({
        key: 'code-block',
        owner: codeBlockTransactionSourceSyncOwner,
        traceKey: '__hmCodeBlockTransactionTrace',
        boundaries: Object.freeze({
          'markdown-updated': 'transaction-code-block-markdown-updated',
          'forced-flush': 'transaction-code-block-forced-flush'
        })
      }),
      Object.freeze({
        key: 'code-block-info',
        owner: codeBlockInfoTransactionSourceSyncOwner,
        traceKey: '__hmCodeBlockTransactionTrace',
        boundaries: Object.freeze({
          'markdown-updated': 'transaction-code-block-info-markdown-updated',
          'forced-flush': 'transaction-code-block-info-forced-flush'
        })
      }),
      Object.freeze({
        key: 'blockquote-paragraph',
        owner: blockquoteParagraphTransactionSourceSyncOwner,
        traceKey: '__hmBlockquoteTransactionTrace',
        boundaries: Object.freeze({
          'markdown-updated': 'transaction-blockquote-paragraph-markdown-updated',
          'forced-flush': 'transaction-blockquote-paragraph-forced-flush'
        })
      }),
      Object.freeze({
        key: 'blockquote-split',
        owner: blockquoteSplitTransactionSourceSyncOwner,
        traceKey: '__hmBlockquoteTransactionTrace',
        boundaries: Object.freeze({
          'markdown-updated': 'transaction-blockquote-split-markdown-updated',
          'forced-flush': 'transaction-blockquote-split-forced-flush'
        })
      }),
      Object.freeze({
        key: 'blockquote-join',
        owner: blockquoteJoinTransactionSourceSyncOwner,
        traceKey: '__hmBlockquoteTransactionTrace',
        boundaries: Object.freeze({
          'markdown-updated': 'transaction-blockquote-join-markdown-updated',
          'forced-flush': 'transaction-blockquote-join-forced-flush'
        })
      })
    ])
    const plainParagraphTransactionSourceSyncOwner =
      createPlainParagraphTransactionSourceSyncOwner({
        resolveMarkdownOffset: resolveTransactionMarkdownOffset,
        validateMarkdown: validateTransactionMarkdown
      })
    const transactionFirstMode = () => {
      if (globalThis.__hmTransactionFirstAuthority === true) return 'authoritative'
      if (
        globalThis.__hmTransactionSourceShadow === true ||
        import.meta.env?.VITE_HM_TRANSACTION_SHADOW === '1'
      ) return 'shadow'
      return 'disabled'
    }
    const handleSlashCommand = ({ phase, id, view, token }) => {
      if (phase === 'before') {
        if (!slashBlockSourceSyncOwner.handles(id)) return null
        try {
          const serializer = crepe.editor.ctx.get(serializerCtx)
          const remark = crepe.editor.ctx.get(remarkCtx)
          const canonical = canonicalForSource(serializer(view.state.doc))
          const captured = slashBlockSourceSyncOwner.capture({
            id,
            source: lastMarkdownRef.current,
            previousCanonical: canonicalMarkdownRef.current,
            canonical,
            queryText: view.state.selection.$from.parent.textContent,
            resolveSourceOffset: ({ source }) => pmPosToMarkdownOffset(
              source,
              view.state.selection.head,
              view.state.doc,
              remark
            )
          })
          if (!captured.ok) {
            pendingSlashBlockIntent = null
            return null
          }
          pendingSlashBlockIntent = captured.token
          markUserEdit()
          return pendingSlashBlockIntent
        } catch {
          pendingSlashBlockIntent = null
          return null
        }
      }
      if (phase !== 'after' || !token || pendingSlashBlockIntent !== token) return null
      try {
        const serializer = crepe.editor.ctx.get(serializerCtx)
        const canonical = canonicalForSource(serializer(view.state.doc))
        const codeBlock = findSlashCodeBlockAtSelection(view.state.selection)
        if (!codeBlock) return null
        const singleBlockDoc = view.state.schema.topNodeType.create(null, [codeBlock])
        const blockMarkdown = canonicalForSource(serializer(singleBlockDoc))
        const planned = slashBlockSourceSyncOwner.plan({
          id,
          token,
          activeToken: pendingSlashBlockIntent,
          blockMarkdown,
          canonical,
          expectedDoc: view.state.doc
        })
        if (!planned.ok) return null
        const coordinated = sourceSyncBridge.publish(planned.publication)
        if (!coordinated?.ok) {
          userEditUntil = Date.now() + 1000
          return null
        }
        transactionSourcePendingPublish = false
        transactionSourcePendingDoc = null
        transactionSourceBlockHints = []
        transactionSourceQuarantined = false
        pendingSourceSyncTransactionJournal = null
        clearRichFlushPending()
        if (Array.isArray(globalThis.__hmPreserveLog)) {
          globalThis.__hmPreserveLog.push({
            source: token.source,
            previous: token.previousCanonical,
            next: canonical,
            markdown: coordinated.publication.markdown,
            preserved: true,
            reason: planned.result.reason
          })
        }
        return coordinated.publication.markdown
      } catch {
        return null
      } finally {
        if (pendingSlashBlockIntent === token) pendingSlashBlockIntent = null
      }
    }

    const handleSourceTransactions = (transactions, oldState, newState) => {
      traceEditorEvent('prosemirror-transactions', {
        transactions: (transactions || []).map((transaction) => ({
          docChanged: transaction?.docChanged || false,
          selection: {
            anchor: transaction?.selection?.anchor ?? null,
            head: transaction?.selection?.head ?? null,
            from: transaction?.selection?.from ?? null,
            to: transaction?.selection?.to ?? null
          },
          steps: (transaction?.steps || []).map((step) => step?.toJSON?.() || {
            type: step?.constructor?.name || 'unknown'
          })
        })),
        oldDoc: oldState?.doc?.toJSON?.() || null,
        newDoc: newState?.doc?.toJSON?.() || null
      })
      // Keep a captured list-input anchor attached to its ProseMirror block
      // even when markdownUpdated is deferred and the user has already moved
      // on to another block. Looking only at the *current* selection loses the
      // authored `-` / `+` / `1.` intent and lets the serializer's default
      // marker enter source. Every transaction mapping is ordered from the
      // previous document to the next, so map the anchor through the complete
      // batch before any source-sync path returns.
      const intents = new Set([
        ...pendingMarkdownInputIntents,
        ...(pendingMarkdownInputIntent ? [pendingMarkdownInputIntent] : [])
      ])
      for (const transaction of transactions || []) {
        if (!transaction?.mapping?.map) continue
        for (const intent of intents) {
          if (!Number.isFinite(intent?.pmPos)) continue
          intent.pmPos = transaction.mapping.map(intent.pmPos, 1)
        }
      }
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
        pendingSourceSyncTransactionJournal = null
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
            const coordinated = sourceSyncBridge.publishOwned({ ownership })
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
              transactionSourcePendingPublish = false
              transactionSourcePendingDoc = null
              transactionSourceBlockHints = []
              transactionSourceQuarantined = false
              pendingSourceSyncTransactionJournal = null
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

      // Always-on, low-cost transaction journal. Dispatch stores immutable PM
      // documents, steps and StepMaps against the exact Coordinator revision;
      // Markdown range resolution waits for callback/forced flush. Structural
      // follow-ups extend the same journal instead of publishing an intermediate
      // empty-item representation or forcing each owner to invent a token.
      const transactionJournalTrackingBlocked =
        !ready ||
        appending ||
        programmaticReplaceRef.current ||
        generatedScratchRef.current ||
        viewRef.current?.composing ||
        pendingRawMarkdownPasteRef.current ||
        pendingListConversion ||
        pendingMarkdownInputIntent ||
        wholeDocumentReplacementPending ||
        transactionSourceQuarantined ||
        !hasRecentUserEdit()
      if (transactionJournalTrackingBlocked) {
        pendingSourceSyncTransactionJournal = null
      } else {
        try {
          const snapshot = sourceSyncBridge.getSnapshot()
          const liveSnapshotMatched =
            snapshot.source === String(lastMarkdownRef.current ?? '') &&
            snapshot.canonical === String(canonicalMarkdownRef.current ?? '')
          const captured = liveSnapshotMatched
            ? sourceSyncTransactionJournal.captureOrAdvance({
                checkpoint: pendingSourceSyncTransactionJournal,
                snapshot,
                transactions,
                oldDoc: oldState.doc,
                newDoc: newState.doc
              })
            : {
                ok: false,
                reset: true,
                reason: 'transaction-journal-live-snapshot-stale'
              }
          if (captured.ok) {
            pendingSourceSyncTransactionJournal = captured.checkpoint
          } else if (captured.reset) {
            pendingSourceSyncTransactionJournal = null
          }
          if (Array.isArray(globalThis.__hmSourceSyncTransactionJournalTrace)) {
            globalThis.__hmSourceSyncTransactionJournalTrace.push({
              phase: 'capture',
              ok: captured.ok === true,
              reason: captured.reason || null,
              journalId: captured.checkpoint?.journalId || null,
              baseRevision: captured.checkpoint?.baseRevision ?? null,
              batchCount: captured.checkpoint?.batchCount || null,
              transactionCount: captured.checkpoint?.transactionCount || null,
              stepCount: captured.checkpoint?.stepCount || null
            })
            if (globalThis.__hmSourceSyncTransactionJournalTrace.length > 100) {
              globalThis.__hmSourceSyncTransactionJournalTrace.shift()
            }
          }
        } catch {
          pendingSourceSyncTransactionJournal = null
        }
      }

      // The shared journal above is the only production lifecycle for shadow
      // and allowlisted transaction authority. Keep the historical broad
      // transaction-primary mapper behind its explicit test/dev gate until its
      // remaining families migrate to focused journal consumers.
      const transactionPrimaryEnabled =
        globalThis.__hmTransactionSourcePrimary === true ||
        import.meta.env?.VITE_HM_TRANSACTION_PRIMARY === '1'
      if (!transactionPrimaryEnabled) return
      if (
        !ready ||
        appending ||
        programmaticReplaceRef.current ||
        generatedScratchRef.current ||
        viewRef.current?.composing ||
        pendingRawMarkdownPasteRef.current ||
        pendingListConversion ||
        pendingMarkdownInputIntent ||
        transactionSourceQuarantined ||
        !hasRecentUserEdit()
      ) {
        transactionSourcePendingPublish = false
        transactionSourcePendingDoc = null
        transactionSourceBlockHints = []
        return
      }
      try {
        const remark = crepe.editor.ctx.get(remarkCtx)
        const parser = crepe.editor.ctx.get(parserCtx)
        const mapped = mapPlainTextTransactionsToSource({
          source: lastMarkdownRef.current,
          transactions,
          oldState,
          newState,
          blockHints: transactionSourceBlockHints,
          mapPosition: (source, position, doc) =>
            pmPosToMarkdownOffset(source, position, doc, remark),
          validateMarkdown: (markdown, expectedDoc) => {
            const parsed = parser(markdown)
            const equal = areSourceDocumentsEquivalent(parsed, expectedDoc)
            const serializer = crepe.editor.ctx.get(serializerCtx)
            const expectedCanonical = canonicalForSource(serializer(expectedDoc))
            const listSlotsMatch = areMarkdownListSlotsEquivalent(markdown, expectedCanonical, {
              strictOrderedNumbers: true,
              previousMarkdown: canonicalMarkdownRef.current
            })
            if ((!equal || !listSlotsMatch) && Array.isArray(globalThis.__hmSourceTransactionTrace)) {
              globalThis.__hmSourceTransactionSemantic = {
                parsed: parsed?.toJSON?.() || null,
                expected: expectedDoc?.toJSON?.() || null
              }
            }
            return equal && listSlotsMatch
          }
        })
        if (!mapped.ok) {
          if (!transactionPrimaryEnabled) return
          transactionSourcePendingPublish = false
          transactionSourcePendingDoc = null
          const retainOwnedSyntaxSlot =
            transactionSourceBlockHints.length > 0 &&
            (mapped.reason === 'block-prefix-sensitive-insert' ||
              mapped.reason === 'syntax-sensitive-insert')
          if (!retainOwnedSyntaxSlot) transactionSourceBlockHints = []
          transactionSourceQuarantined = true
          return
        }
        // Run as a non-authoritative shadow in production until this edit
        // category passes the complete family matrix. Targeted integration
        // tests opt into primary mode and prove that eligible transactions can
        // bypass canonical diff without silently widening production scope.
        if (!transactionPrimaryEnabled) return

        // The source bytes come only from the transaction mapper. Serialization
        // is retained temporarily as a baseline fingerprint so delayed
        // markdownUpdated callbacks and unsupported follow-up transactions can
        // continue from the exact matching PM document without replaying the
        // already-consumed text edit.
        const serializer = crepe.editor.ctx.get(serializerCtx)
        const canonical = canonicalForSource(serializer(newState.doc))
        lastMarkdownRef.current = mapped.markdown
        canonicalMarkdownRef.current = canonical
        transactionSourceBlockHints = mapped.blockHints || []
        transactionSourceQuarantined = false
        transactionSourcePendingPublish = true
        transactionSourcePendingDoc = newState.doc
      } catch (error) {
        // No partial state is committed by the mapper. Preserve a structural
        // diagnostic without retaining document content, then quarantine the
        // primary path until markdownUpdated establishes a safe checkpoint.
        if (Array.isArray(globalThis.__hmSourceTransactionLog)) {
          globalThis.__hmSourceTransactionLog.push({
            ok: false,
            reason: 'transaction-controller-threw',
            error: error?.name || 'Error'
          })
        }
        transactionSourcePendingPublish = false
        transactionSourcePendingDoc = null
        transactionSourceBlockHints = []
        if (transactionPrimaryEnabled) transactionSourceQuarantined = true
      }
    }

    crepe = createConfiguredCrepe({
      host,
      defaultValue: normalizeReviewMarkupMarkdown(normalizeDisplayMath(firstContent)),
      getT: (key) => tRef.current(key),
      persistImage,
      notify: fireToast,
      copyText: copyToClipboard,
      getInlineMathDeleteMode: () => inlineMathDeleteModeRef.current,
      markUserEdit,
      isReadOnly: () => readOnlyRef.current,
      onFrontmatterValueChange: handleFrontmatterValueChange,
      onInlineCodeValueChange: handleInlineCodeValueChange,
      onSlashCommand: handleSlashCommand,
      onSourceTransactions: handleSourceTransactions
    })
    crepeRef.current = crepe

    // Keep a small exact set of source/canonical pairs that have already been
    // proven or were created directly by opening the author's file. The store
    // now lives behind the SourceSyncCoordinator contract, while all legacy
    // validation rules and trace fields remain byte-for-byte compatible.
    const sourceIntegrityCheckpoints = createSourceSyncCheckpointStore({ limit: 4 })
    const validateSourceCandidate = createLegacySourceIntegrityValidator({
      getParser: () => crepe.editor.ctx.get(parserCtx),
      getSerializer: () => crepe.editor.ctx.get(serializerCtx),
      getExpectedDoc: () => viewRef.current?.state.doc,
      getAuthoredSource: () => lastMarkdownRef.current,
      getCanonicalBaseline: () => canonicalMarkdownRef.current,
      canonicalForSource,
      checkpointStore: sourceIntegrityCheckpoints,
      getTrace: () => globalThis.__hmSourceIntegrityTrace
    })
    const sourceSyncBridge = createEditorSourceSyncBridge({
      checkpointStore: sourceIntegrityCheckpoints,
      getSource: () => lastMarkdownRef.current,
      getCanonical: () => canonicalMarkdownRef.current,
      getExpectedDoc: () => viewRef.current?.state.doc,
      setSource: (markdown) => { lastMarkdownRef.current = markdown },
      setCanonical: (canonical) => { canonicalMarkdownRef.current = canonical },
      onChange: (markdown) => onChange?.(markdown, false),
      validateLegacyCandidate: validateSourceCandidate,
      trace: (entry) => {
        if (!Array.isArray(globalThis.__hmSourceSyncCoordinatorTrace)) return
        globalThis.__hmSourceSyncCoordinatorTrace.push(entry)
        if (globalThis.__hmSourceSyncCoordinatorTrace.length > 100) {
          globalThis.__hmSourceSyncCoordinatorTrace.shift()
        }
      }
    })
    const publishSourceSyncResult = (input) => {
      const coordinated = sourceSyncBridge.publish(input)
      if (coordinated?.ok) pendingSourceSyncTransactionJournal = null
      return coordinated
    }
    let lastSourceSyncWarning = null
    const reportSourceSyncFailure = (reason) => {
      const now = Date.now()
      const signature = String(reason || 'source-document-mismatch')
      if (lastSourceSyncWarning?.signature === signature && now - lastSourceSyncWarning.at < 1500) return
      lastSourceSyncWarning = { signature, at: now }
      traceEditorEvent('source-sync-integrity-failure', { reason: signature })
      fireToast(tRef.current('save.sourceSyncMismatch'), { sticky: true })
    }

    const pushStructuralTransactionTrace = (entry, value) => {
      const trace = globalThis[entry.traceKey]
      if (!Array.isArray(trace)) return
      trace.push(value)
      if (trace.length > 100) trace.shift()
    }

    const publishPendingStructuralTransaction = ({
      canonical,
      expectedDoc,
      site = 'markdown-updated',
      notifyChange
    } = {}) => {
      const journal = pendingSourceSyncTransactionJournal
      if (!journal) return { attempted: false, ok: false }
      const snapshot = sourceSyncBridge.getSnapshot()
      let callbackDocumentEquivalent = false
      try {
        const parser = crepe.editor.ctx.get(parserCtx)
        callbackDocumentEquivalent = Boolean(
          expectedDoc && areSourceDocumentsEquivalent(parser(canonical), expectedDoc)
        )
      } catch {
        callbackDocumentEquivalent = false
      }

      let lastRejection = null
      for (const entry of structuralTransactionSourceSyncOwners) {
        const boundary = entry.boundaries[site] || `transaction-${entry.key}-${site}`
        const ownership = entry.owner.plan({
          journal,
          activeJournal: pendingSourceSyncTransactionJournal,
          snapshot,
          currentSource: lastMarkdownRef.current,
          currentCanonical: canonicalMarkdownRef.current,
          canonical,
          expectedDoc,
          callbackDocumentEquivalent,
          boundary
        })
        if (!ownership.ok) {
          pushStructuralTransactionTrace(entry, {
            phase: 'plan',
            ok: false,
            family: entry.owner.family,
            reason: ownership.reason || null,
            proof: ownership.proof || null,
            journalId: journal.journalId,
            baseRevision: journal.baseRevision,
            chainLength: journal.transactionCount
          })
          lastRejection = {
            attempted: true,
            ok: false,
            deferred: ownership.deferred === true,
            reason: ownership.reason || null,
            family: entry.owner.family
          }
          // A stale revision/source/doc invalidates the shared journal for every
          // family. Ordinary family rejection must leave it available for the
          // next registered owner and the legacy fallback.
          if (ownership.reset) {
            pendingSourceSyncTransactionJournal = null
            return { ...lastRejection, reset: true }
          }
          continue
        }

        const coordinated = sourceSyncBridge.publishOwned({
          ownership,
          notifyChange,
          boundary
        })
        if (!coordinated?.ok) {
          pushStructuralTransactionTrace(entry, {
            phase: 'publish',
            ok: false,
            family: ownership.family,
            reason: coordinated?.reason || 'source-document-mismatch',
            journalId: journal.journalId,
            baseRevision: journal.baseRevision,
            chainLength: journal.transactionCount
          })
          return {
            attempted: true,
            ok: false,
            reason: coordinated?.reason || 'source-document-mismatch',
            family: ownership.family
          }
        }

        pendingSourceSyncTransactionJournal = null
        if (Array.isArray(globalThis.__hmPreserveLog)) {
          globalThis.__hmPreserveLog.push({
            source: journal.source,
            previous: journal.canonical,
            next: canonical,
            markdown: ownership.result.markdown,
            preserved: true,
            reason: ownership.result.reason,
            integrityProof: ownership.proof
          })
          if (globalThis.__hmPreserveLog.length > 200) globalThis.__hmPreserveLog.shift()
        }
        pushStructuralTransactionTrace(entry, {
          phase: 'published',
          ok: true,
          family: ownership.family,
          reason: ownership.result.reason,
          journalId: journal.journalId,
          baseRevision: journal.baseRevision,
          chainLength: journal.transactionCount,
          revision: coordinated.snapshot?.revision ?? null,
          boundary
        })
        return {
          attempted: true,
          ok: true,
          markdown: ownership.result.markdown,
          reason: ownership.result.reason,
          family: ownership.family,
          coordinated
        }
      }
      return lastRejection || { attempted: true, ok: false, reason: 'transaction-family-unowned' }
    }
    const planPendingPlainParagraphTransaction = ({
      canonical,
      expectedDoc,
      boundary
    } = {}) => {
      const journal = pendingSourceSyncTransactionJournal
      if (!journal) return { attempted: false, ok: false, journal: null, ownership: null }
      const snapshot = sourceSyncBridge.getSnapshot()
      let callbackDocumentEquivalent = false
      try {
        const parser = crepe.editor.ctx.get(parserCtx)
        callbackDocumentEquivalent = Boolean(
          expectedDoc && areSourceDocumentsEquivalent(parser(canonical), expectedDoc)
        )
      } catch {
        callbackDocumentEquivalent = false
      }
      const ownership = plainParagraphTransactionSourceSyncOwner.plan({
        journal,
        activeJournal: pendingSourceSyncTransactionJournal,
        snapshot,
        currentSource: lastMarkdownRef.current,
        currentCanonical: canonicalMarkdownRef.current,
        canonical,
        expectedDoc,
        callbackDocumentEquivalent,
        boundary
      })
      if (ownership.reset) pendingSourceSyncTransactionJournal = null
      return {
        attempted: true,
        ok: ownership.ok === true,
        journal,
        snapshot,
        ownership,
        callbackDocumentEquivalent
      }
    }

    const tracePlainParagraphTransaction = ({
      planned,
      mode,
      legacyResult = null,
      publicationOwner = 'legacy',
      authorityDecision = null,
      authorityEligible = false
    } = {}) => {
      if (!planned?.attempted || !Array.isArray(globalThis.__hmTransactionFirstTrace)) return null
      const ownership = planned.ownership
      const journal = planned.journal
      const legacyMarkdown = typeof legacyResult === 'string'
        ? legacyResult
        : legacyResult?.markdown
      const comparison = !ownership?.ok
        ? 'transaction-rejected'
        : typeof legacyMarkdown === 'string'
          ? ownership.result.markdown === legacyMarkdown ? 'byte-equal' : 'byte-diverged'
          : 'legacy-unavailable'
      const transactionReason = ownership?.ok
        ? ownership.result.reason
        : ownership?.reason || 'missing-transaction-result'
      const result = {
        phase: 'reconcile',
        mode,
        ownership: ownership?.ok ? 'owned' : 'rejected',
        transactionReason,
        transactionFamily: ownership?.family || null,
        comparison,
        promotionEligible: comparison === 'byte-equal',
        publicationOwner,
        authorityDecision: authorityDecision || (
          mode === 'authoritative'
            ? ownership?.ok ? 'authority-publication-rejected' : 'authority-transaction-rejected'
            : 'authority-disabled'
        ),
        authorityEligible,
        chainLength: journal?.transactionCount || 0,
        chainReasons: [transactionReason],
        sourceMapEntries: ownership?.proof?.plainParagraphCount || journal?.oldDoc?.childCount || 0,
        stepNames: (journal?.stepDetails || []).map((entry) => entry.name),
        reconcileReason: ownership?.reset ? ownership.reason : 'matched-snapshot',
        journalId: journal?.journalId || null,
        baseRevision: journal?.baseRevision ?? null
      }
      globalThis.__hmTransactionFirstTrace.push(result)
      if (globalThis.__hmTransactionFirstTrace.length > 200) {
        globalThis.__hmTransactionFirstTrace.shift()
      }
      return result
    }

    const publishPlannedPlainParagraphTransaction = ({
      planned,
      notifyChange,
      boundary
    } = {}) => {
      if (!planned?.ok || !planned.ownership?.ok) {
        return { attempted: planned?.attempted === true, ok: false, reason: planned?.ownership?.reason }
      }
      const coordinated = sourceSyncBridge.publishOwned({
        ownership: planned.ownership,
        notifyChange,
        boundary
      })
      if (!coordinated?.ok) {
        return {
          attempted: true,
          ok: false,
          reason: coordinated?.reason || 'source-document-mismatch'
        }
      }
      pendingSourceSyncTransactionJournal = null
      if (Array.isArray(globalThis.__hmPreserveLog)) {
        globalThis.__hmPreserveLog.push({
          source: planned.journal.source,
          previous: planned.journal.canonical,
          next: planned.ownership.canonical,
          markdown: planned.ownership.result.markdown,
          preserved: true,
          reason: planned.ownership.result.reason,
          integrityProof: planned.ownership.proof
        })
        if (globalThis.__hmPreserveLog.length > 200) globalThis.__hmPreserveLog.shift()
      }
      return {
        attempted: true,
        ok: true,
        markdown: planned.ownership.result.markdown,
        reason: planned.ownership.result.reason,
        coordinated
      }
    }

    const publishPendingTransactionJournal = ({
      canonical,
      expectedDoc,
      notifyChange = false
    } = {}) => {
      const structuralResult = publishPendingStructuralTransaction({
        canonical,
        expectedDoc,
        site: 'forced-flush',
        notifyChange
      })
      if (structuralResult.ok || transactionFirstMode() !== 'authoritative') {
        return structuralResult
      }

      const planned = planPendingPlainParagraphTransaction({
        canonical,
        expectedDoc,
        boundary: 'transaction-first-forced-flush-authority'
      })
      if (!planned.ok) {
        tracePlainParagraphTransaction({
          planned,
          mode: 'authoritative',
          publicationOwner: 'legacy',
          authorityDecision: 'authority-transaction-rejected',
          authorityEligible: false
        })
        return {
          attempted: structuralResult.attempted || planned.attempted,
          ok: false,
          reason: planned.ownership?.reason || structuralResult.reason
        }
      }
      const published = publishPlannedPlainParagraphTransaction({
        planned,
        notifyChange,
        boundary: 'transaction-first-forced-flush-authority'
      })
      tracePlainParagraphTransaction({
        planned,
        mode: 'authoritative',
        publicationOwner: published.ok ? 'transaction' : 'legacy',
        authorityDecision: published.ok ? 'authority-owned' : 'authority-publication-rejected',
        authorityEligible: published.ok
      })
      return published
    }

    // Both `markdownUpdated` and an immediate rich -> source flush need the
    // identical generated-document serialization. The latter can run before
    // Milkdown has delivered the input-rule callback, so it must still consume
    // the physical `-` / `*` / `+` intent captured by the DOM binding.
    const generatedScratchMarkdownForCanonical = (canonical, consumeInputIntent = false) => {
      let markdown = generatedScratchMarkdown(canonical)
      const generatedInputIntents = pendingMarkdownInputIntents.length
        ? pendingMarkdownInputIntents
        : pendingMarkdownInputIntent ? [pendingMarkdownInputIntent] : []
      const consumedInputIntents = new Set()
      for (const inputIntent of generatedInputIntents) {
        if (inputIntent?.type !== 'bullet-list' && inputIntent?.type !== 'ordered-list') continue
        try {
          const remark = crepe.editor.ctx.get(remarkCtx)
          const currentView = viewRef.current
          const canonicalOffset = pmPosToMarkdownOffset(
            canonical,
            inputIntent.pmPos ?? currentView?.state.selection.head,
            currentView?.state.doc,
            remark
          )
          const restored = restoreTypedBulletMarker({
            markdown,
            canonical,
            previousCanonical: inputIntent.canonical,
            canonicalOffset,
            marker: inputIntent.marker
          })
          // A real macOS key sequence can publish an intermediate
          // markdownUpdated for the literal `-`/`+` line *before* Milkdown's
          // input rule turns it into a list.  Do not discard the intent in that
          // intermediate callback: only consume it once it actually changed a
          // serialized list marker.  Otherwise the following list transaction
          // falls back to Crepe's `*` permanently.
          if (restored !== markdown) consumedInputIntents.add(inputIntent)
          markdown = restored
        } catch {
          // Canonical Markdown is still structurally correct if a transient
          // selection cannot be mapped while the editor is switching modes.
        }
      }
      markdown = preserveGeneratedBulletMarkers(lastMarkdownRef.current, markdown)
      if (consumedInputIntents.size) {
        pendingMarkdownInputIntents = pendingMarkdownInputIntents
          .filter((intent) => !consumedInputIntents.has(intent))
        if (pendingMarkdownInputIntent && consumedInputIntents.has(pendingMarkdownInputIntent)) {
          if (Array.isArray(globalThis.__hmListIntentTrace)) {
            globalThis.__hmListIntentTrace.push({
              phase: 'consumed-by-generated-marker-restore',
              marker: pendingMarkdownInputIntent.marker,
              sourceSlotRawStart: pendingMarkdownInputIntent.sourceSlotRawStart
            })
          }
          pendingMarkdownInputIntent = pendingMarkdownInputIntents.at(-1) || null
        }
      }
      if (consumeInputIntent) {
        // A source-mode flush must not throw away an intent that has only seen
        // the literal pre-input marker. Keep unresolved intents for the next
        // real list transaction; stale entries are already pruned at capture.
        pendingMarkdownInputIntents = pendingMarkdownInputIntents
          .filter((intent) => Date.now() - intent.at < 30000)
      }
      return markdown
    }

    // Block controls live in editor-block-controls.js; mount them here and
    // reuse the same conversion path across shortcuts, menus and toolbars.
    const { setBlock: setEditableBlock, canConvertCurrentBlockToList, convertCurrentBlockToList, reportActiveBlock } = createBlockControls({
      viewRef,
      setCtxMenu,
      onActiveBlock,
      lastBlockRef
    })
    const setBlock = (id) => {
      if (readOnlyRef.current) return
      setEditableBlock(id)
    }
    const convertBlockToList = (targetType, blockPos) => {
      if (readOnlyRef.current) return false
      const sourceBeforeConversion = lastMarkdownRef.current
      const canonicalBeforeConversion = canonicalMarkdownRef.current
      let sourceOffset = null
      try {
        const view = viewRef.current
        const remark = crepe.editor.ctx.get(remarkCtx)
        const mappingPos = Number.isFinite(blockPos) ? blockPos : view?.state.selection.head
        sourceOffset = pmPosToMarkdownOffset(
          sourceBeforeConversion,
          mappingPos,
          view?.state.doc,
          remark
        )
      } catch {
        // The generic preservation path below remains available if the source
        // mapping is temporarily unavailable during teardown.
      }
      const converted = convertCurrentBlockToList(targetType, blockPos)
      if (converted) {
        markUserEdit()
        // ProseMirror has already committed the structural change, while
        // Crepe's markdownUpdated event may arrive a frame later. Commit this
        // snapshot now so an immediate source-mode switch or save cannot read
        // the paragraph from before it was wrapped as a list.
        try {
          // `crepe.getMarkdown()` is an asynchronously published cache and can
          // still describe the paragraph immediately after ProseMirror has
          // wrapped it as a list. Structural commands need the transaction
          // document itself, otherwise a later conversion overwrites the
          // previous one in source mode.
          const view = viewRef.current
          const serializer = crepe.editor.ctx.get(serializerCtx)
          const canonical = canonicalForSource(serializer(view.state.doc))
          const preserved = preserveRichMarkdownSource(
            sourceBeforeConversion,
            canonicalBeforeConversion,
            canonical
          )
          // Wrapping a paragraph has no visible-text delta. This transaction
          // changes only the exact pre-transaction paragraph, so its authored
          // source line is more precise than a whole-document structural diff.
          const exactLineFallback = canonical !== canonicalBeforeConversion
            ? convertSourceParagraphLineToList(sourceBeforeConversion, sourceOffset, targetType)
            : null
          const result = exactLineFallback
            ? {
                markdown: exactLineFallback,
                preserved: true,
                reason: 'block-to-list-exact-line'
              }
            : preserved
          const planned = listConversionSnapshotSourceSyncOwner.planBlockToList({
            source: sourceBeforeConversion,
            previousCanonical: canonicalBeforeConversion,
            currentSource: lastMarkdownRef.current,
            currentCanonical: canonicalMarkdownRef.current,
            result,
            canonical,
            expectedDoc: view.state.doc,
            targetType,
            sourceOffset
          })
          if (planned.ok) {
            const coordinated = sourceSyncBridge.publish(planned.publication)
            if (coordinated?.ok) {
              pendingSourceSyncTransactionJournal = null
              clearRichFlushPending()
            } else userEditUntil = Date.now() + 1000
          }
        } catch {
          // markdownUpdated remains the authoritative fallback if a serializer
          // plugin is temporarily unavailable during editor teardown.
        }
      }
      return converted
    }
    const canConvertBlockToList = (blockPos) => !readOnlyRef.current && canConvertCurrentBlockToList(blockPos)
    const convertList = (targetType, listPos, anchorPos) => {
      if (readOnlyRef.current) return false
      const view = viewRef.current
      if (!view) return false
      // Record source offsets before changing the document. Crepe's
      // markdownUpdated callback is the authoritative transaction boundary;
      // deferring this into a later task can serialize a stale snapshot during
      // two consecutive conversions and overwrite the second visible change.
      if (Number.isFinite(listPos) && lastMarkdownRef.current) {
        try {
          const remark = crepe.editor.ctx.get(remarkCtx)
          // A list container boundary has no visible Markdown character. On a
          // nested tree, mapping `listPos + 1` can therefore land in the first
          // child list and patch the wrong source level. Use the actual text
          // position hit by the context menu; the replacement keeps text node
          // sizes stable, so the same anchor remains valid after conversion.
          const mappingPos = Number.isFinite(anchorPos)
            ? Math.max(listPos + 1, Math.min(anchorPos, view.state.doc.content.size))
            : view.state.selection.head
          const sourceOffset = pmPosToMarkdownOffset(
            lastMarkdownRef.current,
            mappingPos,
            view.state.doc,
            remark
          )
          const previousOffset = pmPosToMarkdownOffset(
            canonicalMarkdownRef.current,
            mappingPos,
            view.state.doc,
            remark
          )
          if (Number.isFinite(sourceOffset) && Number.isFinite(previousOffset)) {
            pendingListConversion = {
              source: lastMarkdownRef.current,
              sourceOffset,
              listPos,
              anchorPos: mappingPos,
              previous: canonicalMarkdownRef.current,
              previousOffset,
              targetType
            }
          }
        } catch {
          pendingListConversion = null
        }
      }
      markUserEdit()
      // Capture the conversion-only document before dispatch. markdownUpdated
      // can run during dispatch or after the user's next keystroke, so taking
      // this snapshot afterwards is inherently racy.
      const pending = pendingListConversion
      let conversionPreparationFailed = false
      const converted = convertListAtSelection(view, targetType, listPos, (convertedDoc) => {
        if (!pending || pendingListConversion !== pending) {
          conversionPreparationFailed = true
          return false
        }
        try {
          const serializer = crepe.editor.ctx.get(serializerCtx)
          const convertedCanonical = canonicalForSource(serializer(convertedDoc))
          const remark = crepe.editor.ctx.get(remarkCtx)
          const convertedOffset = pmPosToMarkdownOffset(
            convertedCanonical,
            Math.min(pending.anchorPos, convertedDoc.content.size),
            convertedDoc,
            remark
          )
          const convertedSource = Number.isFinite(convertedOffset)
            ? replaceMarkdownListBlock({
                source: pending.source,
                next: convertedCanonical,
                sourceOffset: pending.sourceOffset,
                nextOffset: convertedOffset,
                previous: pending.previous,
                previousOffset: pending.previousOffset
              })
            : null
          if (convertedSource) {
            pending.convertedCanonical = convertedCanonical
            pending.convertedSource = convertedSource
            pending.convertedDoc = convertedDoc
            return true
          }
        } catch (error) {
          console.error('List conversion source snapshot failed', error)
        }
        conversionPreparationFailed = true
        return false
      })
      if (!converted) {
        pendingListConversion = null
        if (conversionPreparationFailed) fireToast(tRef.current('list.convertFailed'))
        return false
      }
      // Some Milkdown paths do not emit markdownUpdated until a later input or
      // source-mode flush. Commit the verified conversion snapshot now; if the
      // callback already ran during dispatch it has cleared this same object.
      if (
        pendingListConversion === pending &&
        pending?.convertedSource &&
        pending?.convertedCanonical
      ) {
        const planned = listConversionSnapshotSourceSyncOwner.planListTypeConversion({
          token: pending,
          activeToken: pendingListConversion,
          currentSource: lastMarkdownRef.current,
          currentCanonical: canonicalMarkdownRef.current,
          expectedDoc: view.state.doc
        })
        if (planned.ok) {
          const coordinated = sourceSyncBridge.publish(planned.publication)
          if (coordinated?.ok) {
            pendingSourceSyncTransactionJournal = null
            clearRichFlushPending()
            pendingListConversion = null
          } else {
            userEditUntil = Date.now() + 1000
          }
        }
      }
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
      api.markdownUpdated((_ctx, md) => {
        const canonical = canonicalForSource(md)
        if (programmaticReplaceRef.current) {
          wholeDocumentReplacementPending = null
          pendingSourceSyncTransactionJournal = null
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
        if (viewRef.current?.composing) return
        const pendingPaste = pendingRawMarkdownPasteRef.current
        const pendingList = pendingListConversion
        const pendingWholeDocumentReplacement = wholeDocumentReplacementPending
        if (ready && !appending && (pendingPaste || pendingWholeDocumentReplacement || hasRecentUserEdit())) {
          const hasPendingListIntent = isActiveListInputIntent(pendingMarkdownInputIntent)
          let pendingPlainParagraphPlan = null
          const plainTransactionMode = transactionFirstMode()
          // Focused structural owners inspect the same journal before any
          // whole-document canonical diff. The registry currently owns exact
          // single-list-subtree and existing fenced-code content families;
          // quote/table migration adds owners there rather than callback branches.
          if (
            !pendingPaste &&
            !pendingList &&
            !pendingWholeDocumentReplacement &&
            !generatedScratchRef.current &&
            !pendingMarkdownInputIntent &&
            !hasPendingListIntent &&
            pendingSourceSyncTransactionJournal
          ) {
            const ownedStructuralTransaction = publishPendingStructuralTransaction({
              canonical,
              expectedDoc: viewRef.current?.state.doc,
              site: 'markdown-updated',
              notifyChange: true
            })
            if (ownedStructuralTransaction.ok) {
              transactionSourcePendingPublish = false
              transactionSourcePendingDoc = null
              transactionSourceBlockHints = []
              transactionSourceQuarantined = false
              wholeDocumentReplacementPending = null
              clearRichFlushPending()
              pendingRawMarkdownPasteRef.current = null
              pendingListConversion = null
              userEditUntil = Date.now() + 1000
              return
            }
          }
          // Plain paragraph authority/shadow consumes the same immutable
          // transaction journal as list topology. Authority publishes before
          // legacy inference; shadow retains only a local plan for byte
          // comparison after the legacy candidate is computed.
          if (
            !pendingPaste &&
            !pendingList &&
            !pendingWholeDocumentReplacement &&
            !generatedScratchRef.current &&
            !pendingMarkdownInputIntent &&
            !hasPendingListIntent &&
            pendingSourceSyncTransactionJournal &&
            plainTransactionMode !== 'disabled'
          ) {
            pendingPlainParagraphPlan = planPendingPlainParagraphTransaction({
              canonical,
              expectedDoc: viewRef.current?.state.doc,
              boundary: 'transaction-first-early-authority'
            })
            if (plainTransactionMode === 'authoritative' && pendingPlainParagraphPlan.ok) {
              const published = publishPlannedPlainParagraphTransaction({
                planned: pendingPlainParagraphPlan,
                notifyChange: true,
                boundary: 'transaction-first-early-authority'
              })
              tracePlainParagraphTransaction({
                planned: pendingPlainParagraphPlan,
                mode: 'authoritative',
                publicationOwner: published.ok ? 'transaction' : 'legacy',
                authorityDecision: published.ok ? 'authority-owned' : 'authority-publication-rejected',
                authorityEligible: published.ok
              })
              if (published.ok) {
                transactionSourcePendingPublish = false
                transactionSourcePendingDoc = null
                transactionSourceBlockHints = []
                transactionSourceQuarantined = false
                wholeDocumentReplacementPending = null
                clearRichFlushPending()
                pendingRawMarkdownPasteRef.current = null
                pendingListConversion = null
                userEditUntil = Date.now() + 1000
                return
              }
            }
          }
          // A pending list intent still needs its marker/slot reconstruction
          // even when the mapper already owned a later transaction (for
          // example typing in another block before the deferred list callback
          // landed). Skip the fast confirm path so the intent branch below
          // can fix up the list on top of the current source snapshot.
          if (!pendingPaste && !pendingList && !pendingWholeDocumentReplacement && transactionSourcePendingPublish && !hasPendingListIntent) {
            try {
              const parser = crepe.editor.ctx.get(parserCtx)
              const currentDoc = viewRef.current?.state.doc
              const callbackDoc = parser(canonical)
              if (
                transactionSourcePendingDoc?.eq?.(currentDoc) === true &&
                areSourceDocumentsEquivalent(callbackDoc, transactionSourcePendingDoc)
              ) {
                canonicalMarkdownRef.current = canonical
                clearRichFlushPending()
                transactionSourcePendingPublish = false
                transactionSourcePendingDoc = null
                transactionSourceQuarantined = false
                pendingSourceSyncTransactionJournal = null
                onChange?.(lastMarkdownRef.current, false)
                return
              }
            } catch {
              // The callback was not proven to represent the owned PM state;
              // continue into the established fail-closed preservation path.
            }
          }
          if (
            !pendingPaste &&
            !pendingList &&
            !pendingWholeDocumentReplacement &&
            canonical === canonicalMarkdownRef.current &&
            !hasPendingListIntent
          ) {
            // The canonical cache can be unchanged even after an earlier
            // preservation branch accidentally committed the wrong source.
            // Validate this fast path too; otherwise source mode/save would
            // silently return the divergent authored bytes forever.
            const committedIntegrity = validateSourceCandidate(
              lastMarkdownRef.current,
              viewRef.current?.state.doc,
              canonical,
              lastMarkdownRef.current,
              'committed-source-baseline'
            )
            if (committedIntegrity.ok === false) {
              reportSourceSyncFailure(committedIntegrity.reason)
              userEditUntil = Date.now() + 1000
              return
            }
            clearRichFlushPending()
            transactionSourceQuarantined = false
            pendingSourceSyncTransactionJournal = null
            if (transactionSourcePendingPublish) {
              transactionSourcePendingPublish = false
              transactionSourcePendingDoc = null
              onChange?.(lastMarkdownRef.current, false)
            }
            return
          }
          if (pendingPaste || pendingWholeDocumentReplacement) {
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
            if (!ownership.ok) {
              reportSourceSyncFailure(ownership.reason || 'document-replacement-owner-rejected')
              userEditUntil = Date.now() + 1000
              return
            }
            const coordinatedReplacement = sourceSyncBridge.publishOwned({ ownership })
            if (!coordinatedReplacement?.ok) {
              reportSourceSyncFailure(
                coordinatedReplacement?.reason || 'source-document-mismatch'
              )
              userEditUntil = Date.now() + 1000
              return
            }
            transactionSourcePendingPublish = false
            transactionSourcePendingDoc = null
            transactionSourceBlockHints = []
            transactionSourceQuarantined = false
            wholeDocumentReplacementPending = null
            clearRichFlushPending()
            pendingRawMarkdownPasteRef.current = null
            pendingListConversion = null
            pendingSourceSyncTransactionJournal = null
            userEditUntil = Date.now() + 1000
            return
          }
          let preserved
          if (generatedScratchRef.current) {
            const markdown = generatedScratchMarkdownForCanonical(canonical)
            // RS-51: Backspace on a generated empty list item can legitimately
            // leave exactly one editor-owned trailing empty paragraph inside
            // the preceding non-empty item. The normal preservation layer
            // already has a narrow, proven `empty-list-item-removed` contract
            // for this ProseMirror transient (including the raw post-list
            // blank slot). Generated scratch used to bypass that classification
            // and validate the compact full-canonical result under the generic
            // reason, so semantic integrity rejected a valid Backspace.
            //
            // Keep generated scratch authoritative for every other transaction:
            // only an exact successful reason from the established mapper may
            // override the generated markdown/reason here.
            const generatedLocalPreservation = preserveRichMarkdownSource(
              lastMarkdownRef.current,
              canonicalMarkdownRef.current,
              canonical
            )
            const emptyListRemoved = generatedLocalPreservation?.preserved !== false &&
              generatedLocalPreservation?.reason === 'empty-list-item-removed'
            const nestedEmptyListRemoved = generatedLocalPreservation?.preserved !== false &&
              generatedLocalPreservation?.reason === 'nested-empty-list-item-removed'
            const emptyListItemMergedAfterNestedList = generatedLocalPreservation?.preserved !== false &&
              generatedLocalPreservation?.reason === 'empty-list-item-merged-after-nested-list'
            const emptyOrderedItemMergedBeforeNestedList = generatedLocalPreservation?.preserved !== false &&
              generatedLocalPreservation?.reason === 'empty-ordered-item-merged-before-nested-list'
            const trailingListItemParagraphEmptied = generatedLocalPreservation?.preserved !== false &&
              generatedLocalPreservation?.reason === 'trailing-list-item-paragraph-emptied'
            const emptyTaskItemMergedToContinuation = generatedLocalPreservation?.preserved !== false &&
              generatedLocalPreservation?.reason === 'empty-task-item-merged-to-continuation'
            const trailingEmptyBlockquoteParagraphCreated = generatedLocalPreservation?.preserved !== false &&
              generatedLocalPreservation?.reason === 'trailing-empty-blockquote-paragraph-created'
            const postListToken = generatedPostListEmptyTransientRef.current
            const postListCheckpointMatches = Boolean(
              postListToken &&
              postListToken.source === lastMarkdownRef.current &&
              postListToken.canonical === canonicalMarkdownRef.current
            )
            const postListEmptyFilled = Boolean(
              postListCheckpointMatches &&
              generatedLocalPreservation?.preserved !== false &&
              generatedLocalPreservation?.reason === 'trailing-empty-block-filled'
            )

            if (
              emptyListRemoved ||
              nestedEmptyListRemoved ||
              emptyListItemMergedAfterNestedList ||
              emptyOrderedItemMergedBeforeNestedList ||
              trailingListItemParagraphEmptied ||
              emptyTaskItemMergedToContinuation ||
              trailingEmptyBlockquoteParagraphCreated
            ) {
              preserved = generatedLocalPreservation
              generatedPostListEmptyTransientRef.current = emptyListRemoved
                ? {
                    source: generatedLocalPreservation.markdown,
                    canonical
                  }
                : null
            } else if (postListEmptyFilled) {
              preserved = generatedLocalPreservation
              generatedPostListEmptyTransientRef.current = null
            } else {
              // Any different rich transaction invalidates the one-shot RS-52
              // ownership proof. Source-mode viewing/flush does not enter this
              // callback, so a pure mode round-trip keeps the checkpoint alive.
              generatedPostListEmptyTransientRef.current = null
              preserved = { markdown, reason: 'generated-scratch-canonical' }
            }
          } else if (pendingList?.convertedSource && pendingList?.convertedCanonical) {
            preserved = canonical === pendingList.convertedCanonical
              ? { markdown: pendingList.convertedSource }
              : preserveRichMarkdownSource(
                  pendingList.convertedSource,
                  pendingList.convertedCanonical,
                  canonical
                )
          } else if (pendingList) {
            try {
              const remark = crepe.editor.ctx.get(remarkCtx)
              const nextOffset = pmPosToMarkdownOffset(
                canonical,
                Math.min(pendingList.anchorPos, viewRef.current?.state.doc.content.size || 1),
                viewRef.current?.state.doc,
                remark
              )
              const markdown = Number.isFinite(nextOffset)
                ? replaceMarkdownListBlock({
                    source: pendingList.source,
                    next: canonical,
                    sourceOffset: pendingList.sourceOffset,
                    nextOffset,
                    previous: pendingList.previous,
                    previousOffset: pendingList.previousOffset
                  })
                : null
              preserved = markdown
                ? { markdown }
                : preserveRichMarkdownSource(
                    pendingList.source,
                    pendingList.previous,
                    canonical
                  )
            } catch {
              preserved = preserveRichMarkdownSource(
                pendingList.source,
                pendingList.previous,
                canonical
              )
            }
          } else {
            preserved = preserveRichMarkdownSource(
              lastMarkdownRef.current,
              canonicalMarkdownRef.current,
              canonical
            )
          }
          const preservedBeforeInputRule = preserved
          let pendingInputCanonicalOffset = null
          let consumedInputIntentForIntegrity = null
          traceEditorEvent('markdown-sync', {
            canonical,
            previousCanonical: canonicalMarkdownRef.current,
            source: lastMarkdownRef.current,
            preserved: preserved?.preserved !== false,
            reason: preserved?.reason || null,
            markdown: preserved?.markdown ?? null
          })
          const currentView = viewRef.current
          const selectionInList = (() => {
            const $head = currentView?.state.selection.$head
            if (!$head) return false
            for (let depth = $head.depth; depth > 0; depth -= 1) {
              const name = $head.node(depth).type.name
              if (name === 'bullet_list' || name === 'ordered_list') return true
            }
            return false
          })()
          const intentAnchorInList = (() => {
            if (!Number.isFinite(pendingMarkdownInputIntent?.pmPos)) return false
            const doc = currentView?.state.doc
            if (!doc) return false
            try {
              const safe = Math.max(1, Math.min(pendingMarkdownInputIntent.pmPos, doc.content.size))
              const $anchor = doc.resolve(safe)
              for (let depth = $anchor.depth; depth > 0; depth -= 1) {
                const name = $anchor.node(depth).type.name
                if (name === 'bullet_list' || name === 'ordered_list') return true
              }
            } catch {
              return false
            }
            return false
          })()
          if (
            isActiveListInputIntent(pendingMarkdownInputIntent)
          ) {
            try {
              // Do not gate the input-rule intent on the *current* selection
              // or on a mapped point still resolving inside the new list. An
              // input rule replaces the marker paragraph structurally, and a
              // deferred markdownUpdated may run after the user has exited the
              // list (or after later transactions mapped the captured point to
              // its boundary). The reconstruction helper already proves that
              // this exact canonical delta created a new list, so selection is
              // diagnostic evidence rather than ownership authority.
              // A literal marker callback may advance the canonical baseline
              // just before Space applies the list input rule. That does not
              // make the physical-key intent stale. Let the narrow helper
              // prove an exactly-new list in the captured delta; it returns
              // null instead of touching unrelated or older list trees.
              const remark = crepe.editor.ctx.get(remarkCtx)
              const canonicalOffset = pmPosToMarkdownOffset(
                canonical,
                Number.isFinite(pendingMarkdownInputIntent.pmPos)
                  ? pendingMarkdownInputIntent.pmPos
                  : currentView.state.selection.head,
                currentView.state.doc,
                remark
              )
              pendingInputCanonicalOffset = canonicalOffset
              // A deferred markdownUpdated can batch title, body, list, and
              // nested-list typing into one first callback. With no authored
              // baseline yet, generic new-document preservation already owns
              // the complete canonical document; replacing it with only the
              // list targeted by an old input-rule intent would drop title and
              // outer list items.
              const inputStartedFromEmptyDocument =
                !pendingMarkdownInputIntent.source &&
                !pendingMarkdownInputIntent.canonical
              let inputRuleMarkdown = inputStartedFromEmptyDocument
                ? null
                : preserveOwnedTypedBulletInputRule({
                    source: pendingMarkdownInputIntent.source,
                    currentSource: lastMarkdownRef.current,
                    // A delayed intent contributes only its own block. If its
                    // captured snapshot is no longer current, the helper keeps
                    // the old raw-slot fail-closed proof against this candidate.
                    preservedSource: preserved.markdown,
                    canonical,
                    previousCanonical: pendingMarkdownInputIntent.canonical,
                    sourceOffset: pendingMarkdownInputIntent.sourceOffset,
                    sourceSlotRawStart: pendingMarkdownInputIntent.sourceSlotRawStart,
                    canonicalOffset,
                    marker: pendingMarkdownInputIntent.marker
                  })
              const mappedMiddleListSlot = preserved.reason === 'middle-empty-block-list-filled'
              if (Array.isArray(globalThis.__hmListIntentTrace)) {
                globalThis.__hmListIntentTrace.push({
                  phase: 'apply',
                  marker: pendingMarkdownInputIntent.marker,
                  sourceSlotRawStart: pendingMarkdownInputIntent.sourceSlotRawStart,
                  inputRuleApplied: typeof inputRuleMarkdown === 'string',
                  mappedMiddleListSlot,
                  canonicalMatched: pendingMarkdownInputIntent.canonical === canonicalMarkdownRef.current,
                  selectionInList,
                  intentAnchorInList,
                  pmPos: pendingMarkdownInputIntent.pmPos
                })
              }
              if (inputRuleMarkdown) {
                preserved = {
                  ...preserved,
                  markdown: inputRuleMarkdown,
                  reason: 'typed-bullet-input-rule'
                }
              }
              let markerRestored = false
              // `preserveOwnedTypedBulletInputRule` already writes the physical
              // bullet marker into an EXACT owned source line/slot. Running the
              // broader bullet-marker restore again is not only redundant: for
              // a newly-created EMPTY bullet after exiting an earlier list, its
              // empty row has no text anchor and can be matched to that earlier
              // list, duplicating the old block. Ordered lists are different —
              // Crepe can still normalize `1.` to `1)` after reconstruction, so
              // their item-specific punctuation restore remains necessary.
              // A bullet that the ownership helper could not reconstruct still
              // gets the established fallback restore below.
              const markerRestoreNeeded =
                pendingMarkdownInputIntent.type === 'ordered-list' ||
                (pendingMarkdownInputIntent.type === 'bullet-list' && !inputRuleMarkdown)
              if (markerRestoreNeeded) {
                const markdown = restoreTypedBulletMarker({
                  markdown: preserved.markdown,
                  canonical,
                  previousCanonical: pendingMarkdownInputIntent.canonical,
                  canonicalOffset,
                  marker: pendingMarkdownInputIntent.marker
                })
                if (markdown !== preserved.markdown) {
                  markerRestored = true
                  preserved = { ...preserved, markdown, reason: 'typed-bullet-marker' }
                }
              }
              // This intent belongs to exactly one input-rule transition. Once
              // its list has been reconstructed, retaining the old source
              // snapshot makes a later Enter/Tab/nested-list transaction look
              // like the original list creation and can replace the outer list
              // with only its nested child. Subsequent typing is now handled by
              // normal list-tree preservation against the new source baseline.
              if (
                inputRuleMarkdown ||
                markerRestored ||
                inputStartedFromEmptyDocument ||
                mappedMiddleListSlot
              ) {
                const consumedIntent = pendingMarkdownInputIntent
                consumedInputIntentForIntegrity = consumedIntent
                // Any older intent that survived this callback is only allowed
                // to be part of the same fast keyboard batch. Keeping an intent
                // from a previous edit for 30 seconds is unsafe: after the
                // current list is published, its old source offsets can still
                // be applied to a later list and silently produce `1`, `-`,
                // `*`, or an extra numbered row without tripping fail-closed.
                const intentBatchWindow = 3000
                pendingMarkdownInputIntents = pendingMarkdownInputIntents
                  .filter((intent) =>
                    isActiveListInputIntent(intent) &&
                    Math.abs(Number(intent.at) - Number(consumedIntent.at)) <= intentBatchWindow &&
                    intent.source === consumedIntent.source
                  )
                // Keep a consumed intent only for the short callback tail of
                // this same input-rule dispatch. It must not survive a user's
                // IME/body typing and the following Enter: that later callback
                // belongs to the newly-created list item, not to the original
                // marker. The old 3-second capture window was long enough for
                // `1.` -> Space -> IME composition -> Enter to reuse the old
                // marker and rewrite the new empty row (`2.` became `1.`).
                const callbackTailUntil = Date.now() + 750
                pendingMarkdownInputIntents = pendingMarkdownInputIntents.map((intent) => ({
                  ...intent,
                  batchUntil: Math.min(
                    Number.isFinite(intent.batchUntil) ? intent.batchUntil : callbackTailUntil,
                    callbackTailUntil
                  )
                }))
                pendingMarkdownInputIntent = pendingMarkdownInputIntents.at(-1) || null
                if (Array.isArray(globalThis.__hmListIntentTrace)) {
                  globalThis.__hmListIntentTrace.push({
                    phase: 'consumed-callback-tail',
                    kept: pendingMarkdownInputIntents.length,
                    expiresIn: callbackTailUntil - Date.now()
                  })
                }
              }
            } catch {
              // The normal source-preservation result remains valid if the
              // transient selection cannot be mapped during editor teardown.
            }
          } else if (pendingMarkdownInputIntent) {
            if (Array.isArray(globalThis.__hmListIntentTrace)) {
              globalThis.__hmListIntentTrace.push({
                phase: 'cleared-without-list',
                selectionInList,
                intentAnchorInList,
                sourceSlotRawStart: pendingMarkdownInputIntent.sourceSlotRawStart,
                age: Date.now() - pendingMarkdownInputIntent.at,
                type: pendingMarkdownInputIntent.type
              })
            }
            pendingMarkdownInputIntent = null
            pendingMarkdownInputIntents = pendingMarkdownInputIntents
              .filter((intent) => isActiveListInputIntent(intent))
          }
          let preparedSourceSync = null
          const prepareSourceSyncCandidate = (result, validationSite) =>
            sourceSyncBridge.prepare({
              result,
              canonical,
              expectedDoc: currentView?.state.doc,
              validationSite,
              boundary: 'markdown-updated'
            })
          if (preserved.preserved !== false) {
            preparedSourceSync = prepareSourceSyncCandidate(preserved, 'primary-preserved')
            const integrity = preparedSourceSync.validation
            if (integrity.ok === false) {
              const candidateMarkdown = preserved.markdown
              const fallbackPrepared = prepareSourceSyncCandidate(
                preservedBeforeInputRule,
                'before-input-rule-fallback'
              )
              const fallbackIntegrity = fallbackPrepared.validation
              if (fallbackIntegrity.ok) {
                let fallbackMarkdown = preservedBeforeInputRule.markdown
                const intent = consumedInputIntentForIntegrity || pendingMarkdownInputIntent
                if (intent && Number.isFinite(pendingInputCanonicalOffset)) {
                  fallbackMarkdown = restoreTypedBulletMarker({
                    markdown: fallbackMarkdown,
                    canonical,
                    previousCanonical: intent.canonical,
                    canonicalOffset: pendingInputCanonicalOffset,
                    marker: intent.marker
                  })
                }
                const restoredResult = {
                  ...preservedBeforeInputRule,
                  markdown: fallbackMarkdown,
                  reason: 'typed-bullet-input-rule-fallback',
                  integrityProof: null
                }
                const restoredPrepared = prepareSourceSyncCandidate(
                  restoredResult,
                  'typed-bullet-input-rule-fallback'
                )
                if (restoredPrepared.validation.ok) {
                  preserved = {
                    ...preservedBeforeInputRule,
                    markdown: fallbackMarkdown,
                    reason: 'typed-bullet-input-rule-fallback'
                  }
                  preparedSourceSync = restoredPrepared
                }
              }
              let postFallbackPrepared = null
              const postFallbackOk = !(
                preserved === preservedBeforeInputRule || preserved.preserved === false
              ) && (() => {
                postFallbackPrepared = prepareSourceSyncCandidate(
                  preserved,
                  'post-fallback-recheck'
                )
                return postFallbackPrepared.validation.ok
              })()
              if (!postFallbackOk) {
                const reason = integrity.reason || 'source-document-mismatch'
                preserved = {
                  ...preserved,
                  preserved: false,
                  reason,
                  markdown: lastMarkdownRef.current
                }
                reportSourceSyncFailure(reason)
                traceEditorEvent('markdown-sync-integrity', {
                  reason,
                  source: lastMarkdownRef.current,
                  candidate: candidateMarkdown,
                  canonical
                })
              } else {
                preparedSourceSync = postFallbackPrepared
              }
            }
          }
          // Apply the captured physical marker one final time immediately
          // before publication. A deferred callback can first fail validation,
          // retry from the previous source, and otherwise lose the correction
          // even though the helper found the right canonical row. This final
          // pass is local to the consumed intent and still requires semantic
          // validation; it cannot normalize unrelated source blocks.
          if (
            preserved.preserved !== false &&
            consumedInputIntentForIntegrity &&
            Number.isFinite(pendingInputCanonicalOffset)
          ) {
            const corrected = restoreTypedBulletMarker({
              markdown: preserved.markdown,
              canonical,
              previousCanonical: consumedInputIntentForIntegrity.canonical,
              canonicalOffset: pendingInputCanonicalOffset,
              marker: consumedInputIntentForIntegrity.marker
            })
            if (corrected !== preserved.markdown) {
              const correctedResult = {
                ...preserved,
                markdown: corrected,
                reason: 'final-typed-marker-restore',
                integrityProof: null
              }
              const correctedPrepared = prepareSourceSyncCandidate(
                correctedResult,
                'final-typed-marker-restore'
              )
              if (correctedPrepared.validation.ok) {
                preserved = { ...preserved, markdown: corrected, reason: 'final-typed-marker-restore' }
                preparedSourceSync = correctedPrepared
              }
            }
          }
          if (pendingPlainParagraphPlan) {
            tracePlainParagraphTransaction({
              planned: pendingPlainParagraphPlan,
              mode: plainTransactionMode,
              legacyResult: preserved.preserved === false ? null : preserved,
              publicationOwner: 'legacy',
              authorityDecision: plainTransactionMode === 'authoritative'
                ? pendingPlainParagraphPlan.ok
                  ? 'authority-publication-rejected'
                  : 'authority-transaction-rejected'
                : 'authority-disabled',
              authorityEligible: false
            })
          }
          if (preserved.preserved === false) {
            reportSourceSyncFailure(preserved.reason || 'unmapped-source-change')
            // The visible ProseMirror transaction is still real, but its raw
            // Markdown ownership is ambiguous. Keep every pending intent and
            // the dirty/flush flag alive; publishing the old source here would
            // falsely mark the edit committed and let save resurrect stale
            // bytes. A later callback or forced flush retries the cumulative
            // delta against the same canonical baseline.
            userEditUntil = Date.now() + 1000
            return
          }
          // Legacy and allowlisted transaction candidates now share the same
          // revision/proof-bound Publisher. The owner/family differ, but stale
          // source/canonical/doc and duplicate publication are enforced once.
          if (!preparedSourceSync) {
            preparedSourceSync = prepareSourceSyncCandidate(
              preserved,
              'markdown-updated-final'
            )
          }
          const coordinated = sourceSyncBridge.publishPrepared(
            preparedSourceSync,
            { notifyChange: true }
          )
          if (!coordinated?.ok) {
            const reason = coordinated?.reason || 'source-document-mismatch'
            reportSourceSyncFailure(reason)
            userEditUntil = Date.now() + 1000
            return
          }
          transactionSourcePendingPublish = false
          transactionSourcePendingDoc = null
          transactionSourceBlockHints = []
          transactionSourceQuarantined = false
          wholeDocumentReplacementPending = null
          clearRichFlushPending()
          pendingRawMarkdownPasteRef.current = null
          pendingListConversion = null
          pendingSourceSyncTransactionJournal = null
          if (Array.isArray(globalThis.__hmListIntentTrace)) {
            globalThis.__hmListIntentTrace.push({
              phase: 'publish',
              reason: preserved.reason,
              markdown: preserved.markdown
            })
          }
          userEditUntil = Date.now() + 1000
        }
      })
    })

    const runCreate = () =>
      crepe
        .create()
        .then(() => {
          if (destroyed) {
            crepe.destroy()
            return
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
                const start = Math.min(rawFrom, rawTo)
                const end = Math.max(rawFrom, rawTo)
                next = source.slice(0, start) + markdown + source.slice(end)
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
            const currentView = viewRef.current
            let sourceOffset = null
            let sourceSlotRawStart = null
            try {
              const remark = crepe.editor.ctx.get(remarkCtx)
              sourceOffset = pmPosToMarkdownOffset(
                lastMarkdownRef.current,
                currentView?.state.selection.head,
                currentView?.state.doc,
                remark
              )
              const $from = currentView?.state.selection.$from
              const topStart = $from?.depth >= 1 ? $from.before(1) : null
              const slot = transactionSourceBlockHints
                .find((candidate) => candidate.pmBlockStart === topStart)
              if (slot) sourceSlotRawStart = slot.rawStart
              // In release mode transaction block hints are intentionally not
              // collected. A list marker typed in the final top-level empty
              // paragraph still has one exact raw owner: the document tail.
              // Record that boundary instead of trusting a visible-text
              // lookup, which can select an earlier duplicate sentence in a
              // long document (123321.md repeatedly contains “测试”).
              const topIndex = $from?.index?.(0)
              const ownsTopLevelPlaceholder =
                $from?.depth === 1 &&
                $from?.parent?.type?.name === 'paragraph'
              const followingTopBlocksAreEmpty = Number.isFinite(topIndex) &&
                Array.from(
                  { length: Math.max(0, currentView.state.doc.childCount - topIndex - 1) },
                  (_, offset) => currentView.state.doc.child(topIndex + offset + 1)
                ).every((node) => !node.textContent)
              if (
                !Number.isFinite(sourceSlotRawStart) &&
                ownsTopLevelPlaceholder &&
                followingTopBlocksAreEmpty
              ) {
                sourceSlotRawStart = lastMarkdownRef.current.length
              }
            } catch {
              // The input rule will still take the generic preservation path.
            }
            pendingMarkdownInputIntent = {
              ...intent,
              at: Date.now(),
              pmPos: currentView?.state.selection.head,
              canonical: canonicalMarkdownRef.current,
              source: lastMarkdownRef.current,
              sourceOffset,
              sourceSlotRawStart,
              batchUntil: Date.now() + 3000
            }
            if (Array.isArray(globalThis.__hmListIntentTrace)) {
              globalThis.__hmListIntentTrace.push({
                marker: intent.marker,
                sourceOffset,
                sourceSlotRawStart,
                pmPos: currentView?.state.selection.head,
                topIndex,
                ownsTopLevelPlaceholder,
                topChildCount: currentView?.state.doc.childCount,
                followingTopBlocksAreEmpty,
                sourceLength: lastMarkdownRef.current.length,
                canonical: canonicalMarkdownRef.current
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
          hasPendingRichFlush: () => richFlushPending,
          clearPendingRichFlush: clearRichFlushPending,
          generatedScratchRef,
          getGeneratedScratchMarkdown: (canonical) => generatedScratchMarkdownForCanonical(canonical, true),
          canonicalForSource,
          setBlock,
          markUserEdit,
          onStructureChange,
          isDestroyed: () => destroyed,
          getT: (key) => tRef.current(key),
          notify: fireToast,
          validateSourceCandidate,
          publishSourceSyncResult,
          publishPendingTransactionJournal,
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
          interactionReadyRef.current = true
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
  const pickBlock = (id) => apiRef.current?.setBlock(id)
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
            : <img ref={lightboxContentRef} src={zoom.src} alt="" onClick={(e) => e.stopPropagation()} />
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
