import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  editorViewCtx,
  parserCtx,
  remarkCtx,
  serializerCtx
} from '@milkdown/kit/core'
import './editor-codeblock-eager.js' // side effect: root-fix #25 — eager, non-tearing code-block node view
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
import { convertListAtSelection, getListConversionContext } from './editor-list-conversion.js'
import { normalizeReviewMarkupMarkdown } from '../reviewMarkup.js'
import { REVIEW_KINDS } from './editor-review.js'
import { createEditorApi } from './editor-api.js'
import { useEditorLightboxControls } from './editor-lightbox.js'
import { applyImageText, createConfiguredCrepe } from './editor-crepe-setup.js'
import { mountEditorDomBindings } from './editor-dom-bindings.js'
import { getCommandShortcut } from '../lib/commands/shortcut-labels.js'
import {
  generatedScratchMarkdown,
  preserveRichMarkdownSource,
  preserveGeneratedBulletMarkers,
  preserveTypedBulletInputRule,
  replaceMarkdownFrontmatterBlock,
  replaceMarkdownListBlock,
  restoreTypedBulletMarker
} from '../markdown-source-preservation.js'
import { pmPosToMarkdownOffset } from './editor-source-map.js'

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
    let richDirtyReconcileTimer = 0
    const markUserEdit = (ttl = 8000) => {
      programmaticReplaceRef.current = null
      userEditUntil = Date.now() + ttl
      richFlushPending = true
    }
    // Milkdown's listener batches markdownUpdated for 200ms. A user can type
    // and then revert within that window, leaving its final ProseMirror doc
    // equal to the listener's previous doc; Milkdown correctly skips the
    // callback, but HorseMD's immediate dirty hint must then be cleared. This
    // one-shot reconciliation runs only after a real DOM mutation and only
    // while the regular listener has not already settled the change.
    const scheduleRichDirtyReconcile = () => {
      if (richDirtyReconcileTimer) clearTimeout(richDirtyReconcileTimer)
      richDirtyReconcileTimer = window.setTimeout(() => {
        richDirtyReconcileTimer = 0
        if (destroyed || !richFlushPending) return
        const markdown = apiRef.current?.flushMarkdown?.()
        if (typeof markdown === 'string') onChange?.(markdown, false)
      }, 260)
    }
    const hasRecentUserEdit = () => Date.now() <= userEditUntil
    const clearRichFlushPending = () => { richFlushPending = false }
    const pendingRawMarkdownPasteRef = { current: null }
    let pendingListConversion = null
    let pendingMarkdownInputIntent = null
    // A physical/IME input sequence can create an outer list and a nested list
    // before Milkdown emits its first markdownUpdated callback. Keep every
    // marker intent until that callback serializes the generated document;
    // retaining only the latest intent loses the outer marker (`1.` -> `1)`).
    let pendingMarkdownInputIntents = []

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
        const canonical = canonicalForSource(crepe.getMarkdown())
        // If a future Milkdown release emits markdownUpdated for atom attrs,
        // that listener has already committed this transaction.
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
        const committed = markdown || preserveRichMarkdownSource(
          lastMarkdownRef.current,
          canonicalMarkdownRef.current,
          canonical
        ).markdown
        lastMarkdownRef.current = committed
        canonicalMarkdownRef.current = canonical
        clearRichFlushPending()
        onChange?.(committed, false)
      } catch {
        // The live editor remains correct; the normal markdownUpdated callback
        // still owns fallback serialization if a mapper/plugin is unavailable.
      }
    }

    const handleInlineCodeValueChange = () => {
      try {
        const canonical = canonicalForSource(crepe.getMarkdown())
        if (canonical === canonicalMarkdownRef.current) return
        const preserved = preserveRichMarkdownSource(
          lastMarkdownRef.current,
          canonicalMarkdownRef.current,
          canonical
        )
        lastMarkdownRef.current = preserved.markdown
        canonicalMarkdownRef.current = canonical
        clearRichFlushPending()
        onChange?.(preserved.markdown, false)
      } catch {
        // The editor remains usable if serialization is transiently unavailable;
        // normal markdownUpdated remains the fallback for ordinary input.
      }
    }

    const crepe = createConfiguredCrepe({
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
      onInlineCodeValueChange: handleInlineCodeValueChange
    })
    crepeRef.current = crepe

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
          const markdown = exactLineFallback || preserved.markdown
          lastMarkdownRef.current = markdown
          canonicalMarkdownRef.current = canonical
          clearRichFlushPending()
          onChange?.(markdown, false)
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
              previousOffset
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
        lastMarkdownRef.current = pending.convertedSource
        canonicalMarkdownRef.current = pending.convertedCanonical
        clearRichFlushPending()
        pendingListConversion = null
        onChange?.(pending.convertedSource, false)
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
    let appending = false
    crepe.on((api) => {
      api.markdownUpdated((_ctx, md) => {
        const canonical = canonicalForSource(md)
        if (programmaticReplaceRef.current) {
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
        if (ready && !appending && (pendingPaste || hasRecentUserEdit())) {
          if (!pendingPaste && !pendingList && canonical === canonicalMarkdownRef.current) {
            // The matching source snapshot has already been committed. Clear
            // the synchronous edit guard so a later reading-only mode switch
            // does not reserialize the same large document.
            clearRichFlushPending()
            return
          }
          let preserved
          if (pendingPaste) {
            preserved = { markdown: pendingPaste.markdown }
          } else if (generatedScratchRef.current) {
            const markdown = generatedScratchMarkdownForCanonical(canonical)
            preserved = { markdown, reason: 'generated-scratch-canonical' }
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
          if (
            (pendingMarkdownInputIntent?.type === 'bullet-list' ||
              pendingMarkdownInputIntent?.type === 'ordered-list') &&
            Date.now() - pendingMarkdownInputIntent.at < 30000 &&
            selectionInList
          ) {
            try {
              // An input-rule intent applies only while the document baseline
              // is still the snapshot captured when the marker key was pressed.
              // If an intermediate markdownUpdated already committed a newer
              // canonical (for example the ordered-list `1.` intent is still
              // pending, 30 s TTL, when a later bullet list is created and then
              // indented), replaying the old snapshot rebuilds the wrong block
              // and glues list rows onto the wrong line. Consume it as stale.
              if (pendingMarkdownInputIntent.canonical !== canonicalMarkdownRef.current) {
                pendingMarkdownInputIntent = null
                pendingMarkdownInputIntents = []
                return
              }
              const remark = crepe.editor.ctx.get(remarkCtx)
              const canonicalOffset = pmPosToMarkdownOffset(
                canonical,
                currentView.state.selection.head,
                currentView.state.doc,
                remark
              )
              // A deferred markdownUpdated can batch title, body, list, and
              // nested-list typing into one first callback. With no authored
              // baseline yet, generic new-document preservation already owns
              // the complete canonical document; replacing it with only the
              // list targeted by an old input-rule intent would drop title and
              // outer list items.
              const inputStartedFromEmptyDocument =
                !pendingMarkdownInputIntent.source &&
                !pendingMarkdownInputIntent.canonical
              const inputRuleMarkdown = inputStartedFromEmptyDocument
                ? null
                : preserveTypedBulletInputRule({
                    source: pendingMarkdownInputIntent.source,
                    canonical,
                    previousCanonical: pendingMarkdownInputIntent.canonical,
                    sourceOffset: pendingMarkdownInputIntent.sourceOffset,
                    canonicalOffset,
                    marker: pendingMarkdownInputIntent.marker
                  })
              if (inputRuleMarkdown) {
                preserved = {
                  ...preserved,
                  markdown: inputRuleMarkdown,
                  reason: 'typed-bullet-input-rule'
                }
              }
              if (pendingMarkdownInputIntent.type === 'bullet-list') {
                const markdown = restoreTypedBulletMarker({
                  markdown: preserved.markdown,
                  canonical,
                  previousCanonical: pendingMarkdownInputIntent.canonical,
                  canonicalOffset,
                  marker: pendingMarkdownInputIntent.marker
                })
                if (markdown !== preserved.markdown) {
                  preserved = { ...preserved, markdown, reason: 'typed-bullet-marker' }
                }
              }
              // This intent belongs to exactly one input-rule transition. Once
              // its list has been reconstructed, retaining the old source
              // snapshot makes a later Enter/Tab/nested-list transaction look
              // like the original list creation and can replace the outer list
              // with only its nested child. Subsequent typing is now handled by
              // normal list-tree preservation against the new source baseline.
              if (inputRuleMarkdown || inputStartedFromEmptyDocument) pendingMarkdownInputIntent = null
            } catch {
              // The normal source-preservation result remains valid if the
              // transient selection cannot be mapped during editor teardown.
            }
          } else if (pendingMarkdownInputIntent) {
            pendingMarkdownInputIntent = null
          }
          // Source mapping must use the same markdown snapshot that App stores
          // and shows in the source textarea after this user edit.
          lastMarkdownRef.current = preserved.markdown
          canonicalMarkdownRef.current = canonical
          clearRichFlushPending()
          pendingRawMarkdownPasteRef.current = null
          pendingListConversion = null
          onChange?.(preserved.markdown, false)
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
          onRichEditPending: () => {
            onRichEditPending?.()
            scheduleRichDirtyReconcile()
          },
          insertUploadedImage,
          prepareRawMarkdownPaste: ({ markdown, from, to }) => {
            const source = lastMarkdownRef.current || ''
            let next = markdown
            const replacesWholeDocument = from <= 1 && to >= view.state.doc.content.size
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
            const pending = { markdown: next }
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
            try {
              const remark = crepe.editor.ctx.get(remarkCtx)
              sourceOffset = pmPosToMarkdownOffset(
                lastMarkdownRef.current,
                currentView?.state.selection.head,
                currentView?.state.doc,
                remark
              )
            } catch {
              // The input rule will still take the generic preservation path.
            }
            pendingMarkdownInputIntent = {
              ...intent,
              at: Date.now(),
              pmPos: currentView?.state.selection.head,
              canonical: canonicalMarkdownRef.current,
              source: lastMarkdownRef.current,
              sourceOffset
            }
            pendingMarkdownInputIntents = [
              ...pendingMarkdownInputIntents.filter((pending) => Date.now() - pending.at < 30000),
              pendingMarkdownInputIntent
            ]
          },
          isReadOnly: () => readOnlyRef.current,
          isDestroyed: () => destroyed
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
          notify: fireToast
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
