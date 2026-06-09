import { useEffect, useRef, useState } from 'react'
import { Crepe, CrepeFeature } from '@milkdown/crepe'
import { editorViewCtx, nodeViewCtx } from '@milkdown/kit/core'
import { imageBlockConfig } from '@milkdown/kit/component/image-block'
import { inlineImageConfig } from '@milkdown/kit/component/image-inline'
import { TextSelection } from '@milkdown/prose/state'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import '@milkdown/crepe/theme/common/link-tooltip.css'
import { BLOCK_TYPES, blockById, currentBlockId } from '../blocks.js'
import { useI18n } from '../i18n.jsx'

// Every mounted rich editor registers itself here. A rich-text tab stays mounted
// after its first activation, so several editors (and several Crepe selection
// toolbars) can coexist. The heading button injected into a toolbar resolves its
// target editor at click time — the one that currently owns the selection —
// instead of capturing a single instance, which previously made the button act
// on the wrong (hidden) tab when more than one tab was open.
const liveEditors = new Set()

// Localize the image-block / inline-image UI text (caption placeholder, upload
// buttons…) from the current translator. Applied at create and re-applied on a
// language switch so "Write image caption" follows the zh/en toggle.
function applyImageText(ctx, tt) {
  try {
    ctx.update(imageBlockConfig.key, (v) => ({
      ...v,
      captionPlaceholderText: tt('image.caption'),
      uploadPlaceholderText: tt('image.pasteLink'),
      uploadButton: tt('image.uploadFile'),
      confirmButton: tt('image.confirm')
    }))
    ctx.update(inlineImageConfig.key, (v) => ({
      ...v,
      uploadPlaceholderText: tt('image.pasteLink'),
      uploadButton: tt('image.upload'),
      confirmButton: tt('image.confirm')
    }))
  } catch {
    /* config not ready yet — the create-time call covers the initial value */
  }
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
export default function Editor({ initialContent, docPath, onChange, onReady, onActiveBlock }) {
  const { t } = useI18n()
  const tRef = useRef(t)
  tRef.current = t
  const hostRef = useRef(null)
  const viewRef = useRef(null)
  const apiRef = useRef(null)
  const crepeRef = useRef(null)
  const lastBlockRef = useRef(null)
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y } viewport coords, or null
  // Floating "block level" indicator that tracks the caret (H1…H6 / Text).
  const [level, setLevel] = useState(null) // { label, kind, top, left } or null
  // Lightbox: the image src currently shown enlarged, or null.
  const [zoom, setZoom] = useState(null)
  // False until Crepe has parsed and rendered the document — drives the loading
  // skeleton. Only large documents (which actually take a moment to render) show
  // it, so small files never flash a placeholder.
  const [loaded, setLoaded] = useState(false)
  const isLargeDoc = (initialContent?.length || 0) > 20000

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

    const crepe = new Crepe({
      root: host,
      defaultValue: initialContent || '',
      features: {
        [CrepeFeature.SelectionTooltip]: true,
        [CrepeFeature.SlashCommand]: true,
        [CrepeFeature.BlockEdit]: true,
        [CrepeFeature.CodeMirror]: true,
        [CrepeFeature.Table]: true,
        [CrepeFeature.InlineCode]: true,
        [CrepeFeature.LinkTooltip]: true,
        // Disable Crepe's virtual cursor: it replaces the native caret with a
        // custom element that reflows text on selection/focus (content jumps),
        // and hides the native caret (invisible in table cells). We use the
        // native caret styled via `caret-color` instead.
        [CrepeFeature.Cursor]: false
      },
      featureConfigs: {
        // Localized empty-block placeholder (replaces Crepe's "Please enter").
        [CrepeFeature.Placeholder]: { text: t('editor.placeholder'), mode: 'block' }
      }
    })

    // Render raw HTML blocks (e.g. <table>…</table>) as actual HTML, like Typora.
    // Milkdown's default `html` node shows the markup as escaped text; we add a
    // ProseMirror node view that renders it instead. Display-only — the node
    // still round-trips through attrs.value, so saving keeps the original HTML.
    //
    // Register through nodeViewCtx (the shared registry Milkdown's $view uses),
    // NOT editorViewOptionsCtx.nodeViews: the core spreads editorViewOptionsCtx
    // LAST into the EditorView constructor, so setting .nodeViews there would
    // overwrite every component node view (image-block captions, CodeMirror code
    // blocks, tables, list items). Appending here merges with them.
    crepe.editor.config((ctx) => {
      ctx.update(nodeViewCtx, (views) => [...views, ['html', (node) => renderHtmlNodeView(node)]])
      // Localize the image caption / upload text to the current language.
      applyImageText(ctx, tRef.current)
    })
    crepeRef.current = crepe

    // Convert the block the cursor sits in to a given block id (paragraph/h1…h6).
    const setBlock = (id) => {
      const view = viewRef.current
      if (!view) return
      const def = blockById(id)
      if (!def) return
      convertBlock(view, def.name, def.level ? { level: def.level } : {})
      view.focus()
      reportActiveBlock()
      refreshLevel()
      setCtxMenu(null)
    }

    // Push the cursor's current block type up to the parent (status bar).
    const reportActiveBlock = () => {
      const view = viewRef.current
      if (!view) return
      const id = currentBlockId(view.state)
      if (id !== lastBlockRef.current) {
        lastBlockRef.current = id
        onActiveBlock?.(id)
      }
    }

    // Position the floating level badge next to the caret's line. Hidden when
    // the editor isn't focused or the caret has scrolled out of view.
    const refreshLevel = () => {
      const view = viewRef.current
      if (!view || !view.hasFocus()) {
        setLevel(null)
        return
      }
      const sel = view.state.selection
      let coords
      try {
        coords = view.coordsAtPos(sel.from)
      } catch {
        return
      }
      const scrollEl = host.closest('.editor-scroll')
      const r = scrollEl
        ? scrollEl.getBoundingClientRect()
        : { top: 0, bottom: window.innerHeight, left: 0 }
      if (coords.bottom < r.top + 2 || coords.top > r.bottom - 2) {
        setLevel(null)
        return
      }
      const id = currentBlockId(view.state)
      const def = blockById(id)
      // Only headings (H1…H6) and plain paragraphs get a badge.
      if (!def) {
        setLevel(null)
        return
      }
      // Anchor to the current block's left edge so the tag sits just beside the
      // text, not floating off at the pane edge.
      let blockLeft = coords.left
      try {
        let el = view.domAtPos(sel.from).node
        if (el && el.nodeType === 3) el = el.parentElement
        const pm = view.dom
        while (el && el !== pm && el.parentElement && el.parentElement !== pm) {
          el = el.parentElement
        }
        if (el && el !== pm) blockLeft = el.getBoundingClientRect().left
      } catch {
        /* fall back to the caret x */
      }
      const kind = id === 'paragraph' ? 'text' : 'heading'
      const label = id === 'paragraph' ? tRef.current('block.paragraph') : def.short
      // Sit in the gutter just left of the text; if the window is too narrow for
      // that, tuck the tag against the pane's left edge instead.
      const align = blockLeft - 10 - r.left >= 46 ? 'right' : 'left'
      const x = align === 'right' ? blockLeft - 10 : r.left + 6
      setLevel({ label, kind, align, top: (coords.top + coords.bottom) / 2, x })
    }

    // refreshLevel does forced layout reads (coordsAtPos / getBoundingClientRect).
    // Selection change and scroll fire on every keystroke; on a large document
    // that synchronous reflow is the main typing lag. Coalesce bursts into one
    // measurement per animation frame.
    let levelRaf = 0
    const scheduleLevel = () => {
      if (levelRaf) return
      levelRaf = requestAnimationFrame(() => {
        levelRaf = 0
        refreshLevel()
      })
    }
    cleanups.push(() => {
      if (levelRaf) cancelAnimationFrame(levelRaf)
    })

    // IMPORTANT: register listeners BEFORE create(). Crepe wires them during
    // create(), so registering afterwards means `markdownUpdated` never fires —
    // which left tab.content (outline, word count, dirty state, and saves!)
    // frozen at the initial value while the editor was actually edited.
    crepe.on((api) => {
      api.markdownUpdated((_ctx, md) => {
        if (ready) onChange?.(md, false)
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

        const onKeydown = (e) => {
          if (!(e.ctrlKey || e.metaKey) || e.altKey) return
          if (e.key >= '1' && e.key <= '6') {
            e.preventDefault()
            setBlock('h' + e.key)
          } else if (e.key === '0') {
            e.preventDefault()
            setBlock('paragraph')
          }
        }

        const onContextMenu = (e) => {
          e.preventDefault()
          // Move the caret to the click so the menu acts on the clicked block.
          const v = viewRef.current
          if (v) {
            const at = v.posAtCoords({ left: e.clientX, top: e.clientY })
            if (at) {
              const $pos = v.state.doc.resolve(at.pos)
              v.dispatch(v.state.tr.setSelection(TextSelection.near($pos)))
              reportActiveBlock()
            }
          }
          setCtxMenu({ x: e.clientX, y: e.clientY })
        }

        const onSelChange = () => {
          const v = viewRef.current
          if (!v || !v.hasFocus()) return
          reportActiveBlock()
          scheduleLevel()
        }

        if (view) {
          view.dom.addEventListener('keydown', onKeydown)
          view.dom.addEventListener('contextmenu', onContextMenu)
          cleanups.push(() => view.dom.removeEventListener('keydown', onKeydown))
          cleanups.push(() => view.dom.removeEventListener('contextmenu', onContextMenu))
          // Show/hide and reposition the level badge with focus and scrolling.
          const onBlur = () => setLevel(null)
          const onFocus = () => refreshLevel()
          view.dom.addEventListener('blur', onBlur)
          view.dom.addEventListener('focus', onFocus)
          cleanups.push(() => view.dom.removeEventListener('blur', onBlur))
          cleanups.push(() => view.dom.removeEventListener('focus', onFocus))
          const scrollEl = host.closest('.editor-scroll')
          if (scrollEl) {
            const onScroll = () => scheduleLevel()
            scrollEl.addEventListener('scroll', onScroll, { passive: true })
            cleanups.push(() => scrollEl.removeEventListener('scroll', onScroll))
          }
        }
        document.addEventListener('selectionchange', onSelChange)
        cleanups.push(() => document.removeEventListener('selectionchange', onSelChange))

        // --- Ctrl/Cmd+Click a link → open in the system browser ---
        if (view) {
        const onLinkClick = (e) => {
          if (!(e.ctrlKey || e.metaKey)) return
          const a = e.target.closest?.('a')
          const href = a?.getAttribute('href')
          if (!href) return
          if (/^(https?:|mailto:)/i.test(href)) {
            e.preventDefault()
            e.stopPropagation()
            window.api.openExternal(href)
          }
        }

        // --- Rich-text copy: inject inline styles into the HTML clipboard ---
        const onCopy = (e) => {
          const sel = window.getSelection()
          if (!sel || sel.isCollapsed || !view.dom.contains(sel.anchorNode)) return
          // Let CodeMirror code blocks handle their own copy.
          if (sel.anchorNode?.parentElement?.closest?.('.cm-editor')) return
          try {
            const frag = sel.getRangeAt(0).cloneContents()
            const wrap = document.createElement('div')
            wrap.appendChild(frag)
            inlineRichStyles(wrap)
            const plain = sel.toString()
            // If the selection produced nothing meaningful (e.g. anchored in a
            // non-editable rendered HTML block), don't hijack the copy with an
            // empty payload — let the browser's default copy run.
            if (!wrap.innerHTML.trim() && !plain) return
            e.clipboardData.setData(
              'text/html',
              `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#24292f;">${wrap.innerHTML}</div>`
            )
            e.clipboardData.setData('text/plain', plain)
            e.preventDefault()
          } catch {
            /* fall back to default copy */
          }
        }

        // --- Double-click an image → open it enlarged in a lightbox ---
        // Display-only: opens an overlay, never changes the document. We detect
        // the double-click ourselves (two clicks on the same image within 350ms)
        // instead of relying on the native `dblclick` event: the image-block
        // component re-renders when the first click selects it, so the two
        // physical clicks can land on different DOM nodes and no `dblclick`
        // fires. A single click is left untouched so Crepe's native image
        // interaction (select + caption editing) keeps working.
        let lastImgClick = { src: null, at: 0 }
        const onImgClick = (e) => {
          if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
          // Never treat clicks on the image-block's controls as image clicks:
          // the caption input, the caption/operation button, and the resize
          // handle must keep their own behavior (typing, toggling, resizing).
          if (
            e.target.closest?.(
              '.caption-input, .operation, .operation-item, .image-resize-handle, button, input, textarea'
            )
          )
            return
          // Match the image body itself — directly, or via the wrapper, so a
          // click still lands on the image even when it's selected and a
          // transparent overlay sits on top of it.
          const img = e.target.closest?.('img') || e.target.closest?.('.image-wrapper')?.querySelector?.('img')
          if (!img || !view.dom.contains(img)) return
          const src = img.currentSrc || img.getAttribute('src')
          if (!src) return
          const now = e.timeStamp || Date.now()
          if (lastImgClick.src === src && now - lastImgClick.at < 350) {
            e.preventDefault()
            setZoom(src)
            lastImgClick = { src: null, at: 0 }
          } else {
            lastImgClick = { src, at: now }
          }
        }

        // When the caption (operation) button is clicked, focus the caption
        // input the component reveals so the user can type the caption straight
        // away — otherwise focus stays in the editor and typing hits the body.
        const onCaptionBtn = (e) => {
          const op = e.target.closest?.('.milkdown-image-block .operation-item')
          if (!op) return
          const block = op.closest('.milkdown-image-block')
          let tries = 0
          const tryFocus = () => {
            if (destroyed) return
            const input = block?.querySelector('input.caption-input')
            if (input) {
              input.focus()
            } else if (tries++ < 12) {
              setTimeout(tryFocus, 30)
            }
          }
          setTimeout(tryFocus, 0)
        }

        view.dom.addEventListener('click', onLinkClick, true)
        view.dom.addEventListener('click', onImgClick, true)
        view.dom.addEventListener('click', onCaptionBtn)
        view.dom.addEventListener('copy', onCopy, true)
        cleanups.push(() => view.dom.removeEventListener('click', onLinkClick, true))
        cleanups.push(() => view.dom.removeEventListener('click', onImgClick, true))
        cleanups.push(() => view.dom.removeEventListener('click', onCaptionBtn))
        cleanups.push(() => view.dom.removeEventListener('copy', onCopy, true))

        // --- Resolve relative image paths against the file's folder ---
        const baseDir = dirOf(docPath)
        if (baseDir) {
          const fixImg = (img) => {
            if (img.dataset.hmResolved) return
            const raw = img.getAttribute('src') || ''
            if (!isRelativePath(raw)) return
            img.dataset.hmResolved = '1'
            img.setAttribute('src', resolveToFileUrl(baseDir, raw))
          }
          const scanImgs = (root) => {
            if (root.tagName === 'IMG') fixImg(root)
            else root.querySelectorAll?.('img').forEach(fixImg)
          }
          scanImgs(view.dom)
          const imgObserver = new MutationObserver((muts) => {
            for (const m of muts) {
              if (m.type === 'attributes' && m.target.tagName === 'IMG') fixImg(m.target)
              m.addedNodes?.forEach((n) => {
                if (n.nodeType === 1) scanImgs(n)
              })
            }
          })
          imgObserver.observe(view.dom, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src']
          })
          cleanups.push(() => imgObserver.disconnect())
        }

        // --- Inject a heading-level button into Crepe's selection toolbar ---
        // Crepe's toolbar (bold/italic/strike…) has no submenu support, so we
        // append our own "H" item; hovering it reveals H1…H6 / ¶.
        const HEAD_DEFS = [
          ['h1', 'H1', 'Ctrl+1'],
          ['h2', 'H2', 'Ctrl+2'],
          ['h3', 'H3', 'Ctrl+3'],
          ['h4', 'H4', 'Ctrl+4'],
          ['h5', 'H5', 'Ctrl+5'],
          ['h6', 'H6', 'Ctrl+6'],
          ['paragraph', '¶', 'Ctrl+0']
        ]
        const injectHeadingButton = (toolbar) => {
          if (toolbar.querySelector('.hm-heading-item')) return
          const divider = document.createElement('div')
          divider.className = 'divider hm-heading-divider'

          const item = document.createElement('div')
          item.className = 'toolbar-item hm-heading-item'
          item.setAttribute('role', 'button')
          item.title = tRef.current('tip.changeBlock')
          item.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v16"/><path d="M18 4v16"/><path d="M6 12h12"/></svg>'

          const pop = document.createElement('div')
          pop.className = 'hm-heading-pop'
          const inner = document.createElement('div')
          inner.className = 'hm-heading-pop-inner'
          for (const [id, label, tip] of HEAD_DEFS) {
            const b = document.createElement('button')
            b.type = 'button'
            b.textContent = label
            b.title = `${tRef.current('block.' + id)} (${tip})`
            b.addEventListener('mousedown', (e) => {
              e.preventDefault()
              e.stopPropagation()
            })
            b.addEventListener('click', (e) => {
              e.preventDefault()
              e.stopPropagation()
              // Act on the editor that owns this toolbar's selection — the
              // focused one — not whichever instance injected the button.
              const target =
                [...liveEditors].find((ed) => ed.getView()?.hasFocus()) ||
                [...liveEditors].find((ed) => ed.host.contains(toolbar)) ||
                self
              target.getApi()?.setBlock(id)
            })
            inner.appendChild(b)
          }
          pop.appendChild(inner)
          item.appendChild(pop)
          item.addEventListener('mousedown', (e) => e.preventDefault()) // keep selection
          toolbar.appendChild(divider)
          toolbar.appendChild(item)
        }

        // Inject synchronously (no requestAnimationFrame — it's throttled when
        // the window is occluded, which would skip injection). The scan is cheap
        // and injectHeadingButton early-returns once the button is present.
        // Scan globally because Crepe may render its toolbar outside `host`; the
        // button routes its click to the focused editor (see the click handler),
        // so it doesn't matter which instance injected it.
        // Crepe's toolbar buttons carry no label/identifier in the DOM, so we
        // add tooltips by their fixed order: bold, italic, strikethrough, inline
        // code, link. (Our injected heading button is excluded and titled above.)
        const addToolbarTitles = (toolbar) => {
          const tips = [
            tRef.current('tb.bold'),
            tRef.current('tb.italic'),
            tRef.current('tb.strike'),
            tRef.current('tb.code'),
            tRef.current('tb.link')
          ]
          toolbar
            .querySelectorAll('.toolbar-item:not(.hm-heading-item)')
            .forEach((btn, i) => {
              if (tips[i] && btn.title !== tips[i]) btn.title = tips[i]
            })
        }
        const scanToolbars = () => {
          document.querySelectorAll('.milkdown-toolbar').forEach((tb) => {
            injectHeadingButton(tb)
            addToolbarTitles(tb)
          })
        }
        scanToolbars()
        // The toolbar is created on selection, so we only need to re-scan when
        // nodes are actually added — not on every edit. Skip mutation batches
        // with no added nodes, and coalesce the rest into one scan per frame, so
        // typing in a large document doesn't trigger a document-wide query each
        // keystroke (one observer per mounted editor made this add up).
        let scanRaf = 0
        const scheduleScan = () => {
          if (scanRaf) return
          scanRaf = requestAnimationFrame(() => {
            scanRaf = 0
            scanToolbars()
          })
        }
        const toolbarObserver = new MutationObserver((muts) => {
          for (const m of muts) {
            if (m.addedNodes && m.addedNodes.length) {
              scheduleScan()
              return
            }
          }
        })
        toolbarObserver.observe(document.body, { childList: true, subtree: true })
        cleanups.push(() => {
          if (scanRaf) cancelAnimationFrame(scanRaf)
          toolbarObserver.disconnect()
        })
        }

        // NOTE: a brand-new document is left as a normal paragraph (not forced
        // to Heading 1). Forcing H1 meant the first line was always a title, so
        // you couldn't just start writing body text — you had to type a title
        // and press Enter first. A plain paragraph lets you type body straight
        // away, and you can still make a heading with `#`/Ctrl+1/the toolbar.

        const md = crepe.getMarkdown()
        onChange?.(md, true)
        ready = true
        setLoaded(true)
        reportActiveBlock()
        // Produce a clean, inline-styled HTML snapshot of the whole document
        // for PDF export (reuses the rich-copy styling; flattens CodeMirror code
        // blocks to plain <pre><code> so they render predictably).
        const getDocHTML = () => {
          const v = viewRef.current
          if (!v) return ''
          const clone = v.dom.cloneNode(true)
          // Drop editor-only widgets so they don't end up in the PDF: code-block
          // toolbar (language picker + Copy), table handles/add/align/delete
          // buttons, block/drag handles, image resize handles, and the custom
          // list-item bullet labels (native list markers render instead).
          clone
            .querySelectorAll(
              'button, select, .language-picker, .language-list, .tools, ' +
                '.tools-button-group, .button-group, .cm-panel, .cm-tooltip, ' +
                '.preview-panel, .cell-handle, .line-handle, .handle, .add-button, ' +
                '.operation, .operation-item, .drag-preview, .milkdown-block-handle, ' +
                '.milkdown-toolbar, .image-resize-handle, .label-wrapper'
            )
            .forEach((el) => el.remove())
          // Flatten CodeMirror editors to plain <pre><code>.
          clone.querySelectorAll('.cm-editor').forEach((cm) => {
            const lines = [...cm.querySelectorAll('.cm-line')].map((l) => l.textContent)
            const pre = document.createElement('pre')
            const code = document.createElement('code')
            code.textContent = (lines.length ? lines.join('\n') : cm.textContent).replace(/\n+$/, '')
            pre.appendChild(code)
            cm.replaceWith(pre)
          })
          // Strip editor-only attributes but keep semantic tags + src/href/alt,
          // so the print stylesheet (in the main process) fully controls the look.
          clone.querySelectorAll('*').forEach((el) => {
            el.removeAttribute('class')
            el.removeAttribute('style')
            el.removeAttribute('contenteditable')
            ;[...el.attributes].forEach((a) => {
              if (a.name.startsWith('data-') || a.name.startsWith('aria-')) el.removeAttribute(a.name)
            })
          })
          return clone.innerHTML
        }
        apiRef.current = { setBlock, getDocHTML }
        onReady?.({ setBlock, getView: () => viewRef.current, getDocHTML })
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

  // Close the image lightbox on Escape.
  useEffect(() => {
    if (!zoom) return
    const onKey = (e) => {
      if (e.key === 'Escape') setZoom(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])

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

      {level && (
        <div
          className={`hm-level-badge hm-level-${level.kind} align-${level.align}`}
          style={{ top: level.top, left: level.x }}
          aria-hidden="true"
        >
          {level.label}
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
                <span className="block-menu-sc">{b.shortcut}</span>
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
          <img src={zoom} alt="" />
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

// ----------------------------- raw HTML rendering -----------------------------

// Block-level tags whose HTML we render visually (rather than show as source).
// Targeted at the common case — HTML tables pasted into Markdown — plus a few
// other safe block containers. Inline fragments (a stray <b>, <span>) fall back
// to the default escaped-text rendering so unbalanced bits can't break layout.
const RENDER_HTML_RE =
  /^\s*<(table|thead|tbody|tfoot|tr|td|th|div|details|summary|figure|figcaption|section|article|dl|center|sub|sup|kbd|mark|abbr|u|ins|del)[\s/>]/i

// Strip <script>/<style> and inline event handlers so rendering local HTML can't
// run code. Tables/fragments parse correctly inside a <template>.
function sanitizeHtml(html) {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  tpl.content.querySelectorAll('script, style').forEach((el) => el.remove())
  tpl.content.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
      else if (/^(href|src)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name)
      }
    }
  })
  return tpl.innerHTML
}

// ProseMirror node view for Milkdown's `html` node. Renders recognized block
// HTML as real DOM; leaves other html nodes to their default text rendering.
function renderHtmlNodeView(node) {
  const value = node.attrs?.value || ''
  if (!RENDER_HTML_RE.test(value)) {
    // Not something we render — mimic the default: escaped text in a span.
    const span = document.createElement('span')
    span.setAttribute('data-type', 'html')
    span.textContent = value
    return { dom: span, ignoreMutation: () => true }
  }
  const dom = document.createElement('div')
  dom.className = 'hm-html-block'
  dom.setAttribute('data-type', 'html')
  dom.contentEditable = 'false'
  dom.innerHTML = sanitizeHtml(value)
  // The node is an atom with no editable content; ignore inner DOM mutations so
  // ProseMirror doesn't try to reconcile the rendered HTML.
  return { dom, ignoreMutation: () => true, stopEvent: () => false }
}

// Convert the block containing the cursor to a different type. Operates on the
// textblock the selection actually sits in and commits through the view so
// ProseMirror's state stays in sync.
function convertBlock(view, typeName, attrs = {}) {
  const { state } = view
  const { schema, selection } = state
  const { $from } = selection

  const targetType = schema.nodes[typeName]
  if (!targetType) return

  let depth = $from.depth
  while (depth > 0 && !$from.node(depth).isTextblock) depth--
  const node = depth >= 0 ? $from.node(depth) : null
  if (!node) return

  // No-op if it's already exactly what we'd convert to.
  if (node.type.name === typeName) {
    if (typeName === 'heading' && node.attrs.level === attrs.level) return
    if (typeName === 'paragraph') return
  }

  const pos = $from.before(depth)
  view.dispatch(state.tr.setNodeMarkup(pos, targetType, attrs))
}

// ----------------------------- image paths -----------------------------

function dirOf(path) {
  if (!path) return null
  const norm = path.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? norm.slice(0, i) : null
}

// A src is "relative" if it has no scheme (http:, data:, file:…), is not a
// protocol-relative URL, and is not an absolute filesystem path.
function isRelativePath(src) {
  if (!src) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return false // http:, data:, file:, C: …
  if (src.startsWith('//')) return false
  if (src.startsWith('/')) return false
  return true
}

function resolveToFileUrl(baseDir, src) {
  const base = baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const isWin = /^[a-zA-Z]:/.test(base)
  const segs = base.split('/')
  for (const part of src.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segs.pop()
    else segs.push(part)
  }
  const joined = segs.join('/')
  const url = isWin ? 'file:///' + joined : 'file://' + (joined.startsWith('/') ? joined : '/' + joined)
  return encodeURI(url)
}

// ----------------------------- rich-text copy -----------------------------

// Curated light-theme styles so pasted content keeps its formatting in apps
// that ignore external CSS (WeChat, email, Notion…).
const COPY_STYLES = {
  H1: 'font-size:1.8em;font-weight:700;line-height:1.3;margin:0.6em 0 0.4em;',
  H2: 'font-size:1.5em;font-weight:700;line-height:1.3;margin:0.6em 0 0.4em;',
  H3: 'font-size:1.3em;font-weight:600;line-height:1.3;margin:0.6em 0 0.4em;',
  H4: 'font-size:1.1em;font-weight:600;margin:0.6em 0 0.3em;',
  H5: 'font-size:1em;font-weight:600;margin:0.6em 0 0.3em;',
  H6: 'font-size:1em;font-weight:600;color:#57606a;margin:0.6em 0 0.3em;',
  P: 'margin:0.6em 0;line-height:1.7;',
  STRONG: 'font-weight:700;',
  B: 'font-weight:700;',
  EM: 'font-style:italic;',
  I: 'font-style:italic;',
  A: 'color:#0969da;text-decoration:underline;',
  BLOCKQUOTE: 'border-left:4px solid #d0d7de;padding-left:14px;color:#57606a;margin:0.6em 0;',
  PRE: 'background:#f6f8fa;padding:14px 16px;border-radius:8px;overflow:auto;font-family:Consolas,Monaco,monospace;font-size:0.9em;line-height:1.5;margin:0.6em 0;',
  UL: 'padding-left:1.6em;margin:0.6em 0;',
  OL: 'padding-left:1.6em;margin:0.6em 0;',
  LI: 'margin:0.3em 0;line-height:1.7;',
  TABLE: 'border-collapse:collapse;margin:0.6em 0;',
  TH: 'border:1px solid #d0d7de;padding:6px 12px;background:#f6f8fa;font-weight:700;text-align:left;',
  TD: 'border:1px solid #d0d7de;padding:6px 12px;',
  HR: 'border:none;border-top:1px solid #d0d7de;margin:1em 0;',
  IMG: 'max-width:100%;'
}

function inlineRichStyles(root) {
  root.querySelectorAll('*').forEach((el) => {
    // strip editor-only attributes
    el.removeAttribute('class')
    el.removeAttribute('contenteditable')
    el.removeAttribute('data-hm-resolved')

    const tag = el.tagName
    if (tag === 'CODE') {
      // Inline code vs. code inside a <pre> block.
      if (el.closest('pre')) {
        el.setAttribute('style', 'background:none;padding:0;color:inherit;font-family:inherit;')
      } else {
        el.setAttribute(
          'style',
          'background:#f2f2f2;color:#c0341d;padding:2px 5px;border-radius:4px;font-family:Consolas,Monaco,monospace;font-size:0.9em;'
        )
      }
      return
    }
    const style = COPY_STYLES[tag]
    if (style) el.setAttribute('style', style)
  })
}
