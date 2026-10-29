import { parserCtx, serializerCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/prose/state'
import { Slice } from '@milkdown/prose/model'
import { copyToClipboard } from '../ui.js'
import { dirOf, isRelativePath, resolveToFileUrl } from './editor-images.js'
import { resolveLocalLinkToFileUrl } from './editor-local-links.js'
import {
  cloneSelectedCells,
  copiedMarkdownContent,
  copiedPlainText,
  inlineRichStyles,
  materializeCopiedSoftBreaks
} from './editor-copy.js'
import { attachMdPasteHandler } from './editor-md-paste.js'
import { attachPlainTextDropHandler } from './editor-drop-text.js'
import { hasStructuredWebHtml } from './editor-web-paste.js'
import { foldedSelectionRange } from './editor-heading-fold.js'

export function mountEditorContentBindings({
  view,
  docPath,
  crepe,
  cleanups,
  markUserEdit,
  insertUploadedImage,
  prepareRawMarkdownPaste,
  setZoom,
  getT,
  isReadOnly,
  isDestroyed
}) {
  const onLinkClick = (event) => {
    // Editing needs Ctrl/Cmd (a plain click places the caret in the link
    // text). A read-only document has no caret, so a plain click opens the
    // link — unless the click ended a text selection (#163: select to copy).
    const anchor = event.target.closest?.('a')
    const href = anchor?.getAttribute('href')
    if (!href) return
    if (!(event.ctrlKey || event.metaKey)) {
      if (!isReadOnly?.()) return
      // A non-editable page follows <a href> itself; never let it navigate.
      event.preventDefault()
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed) return
    }
    if (/^(https?:|mailto:)/i.test(href)) {
      event.preventDefault()
      event.stopPropagation()
      window.api.openExternal(href)
      return
    }
    const fileUrl = resolveLocalLinkToFileUrl(href, docPath)
    if (fileUrl && window.api.openFileUrl) {
      event.preventDefault()
      event.stopPropagation()
      window.api.openFileUrl(fileUrl)
    }
  }

  // A selection covering a folded heading copies its folded section too
  // (`foldedSelectionRange`). The hidden blocks are display:none (CodeMirror
  // renders no lines there), so that copy is built from the document, not
  // from the DOM selection.
  const fillClipboard = (event, folded) => {
    const selection = window.getSelection()
    const selectedCells = !folded && view.hasFocus() ? cloneSelectedCells(view) : null
    if (!selectedCells && !folded) {
      if (!selection || selection.isCollapsed || !view.dom.contains(selection.anchorNode)) return false
      if (selection.anchorNode?.parentElement?.closest?.('.cm-editor')) return false
    }
    try {
      const wrapper = document.createElement('div')
      const foldedSlice = folded ? view.state.doc.slice(folded.from, folded.to) : null
      wrapper.appendChild(foldedSlice
        ? view.serializeForClipboard(foldedSlice).dom
        : selectedCells || selection.getRangeAt(0).cloneContents())
      materializeCopiedSoftBreaks(wrapper)
      // A mid-list selection clones <li> without its list wrapper. Whether the
      // items were ordered is only visible in the LIVE dom — inspect it before
      // styling so the re-wrapped clipboard fragment keeps its numbering.
      const selectionOrderedLists = Boolean(
        selection?.anchorNode?.parentElement?.closest('ol') ||
        selection?.focusNode?.parentElement?.closest('ol')
      )
      inlineRichStyles(wrapper, { selectionOrderedLists })
      // Plain text must be derived AFTER the clipboard transform: Milkdown's
      // in-item marker span ("1.") becomes its own line in the raw clone, so
      // text-only paste targets showed the number split from its text.
      const plain = foldedSlice
        ? copiedPlainText(wrapper, foldedSlice.content.textBetween(0, foldedSlice.content.size, '\n\n'), { layout: true })
        : copiedPlainText(wrapper, selection?.toString() || '')
      let serialized = ''
      if (!view.state.selection.empty) {
        try {
          const content = foldedSlice ? foldedSlice.content : copiedMarkdownContent(view.state.selection)
          const doc = view.state.schema.topNodeType.createAndFill(undefined, content)
          if (doc) serialized = crepe.editor.ctx.get(serializerCtx)(doc)
        } catch {}
      }
      if (!wrapper.innerHTML.trim() && !plain) return false
      event.clipboardData.setData(
        'text/html',
        `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#24292f;">${wrapper.innerHTML}</div>`
      )
      event.clipboardData.setData('text/plain', plain)
      if (typeof serialized === 'string' && serialized) {
        event.clipboardData.setData('text/markdown', serialized)
      }
      event.preventDefault()
      return true
    } catch {
      // Fall back to the browser's default copy behavior.
      return false
    }
  }
  const onCopy = (event) => {
    fillClipboard(event, view.hasFocus() || view.dom.contains(window.getSelection()?.anchorNode) ? foldedSelectionRange(view.state) : null)
  }
  // Cut of a folded heading takes its section with it (ProseMirror's own cut
  // would remove the heading alone and leave the content to the heading
  // before). Read-only views never get here (capture-phase block).
  const onCut = (event) => {
    if (!view.editable) return
    const folded = foldedSelectionRange(view.state)
    if (!folded || !fillClipboard(event, folded)) return
    event.stopPropagation()
    markUserEdit?.()
    const tr = view.state.tr.delete(folded.from, folded.to)
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(folded.from, tr.doc.content.size))))
    view.dispatch(tr.scrollIntoView().setMeta('uiEvent', 'cut'))
  }

  const imageHandlingActive = (event) =>
    !event.target.closest?.('.cm-editor, input, textarea, .caption-input')
  const onPasteImage = (event) => {
    if (!imageHandlingActive(event)) return
    // A rich web selection may expose an image file in addition to HTML. Do not
    // let the single-image path consume the entire article.
    if (hasStructuredWebHtml(event.clipboardData?.getData('text/html') || '')) return
    const items = event.clipboardData?.items
    if (!items) return
    const imageItem = [...items].find((item) => item.kind === 'file' && item.type.startsWith('image/'))
    const file = imageItem?.getAsFile()
    if (!file) return
    event.preventDefault()
    event.stopImmediatePropagation()
    insertUploadedImage(file, true)
  }
  const onDropImage = (event) => {
    if (!imageHandlingActive(event)) return
    if (insertDroppedMedia(event)) return
    const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type.startsWith('image/'))
    if (!files.length) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
    if (at) {
      const $pos = view.state.doc.resolve(at.pos)
      view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
    }
    files.forEach(insertUploadedImage)
  }

  // Typora-style: a dropped video/audio file becomes `<video src="…" controls>`
  // (relative to the document when it sits beside it). The player itself is
  // rendered by the html node view.
  const insertDroppedMedia = (event) => {
    const files = [...(event.dataTransfer?.files || [])].filter((file) => mediaKindOf(file))
    if (!files.length || !window.api?.getPathForDroppedFile) return false
    const tags = files.map((file) => {
      let path = ''
      try { path = window.api.getPathForDroppedFile(file) || '' } catch {}
      if (!path) return ''
      const tag = mediaKindOf(file)
      return `<${tag} src="${mediaSrcFor(path, docPath).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" controls></${tag}>`
    }).filter(Boolean)
    if (!tags.length) return false
    const markdown = tags.join('\n\n')
    const doc = crepe.editor.ctx.get(parserCtx)(markdown)
    if (!doc?.content?.size) return false
    event.preventDefault()
    event.stopImmediatePropagation()
    const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
    if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))))
    try {
      markUserEdit?.()
      const { $from, empty } = view.state.selection
      const tr = view.state.tr
      if (empty && $from.parent.isTextblock && $from.parent.content.size === 0) {
        // An empty line: the player takes its place.
        tr.replaceSelection(new Slice(doc.content, 0, 0))
      } else {
        // Inside text: put the player on its own line after the top-level
        // block instead of splitting the paragraph.
        tr.insert($from.depth ? $from.after(1) : $from.pos, doc.content)
      }
      view.dispatch(tr.scrollIntoView())
    } catch {}
    return true
  }

  let lastImageClick = { src: null, at: 0 }
  const onImageClick = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    if (event.target.closest?.('.caption-input, .operation, .operation-item, .image-resize-handle, button, input, textarea')) return
    const image = event.target.closest?.('img') || event.target.closest?.('.image-wrapper')?.querySelector?.('img')
    if (!image || !view.dom.contains(image)) return
    const src = image.currentSrc || image.getAttribute('src')
    if (!src) return
    const now = event.timeStamp || Date.now()
    if (lastImageClick.src === src && now - lastImageClick.at < 350) {
      event.preventDefault()
      setZoom({ type: 'img', src })
      lastImageClick = { src: null, at: 0 }
    } else {
      lastImageClick = { src, at: now }
    }
  }

  const onCaptionButton = (event) => {
    const operation = event.target.closest?.('.milkdown-image-block .operation-item')
    if (!operation) return
    const block = operation.closest('.milkdown-image-block')
    let tries = 0
    const tryFocus = () => {
      if (isDestroyed()) return
      const input = block?.querySelector('input.caption-input')
      if (input) input.focus()
      else if (tries++ < 12) setTimeout(tryFocus, 30)
    }
    setTimeout(tryFocus, 0)
  }

  const onCopyButton = async (event) => {
    const button = event.target.closest?.('.copy-button')
    if (!button || !view.dom.contains(button)) return
    const block = button.closest('.milkdown-code-block')
    if (!block) return
    event.preventDefault()
    event.stopImmediatePropagation()

    let node = null
    try {
      const pos = view.posAtDOM(block, 0)
      const $pos = view.state.doc.resolve(pos)
      const ancestors = []
      for (let depth = $pos.depth; depth >= 0; depth -= 1) ancestors.push($pos.node(depth))
      node = [
        ...ancestors,
        view.state.doc.nodeAt(pos),
        $pos.nodeAfter,
        $pos.nodeBefore
      ].find((candidate) => candidate?.type?.name === 'code_block')
    } catch {}

    // CodeMirror virtualizes long documents, so `.cm-line` only represents the
    // visible window (often about 30–65 lines). If DOM position mapping ever
    // fails, match the wrapper's document-order index to the full PM node;
    // never report a successful copy from the partial rendered DOM.
    if (!node) {
      const blockIndex = [...view.dom.querySelectorAll('.milkdown-code-block')].indexOf(block)
      let currentIndex = -1
      view.state.doc.descendants((candidate) => {
        if (candidate.type.name !== 'code_block') return true
        currentIndex += 1
        if (currentIndex !== blockIndex) return true
        node = candidate
        return false
      })
    }
    if (!node) return

    if (!await copyToClipboard(node.textContent, getT('code.copied'))) return
    button.classList.add('hm-copied')
    setTimeout(() => button.classList.remove('hm-copied'), 1100)
  }

  const onMermaidClick = (event) => {
    const svg = event.target.closest?.('.milkdown-code-block .preview svg')
    if (!svg || !view.dom.contains(svg)) return
    const clone = svg.cloneNode(true)
    const viewBox = svg.viewBox?.baseVal
    const rendered = svg.getBoundingClientRect()
    const width = viewBox?.width || svg.width?.baseVal?.value || rendered.width
    const height = viewBox?.height || svg.height?.baseVal?.value || rendered.height
    clone.removeAttribute('width')
    clone.removeAttribute('height')
    clone.style.cssText = ''
    if (width > 0) clone.setAttribute('width', String(width))
    if (height > 0) clone.setAttribute('height', String(height))
    setZoom({ type: 'svg', html: clone.outerHTML, width, height })
  }

  view.dom.addEventListener('click', onLinkClick, true)
  view.dom.addEventListener('click', onImageClick, true)
  view.dom.addEventListener('click', onMermaidClick, true)
  view.dom.addEventListener('click', onCaptionButton)
  view.dom.addEventListener('click', onCopyButton, true)
  view.dom.addEventListener('copy', onCopy, true)
  view.dom.addEventListener('cut', onCut, true)
  view.dom.addEventListener('paste', onPasteImage, true)
  view.dom.addEventListener('drop', onDropImage, true)
  cleanups.push(
    attachMdPasteHandler(view, (markdown) => {
      try {
        return crepe.editor.ctx.get(parserCtx)(markdown)
      } catch {
        return null
      }
    }, prepareRawMarkdownPaste, markUserEdit)
  )
  // Plain-text drops insert literal text at the drop point — without this,
  // ProseMirror's html-flavored block insertion splits the host textblock
  // (trace-61614: a `<br />` drop split a list item into [empty, text] and
  // spawned unround-trippable empty blocks → source-sync warning).
  cleanups.push(attachPlainTextDropHandler(view, markUserEdit))
  cleanups.push(() => view.dom.removeEventListener('click', onLinkClick, true))
  cleanups.push(() => view.dom.removeEventListener('click', onImageClick, true))
  cleanups.push(() => view.dom.removeEventListener('click', onMermaidClick, true))
  cleanups.push(() => view.dom.removeEventListener('click', onCaptionButton))
  cleanups.push(() => view.dom.removeEventListener('click', onCopyButton, true))
  cleanups.push(() => view.dom.removeEventListener('copy', onCopy, true))
  cleanups.push(() => view.dom.removeEventListener('cut', onCut, true))
  cleanups.push(() => view.dom.removeEventListener('paste', onPasteImage, true))
  cleanups.push(() => view.dom.removeEventListener('drop', onDropImage, true))

  const baseDir = dirOf(docPath)
  if (!baseDir) return
  // Also <video>/<audio>/<source> (and a video's poster) from raw-HTML embeds.
  const fixImage = (image) => {
    if (image.dataset.hmResolved) return
    // Mark only once something was resolved: an <img> whose src is still a
    // data:/blob: URL may later be switched to a relative path.
    for (const attr of image.tagName === 'VIDEO' ? ['src', 'poster'] : ['src']) {
      const raw = image.getAttribute(attr) || ''
      const winAbsolute = image.tagName !== 'IMG' && /^[a-zA-Z]:[\\/]/.test(raw)
      if (!winAbsolute && !isRelativePath(raw)) continue
      image.dataset.hmResolved = '1'
      image.setAttribute(attr, winAbsolute ? resolveToFileUrl(raw, '') : resolveToFileUrl(baseDir, raw))
      // A changed <source> is only picked up when its player reloads.
      if (image.tagName === 'SOURCE') image.parentElement?.load?.()
    }
  }
  const MEDIA_SELECTOR = 'img, video, audio, source'
  const scanImages = (root) => {
    if (root.matches?.(MEDIA_SELECTOR)) fixImage(root)
    else root.querySelectorAll?.(MEDIA_SELECTOR).forEach(fixImage)
  }
  scanImages(view.dom)
  let imageScanRaf = 0
  const scheduleImageScan = () => {
    if (imageScanRaf) return
    imageScanRaf = requestAnimationFrame(() => {
      imageScanRaf = 0
      scanImages(view.dom)
    })
  }
  const imageObserver = new MutationObserver(scheduleImageScan)
  imageObserver.observe(view.dom, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src']
  })
  cleanups.push(() => {
    if (imageScanRaf) cancelAnimationFrame(imageScanRaf)
    imageObserver.disconnect()
  })
}

// Path written into a dropped media tag: relative (forward slashes) when the
// file is inside the document's folder, otherwise the absolute path.
export function mediaSrcFor(filePath, docPath) {
  const file = String(filePath).replace(/\\/g, '/')
  const base = dirOf(docPath)
  if (base) {
    const prefix = base.replace(/\/+$/, '') + '/'
    const same = /^[a-zA-Z]:/.test(prefix) ? file.toLowerCase().startsWith(prefix.toLowerCase()) : file.startsWith(prefix)
    if (same) return file.slice(prefix.length)
  }
  return file
}

// 'video' / 'audio' for a dropped media file (by MIME type, else extension).
const AUDIO_NAME_RE = /\.(?:mp3|m4a|aac|wav|ogg|oga|flac|opus)$/i
const VIDEO_NAME_RE = /\.(?:mp4|m4v|webm|ogv|mov)$/i
function mediaKindOf(file) {
  if (/^audio\//.test(file?.type || '') || AUDIO_NAME_RE.test(file?.name || '')) return 'audio'
  if (/^video\//.test(file?.type || '') || VIDEO_NAME_RE.test(file?.name || '')) return 'video'
  return null
}
