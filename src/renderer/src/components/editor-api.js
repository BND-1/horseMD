import { TextSelection, NodeSelection } from '@milkdown/prose/state'
import { commandsCtx, remarkCtx } from '@milkdown/kit/core'
import { replaceAll } from '@milkdown/utils'
import { applyReviewMarkupInView } from './editor-review.js'
import { normalizeReviewMarkupMarkdown } from '../reviewMarkup.js'
import { normalizeDisplayMath } from './editor-math.js'
import { markdownOffsetToPmPos, pmPosToMarkdownOffset } from './editor-source-map.js'
import { toggleHighlightCommand } from './editor-highlight.js'
import { codeMirrorSelectionInfo } from './editor-codemirror-selection.js'

const stripEditorOnlyForExport = (clone) => {
  clone
    .querySelectorAll(
      'button, select, .language-picker, .language-list, .tools, ' +
        '.tools-button-group, .button-group, .cm-panel, .cm-tooltip, ' +
        '.preview-panel, .cell-handle, .line-handle, .handle, .add-button, ' +
        '.operation, .operation-item, .drag-preview, .milkdown-block-handle, ' +
        '.milkdown-toolbar, .image-resize-handle, .label-wrapper, .hm-frontmatter-wrap, ' +
        '.hm-review-widget, .hm-review-card'
    )
    .forEach((el) => el.remove())
}

const flattenCodeMirrorBlocks = (clone) => {
  const doc = clone.ownerDocument
  clone.querySelectorAll('.cm-editor').forEach((cm) => {
    const lines = [...cm.querySelectorAll('.cm-line')].map((l) => l.textContent)
    const pre = doc.createElement('pre')
    const code = doc.createElement('code')
    code.textContent = (lines.length ? lines.join('\n') : cm.textContent).replace(/\n+$/, '')
    pre.appendChild(code)
    cm.replaceWith(pre)
  })
}

const stripEditorAttributes = (clone) => {
  clone.querySelectorAll('*').forEach((el) => {
    el.removeAttribute('class')
    el.removeAttribute('style')
    el.removeAttribute('contenteditable')
    ;[...el.attributes].forEach((a) => {
      if (a.name.startsWith('data-') || a.name.startsWith('aria-')) el.removeAttribute(a.name)
    })
  })
}

