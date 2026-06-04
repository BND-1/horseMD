import { useEffect, useRef, useState } from 'react'
import { Crepe, CrepeFeature } from '@milkdown/crepe'
import { editorViewCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/prose/state'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import '@milkdown/crepe/theme/common/link-tooltip.css'
import { BLOCK_TYPES, blockById, currentBlockId } from '../blocks.js'
import { useI18n } from '../i18n.jsx'

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
  const lastBlockRef = useRef(null)
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y } viewport coords, or null

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let ready = false
    let destroyed = false
    const cleanups = []

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

    // Convert the block the cursor sits in to a given block id (paragraph/h1…h6).
    const setBlock = (id) => {
      const view = viewRef.current
      if (!view) return
      const def = blockById(id)
      if (!def) return
      convertBlock(view, def.name, def.level ? { level: def.level } : {})
      view.focus()
      reportActiveBlock()
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

    // IMPORTANT: register listeners BEFORE create(). Crepe wires them during
    // create(), so registering afterwards means `markdownUpdated` never fires —
    // which left tab.content (outline, word count, dirty state, and saves!)
    // frozen at the initial value while the editor was actually edited.
    crepe.on((api) => {
      api.markdownUpdated((_ctx, md) => {
        if (ready) onChange?.(md, false)
      })
    })

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
          if (!v) return
          if (v.hasFocus()) reportActiveBlock()
        }

        if (view) {
          view.dom.addEventListener('keydown', onKeydown)
          view.dom.addEventListener('contextmenu', onContextMenu)
          cleanups.push(() => view.dom.removeEventListener('keydown', onKeydown))
          cleanups.push(() => view.dom.removeEventListener('contextmenu', onContextMenu))
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
            e.clipboardData.setData(
              'text/html',
              `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#24292f;">${wrap.innerHTML}</div>`
            )
            e.clipboardData.setData('text/plain', sel.toString())
            e.preventDefault()
          } catch {
            /* fall back to default copy */
          }
        }

        view.dom.addEventListener('click', onLinkClick, true)
        view.dom.addEventListener('copy', onCopy, true)
        cleanups.push(() => view.dom.removeEventListener('click', onLinkClick, true))
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
        // append our own "H" item; hovering it reveals H1 / H2 / H3 / ¶.
        const HEAD_DEFS = [
          ['h1', 'H1', 'Ctrl+1'],
          ['h2', 'H2', 'Ctrl+2'],
          ['h3', 'H3', 'Ctrl+3'],
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
              apiRef.current?.setBlock(id)
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
        const scanToolbars = () => {
          document.querySelectorAll('.milkdown-toolbar').forEach(injectHeadingButton)
        }
        scanToolbars()
        const toolbarObserver = new MutationObserver(scanToolbars)
        toolbarObserver.observe(document.body, { childList: true, subtree: true })
        cleanups.push(() => toolbarObserver.disconnect())
        }

        // Typora-style title: a brand-new / empty document starts its first
        // line as a Heading 1. Done before the baseline below so the new tab
        // isn't marked dirty.
        if (view) {
          const doc = view.state.doc
          const first = doc.firstChild
          const headingType = view.state.schema.nodes.heading
          if (
            headingType &&
            doc.childCount === 1 &&
            first &&
            first.type.name === 'paragraph' &&
            first.content.size === 0
          ) {
            view.dispatch(view.state.tr.setNodeMarkup(0, headingType, { level: 1 }))
          }
        }

        const md = crepe.getMarkdown()
        onChange?.(md, true)
        ready = true
        reportActiveBlock()
        apiRef.current = { setBlock }
        onReady?.({ setBlock, getView: () => viewRef.current })
      })
      .catch((err) => console.error('Crepe init failed', err))

    return () => {
      destroyed = true
      cleanups.forEach((fn) => {
        try {
          fn()
        } catch {
          /* ignore */
        }
      })
      viewRef.current = null
      try {
        crepe.destroy()
      } catch {
        /* ignore */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The floating bar and context menu reuse the same conversion path as the
  // keyboard shortcuts (defined inside the effect, reached through apiRef).
  const pickBlock = (id) => apiRef.current?.setBlock(id)

  return (
    <>
      <div className="editor-host" ref={hostRef} />

      {ctxMenu && (
        <>
          <div className="menu-backdrop" onMouseDown={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }} />
          <div className="block-ctxmenu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
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
    </>
  )
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
