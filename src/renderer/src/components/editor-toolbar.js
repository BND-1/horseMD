// Crepe selection-toolbar injection: a heading picker, a highlight color
// picker, a review-markup picker, plus tooltips for Crepe's own
// (bold/italic/strike/code/link) buttons. Extracted verbatim in behavior from
// Editor.jsx.
//
// Crepe's toolbar (bold/italic/strike…) has no submenu support, so we append our
// own items. Two shared helpers keep the three injections from drifting apart:
//   - editorForToolbar: the editor that owns a toolbar's selection (the focused
//     one), regardless of which instance injected the button;
//   - appendToolbarItem: the divider + button scaffolding all three share.
//
// The scan is global (Crepe may render its toolbar outside the editor host);
// each injected button routes its click to the focused editor via
// editorForToolbar, so it doesn't matter which instance injected it.
import { HIGHLIGHT_COLORS, applyHighlightInView } from './editor-highlight.js'
import { REVIEW_KINDS } from './editor-review.js'
import { labelWithShortcut } from '../lib/commands/shortcut-labels.js'

//   liveEditors          — module-level Set of mounted editors (Editor.jsx owns it)
//   self                 — this editor's { host, getView, getApi } (fallback owner)
//   t                    — (key) => localized string (tRef.current in Editor.jsx)
//   updateHighlightActive — reflect highlight-active state onto the swatches
// Returns { scanToolbars, cleanup }: call scanToolbars() once on mount, push
// cleanup() to the editor's cleanups so the MutationObserver + rAF are torn down.
export function createToolbarScanner({ liveEditors, self, t, getKeybindings, updateHighlightActive }) {
  const editorForToolbar = (toolbar) =>
    [...liveEditors].find((ed) => ed.getView()?.hasFocus()) ||
    [...liveEditors].find((ed) => ed.host.contains(toolbar)) ||
    self

  const appendToolbarItem = (toolbar, itemClass, title, svg) => {
    if (toolbar.querySelector('.' + itemClass)) return null
    const divider = document.createElement('div')
    divider.className = 'divider hm-heading-divider'
    const item = document.createElement('div')
    item.className = 'toolbar-item ' + itemClass
    item.setAttribute('role', 'button')
    item.tabIndex = 0
    item.title = title
    item.innerHTML = svg
    // Keep the selection alive while clicking the button / opening its popover.
    item.addEventListener('mousedown', (e) => e.preventDefault())
    toolbar.appendChild(divider)
    toolbar.appendChild(item)
    return item
  }

  // Heading picker: hover reveals H1…H6 / ¶.
  const HEAD_DEFS = [
    ['h1', 'H1', 'editor.block.h1'],
    ['h2', 'H2', 'editor.block.h2'],
    ['h3', 'H3', 'editor.block.h3'],
    ['h4', 'H4', 'editor.block.h4'],
    ['h5', 'H5', 'editor.block.h5'],
    ['h6', 'H6', 'editor.block.h6'],
    ['paragraph', '¶', 'editor.block.paragraph']
  ]
  const injectHeadingButton = (toolbar) => {
    const item = appendToolbarItem(
      toolbar,
      'hm-heading-item',
      t('tip.changeBlock'),
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v16"/><path d="M18 4v16"/><path d="M6 12h12"/></svg>'
    )
    if (!item) return
    const pop = document.createElement('div')
    pop.className = 'hm-heading-pop'
    const inner = document.createElement('div')
    inner.className = 'hm-heading-pop-inner'
    for (const [id, label, commandId] of HEAD_DEFS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.title = labelWithShortcut(t('block.' + id), commandId, getKeybindings?.())
      b.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      b.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        editorForToolbar(toolbar).getApi()?.setBlock(id)
      })
      inner.appendChild(b)
    }
    pop.appendChild(inner)
    item.appendChild(pop)
  }

  // Highlight color picker (issue #14): hover reveals yellow/red/blue.
  const injectHighlightButton = (toolbar) => {
    const item = appendToolbarItem(
      toolbar,
      'hm-highlight-item',
      labelWithShortcut(t('tb.highlight'), 'editor.highlight', getKeybindings?.()),
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l-1 4 4-1L19 8l-3-3z"/><path d="M14 5l3 3"/><rect x="3" y="20" width="18" height="2" rx="1" fill="currentColor" stroke="none"/></svg>'
    )
    if (!item) return
    const pop = document.createElement('div')
    pop.className = 'hm-highlight-pop'
    const inner = document.createElement('div')
    inner.className = 'hm-highlight-pop-inner'
    for (const color of HIGHLIGHT_COLORS) {
      const sw = document.createElement('button')
      sw.type = 'button'
      sw.className = 'hm-hl-swatch hm-hl-' + color
      sw.title = t('tb.highlightColor.' + color)
      sw.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      sw.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const v = editorForToolbar(toolbar)?.getView?.()
        if (v) applyHighlightInView(v, color)
      })
      inner.appendChild(sw)
    }
    pop.appendChild(inner)
    item.appendChild(pop)
  }

  const reviewLabel = (key, fallback) => {
    const value = t(key)
    return !value || value === key ? fallback : value
  }
  const REVIEW_ACTIONS = [
    [REVIEW_KINDS.addition, 'review.add', 'Addition'],
    [REVIEW_KINDS.deletion, 'review.delete', 'Deletion'],
    [REVIEW_KINDS.substitution, 'review.substitute', 'Substitution'],
    [REVIEW_KINDS.highlight, 'review.highlight', 'Highlight + comment']
  ]
  const injectReviewButton = (toolbar) => {
    const item = appendToolbarItem(
      toolbar,
      'hm-review-item',
      reviewLabel('review.toolbar', 'Review markup'),
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h10"/><path d="M4 12h9"/><path d="M4 18h7"/><path d="M17 9l3 3-3 3"/><path d="M14 12h6"/></svg>'
    )
    if (!item) return
    const pop = document.createElement('div')
    pop.className = 'hm-review-pop'
    const inner = document.createElement('div')
    inner.className = 'hm-review-pop-inner'
    for (const [kind, labelKey, fallback] of REVIEW_ACTIONS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'hm-review-action hm-review-action-' + kind
      b.textContent = reviewLabel(labelKey, fallback)
      b.title = b.textContent
      b.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      b.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        editorForToolbar(toolbar).getApi()?.applyReviewMarkup(kind)
      })
      inner.appendChild(b)
    }
    pop.appendChild(inner)
    item.appendChild(pop)
  }

  // Inject synchronously (no requestAnimationFrame — it's throttled when the
  // window is occluded, which would skip injection). The scan is cheap and each
  // injector early-returns once its button is present.
  // Crepe's toolbar buttons carry no label/identifier in the DOM, so we add
  // tooltips by their fixed order: bold, italic, strikethrough, inline code,
  // link. Our injected items are excluded (titled above).
  const addToolbarTitles = (toolbar) => {
    const tips = [
      labelWithShortcut(t('tb.bold'), 'editor.bold', getKeybindings?.()),
      labelWithShortcut(t('tb.italic'), 'editor.italic', getKeybindings?.()),
      t('tb.strike'),
      t('tb.code'),
      t('tb.link')
    ]
    toolbar
      .querySelectorAll(
        '.toolbar-item:not(.hm-heading-item):not(.hm-highlight-item):not(.hm-review-item)'
      )
      .forEach((btn, i) => {
        if (tips[i] && btn.title !== tips[i]) btn.title = tips[i]
      })
  }
  const scanToolbars = () => {
    document.querySelectorAll('.milkdown-toolbar').forEach((tb) => {
      injectHeadingButton(tb)
      injectHighlightButton(tb)
      injectReviewButton(tb)
      addToolbarTitles(tb)
    })
    updateHighlightActive()
  }

  // The toolbar is created on selection, so we only need to re-scan when nodes
  // are actually added — not on every edit. Coalesce the rest into one scan per
  // frame, so typing in a large document doesn't trigger a document-wide query
  // each keystroke (one observer per mounted editor made this add up).
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

  const cleanup = () => {
    if (scanRaf) cancelAnimationFrame(scanRaf)
    toolbarObserver.disconnect()
  }
  return { scanToolbars, cleanup }
}
