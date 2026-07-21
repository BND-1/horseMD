import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  editorViewCtx,
  parserCtx,
  remarkCtx
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
import { normalizeReviewMarkupMarkdown } from '../reviewMarkup.js'
import { createEditorApi } from './editor-api.js'
import { useEditorLightboxControls } from './editor-lightbox.js'
import { applyImageText, createConfiguredCrepe } from './editor-crepe-setup.js'
import { mountEditorDomBindings } from './editor-dom-bindings.js'
import { getCommandShortcut } from '../lib/commands/shortcut-labels.js'
import { preserveRichMarkdownSource } from '../markdown-source-preservation.js'
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
  readOnly = false,
  effectiveKeybindings,
  onChange,
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
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
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
    try { view.setProps({ editable: () => !readOnly }) } catch { /* view is tearing down */ }
    view.dom.contentEditable = readOnly ? 'false' : 'true'
    view.dom.setAttribute('aria-readonly', readOnly ? 'true' : 'false')
  }, [readOnly])
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
  // Keep the source snapshot separate from Crepe's canonical serialization.
  // The first is what the user wrote; the second lets us isolate a rich-text
  // transaction instead of replacing untouched source with formatter output.
  const lastMarkdownRef = useRef(initialContent || '')
  const canonicalMarkdownRef = useRef('')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let ready = false
    let destroyed = false
    let createRaf = 0
    const cleanups = []

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
    const markUserEdit = (ttl = 8000) => {
      userEditUntil = Date.now() + ttl
    }
    const hasRecentUserEdit = () => Date.now() <= userEditUntil
    const pendingRawMarkdownPasteRef = { current: null }

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

    const crepe = createConfiguredCrepe({
      host,
      defaultValue: normalizeReviewMarkupMarkdown(normalizeDisplayMath(firstContent)),
      getT: (key) => tRef.current(key),
      persistImage,
      notify: fireToast,
      copyText: copyToClipboard,
      getInlineMathDeleteMode: () => inlineMathDeleteModeRef.current
    })
    crepeRef.current = crepe

    // Block controls live in editor-block-controls.js; mount them here and
    // reuse the same conversion path across shortcuts, menus and toolbars.
    const { setBlock: setEditableBlock, reportActiveBlock } = createBlockControls({
      viewRef,
      setCtxMenu,
      onActiveBlock,
      lastBlockRef
    })
    const setBlock = (id) => {
      if (readOnlyRef.current) return
      setEditableBlock(id)
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
        const pendingPaste = pendingRawMarkdownPasteRef.current
        if (ready && !appending && (pendingPaste || hasRecentUserEdit())) {
          const canonical = normalizeReviewMarkupMarkdown(md)
          const preserved = pendingPaste
            ? { markdown: pendingPaste.markdown }
            : preserveRichMarkdownSource(
                lastMarkdownRef.current,
                canonicalMarkdownRef.current,
                canonical
              )
          // Source mapping must use the same markdown snapshot that App stores
          // and shows in the source textarea after this user edit.
          lastMarkdownRef.current = preserved.markdown
          canonicalMarkdownRef.current = canonical
          pendingRawMarkdownPasteRef.current = null
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
          try { view.setProps({ editable: () => !readOnlyRef.current }) } catch { /* */ }
          view.dom.contentEditable = readOnlyRef.current ? 'false' : 'true'
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
          setCtxMenu,
          setZoom,
          getT: (key) => tRef.current(key),
          getKeybindings: () => effectiveKeybindingsRef.current,
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
          setBlock,
          onStructureChange,
          isDestroyed: () => destroyed,
          getT: (key) => tRef.current(key),
          notify: fireToast
        })
        const {
          getPdfSource,
          getMarkdown,
          toggleHighlight,
          applyReviewMarkup,
          replaceMarkdown,
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
              canonicalMarkdownRef.current = normalizeReviewMarkupMarkdown(crepe.getMarkdown())
            } catch { /* */ }
          }
          ready = true
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
            if (!destroyed) finishInitial(false)
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
          <div className="block-ctxmenu" style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 210),
            top: Math.min(ctxMenu.y, window.innerHeight - 320)
          }}>
            <div className="block-menu-label">{t('block.turnInto')}</div>
            {BLOCK_TYPES.map((b) => (
              <button key={b.id} className="block-menu-item" onMouseDown={(e) => e.preventDefault()} onClick={() => pickBlock(b.id)}>
                <span className="block-menu-short">{b.short}</span>
                <span className="block-menu-name">{t('block.' + b.id)}</span>
                <span className="block-menu-sc">{getCommandShortcut(b.commandId, effectiveKeybindings)}</span>
              </button>
            ))}
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