export function createEditorApi({
  viewRef,
  crepe,
  crepeRef,
  lastMarkdownRef,
  setBlock,
  onStructureChange,
  isDestroyed,
  getT,
  notify
}) {
  const getPdfSource = () => {
    const v = viewRef.current
    if (!v) return null
    const clone = v.dom.cloneNode(true)
    stripEditorOnlyForExport(clone)
    flattenCodeMirrorBlocks(clone)
    stripEditorAttributes(clone)
    const headings = [...clone.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading, index) => {
      const id = `hm-pdf-heading-${index + 1}`
      heading.id = id
      return {
        id,
        level: Number(heading.tagName.slice(1)),
        text: heading.textContent?.trim() || ''
      }
    })
    return { html: clone.innerHTML, headings }
  }

  const getMarkdown = () => {
    try {
      return crepe.getMarkdown()
    } catch {
      return ''
    }
  }

  const toggleHighlight = () => {
    try {
      crepe.editor.ctx.get(commandsCtx).call(toggleHighlightCommand.key)
    } catch {
      /* editor tearing down */
    }
  }

  const applyReviewMarkup = (kind) => {
    const result = applyReviewMarkupInView(viewRef.current, kind)
    if (!result.ok && result.reason === 'multiline') {
      notify?.(getT('review.inlineOnly'))
    }
    return result.ok
  }

  const replaceMarkdown = (md) => {
    if (isDestroyed?.() || !crepeRef.current) return false
    try {
      const next = normalizeReviewMarkupMarkdown(normalizeDisplayMath(md || ''))
      lastMarkdownRef.current = next
      crepe.editor.action(replaceAll(next))
      onStructureChange?.()
      return true
    } catch (err) {
      console.error('Replace markdown failed', err)
      return false
    }
  }

  const restoreMarkdownOffset = (rawOffset, follow = false) => {
    const v = viewRef.current
    if (!v || !crepeRef.current) return false
    try {
      const remark = crepe.editor.ctx.get(remarkCtx)
      const target = markdownOffsetToPmPos(lastMarkdownRef.current || '', rawOffset, v.state.doc, remark)
      const pos = typeof target === 'number' ? target : target?.pos
      if (!Number.isFinite(pos)) return false
      const size = v.state.doc.content.size
      const safePos = Math.max(1, Math.min(pos, size))
      const $pos = v.state.doc.resolve(safePos)
      const inCodeBlock = /code/i.test($pos.parent.type.name)
      let selection
      if (target?.atom) {
        try {
          selection = NodeSelection.create(v.state.doc, Math.max(0, Math.min(pos, size - 1)))
        } catch {
          selection = TextSelection.near($pos, 1)
        }
      } else {
        selection = TextSelection.near($pos)
      }
      const tr = v.state.tr.setSelection(selection)
      if (follow) tr.scrollIntoView()
      // A CodeMirror node view only forwards ProseMirror's selection while the
      // outer editor owns focus. Focusing after dispatch would steal focus back
      // and leave the inner caret outside the visible scroller.
      if (follow && inCodeBlock) v.focus()
      v.dispatch(tr)
      if (follow && inCodeBlock) {
        try {
          const scroller = v.dom.closest('.editor-scroll')
          const sr = scroller?.getBoundingClientRect()
          const domSelection = v.dom.ownerDocument.getSelection()
          const domRange = domSelection?.rangeCount ? domSelection.getRangeAt(0) : null
          const coords = domRange?.getBoundingClientRect()
          if (scroller && sr && coords && (coords.top < sr.top + 12 || coords.bottom > sr.bottom - 12)) {
            scroller.scrollTop += (coords.top + coords.bottom) / 2 - (sr.top + sr.bottom) / 2
          }
        } catch {
          // The repeated layout restore in App retries after CodeMirror paints.
        }
      } else if (follow) {
        v.focus()
      }
      return true
    } catch {
      return false
    }
  }

  const markdownOffsetFromSelection = () => {
    const v = viewRef.current
    if (!v || !crepeRef.current) return null
    try {
      let head = v.state.selection.head
      const sel = v.dom.ownerDocument.getSelection()
      if (sel && sel.rangeCount && sel.isCollapsed && v.dom.contains(sel.anchorNode)) {
        head = codeMirrorSelectionInfo(v, sel)?.pmPos ?? v.posAtDOM(sel.anchorNode, sel.anchorOffset)
      }
      const remark = crepe.editor.ctx.get(remarkCtx)
      return pmPosToMarkdownOffset(lastMarkdownRef.current || '', head, v.state.doc, remark)
    } catch {
      return null
    }
  }

  const markdownOffsetFromViewportTop = () => {
    const v = viewRef.current
    if (!v || !crepeRef.current) return null
    try {
      const scroller = v.dom.closest('.editor-scroll')
      if (!scroller) return null
      const rect = scroller.getBoundingClientRect()
      const doc = v.dom.ownerDocument
      const point = doc.caretPositionFromPoint?.(rect.left + rect.width / 2, rect.top + 8)
      if (!point || !v.dom.contains(point.offsetNode)) return null
      const pos = v.posAtDOM(point.offsetNode, point.offset)
      const remark = crepe.editor.ctx.get(remarkCtx)
      return pmPosToMarkdownOffset(lastMarkdownRef.current || '', pos, v.state.doc, remark)
    } catch {
      return null
    }
  }

  return {
    setBlock,
    getPdfSource,
    getMarkdown,
    toggleHighlight,
    applyReviewMarkup,
    replaceMarkdown,
    restoreMarkdownOffset,
    markdownOffsetFromSelection,
    markdownOffsetFromViewportTop
  }
}
