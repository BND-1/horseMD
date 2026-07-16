import { parserCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/prose/state'
import { fireToast } from '../ui.js'
import { dirOf, isRelativePath, resolveToFileUrl } from './editor-images.js'
import { inlineRichStyles } from './editor-copy.js'
import { attachMdPasteHandler } from './editor-md-paste.js'

export function mountEditorContentBindings({
  view,
  docPath,
  crepe,
  cleanups,
  insertUploadedImage,
  setZoom,
  getT,
  isDestroyed
}) {
  const onLinkClick = (event) => {
    if (!(event.ctrlKey || event.metaKey)) return
    const anchor = event.target.closest?.('a')
    const href = anchor?.getAttribute('href')
    if (!href) return
    if (/^(https?:|mailto:)/i.test(href)) {
      event.preventDefault()
      event.stopPropagation()
      window.api.openExternal(href)
    } else if (/^file:/i.test(href) && window.api.openFileUrl) {
      event.preventDefault()
      event.stopPropagation()
      window.api.openFileUrl(href)
    } else if (isRelativePath(href) && !href.startsWith('#') && window.api.openFileUrl) {
      const baseDir = dirOf(docPath)
      if (!baseDir) return
      event.preventDefault()
      event.stopPropagation()
      window.api.openFileUrl(resolveToFileUrl(baseDir, href))
    }
  }

  const onCopy = (event) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !view.dom.contains(selection.anchorNode)) return
    if (selection.anchorNode?.parentElement?.closest?.('.cm-editor')) return
    try {
      const fragment = selection.getRangeAt(0).cloneContents()
      const wrapper = document.createElement('div')
      wrapper.appendChild(fragment)
      inlineRichStyles(wrapper)
      const plain = selection.toString()
      if (!wrapper.innerHTML.trim() && !plain) return
      event.clipboardData.setData(
        'text/html',
        `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#24292f;">${wrapper.innerHTML}</div>`
      )
      event.clipboardData.setData('text/plain', plain)
      event.preventDefault()
    } catch {
      // Fall back to the browser's default copy behavior.
    }
  }

  const imageHandlingActive = (event) =>
    !event.target.closest?.('.cm-editor, input, textarea, .caption-input')
  const onPasteImage = (event) => {
    if (!imageHandlingActive(event)) return
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

  const onCopyButton = (event) => {
    const button = event.target.closest?.('.copy-button')
    if (!button || !view.dom.contains(button)) return
    button.classList.add('hm-copied')
    setTimeout(() => button.classList.remove('hm-copied'), 1100)
    fireToast(getT('code.copied'))
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
  view.dom.addEventListener('paste', onPasteImage, true)
  view.dom.addEventListener('drop', onDropImage, true)
  cleanups.push(
    attachMdPasteHandler(view, (markdown) => {
      try {
        return crepe.editor.ctx.get(parserCtx)(markdown)
      } catch {
        return null
      }
    })
  )
  cleanups.push(() => view.dom.removeEventListener('click', onLinkClick, true))
  cleanups.push(() => view.dom.removeEventListener('click', onImageClick, true))
  cleanups.push(() => view.dom.removeEventListener('click', onMermaidClick, true))
  cleanups.push(() => view.dom.removeEventListener('click', onCaptionButton))
  cleanups.push(() => view.dom.removeEventListener('click', onCopyButton, true))
  cleanups.push(() => view.dom.removeEventListener('copy', onCopy, true))
  cleanups.push(() => view.dom.removeEventListener('paste', onPasteImage, true))
  cleanups.push(() => view.dom.removeEventListener('drop', onDropImage, true))

  const baseDir = dirOf(docPath)
  if (!baseDir) return
  const fixImage = (image) => {
    if (image.dataset.hmResolved) return
    const raw = image.getAttribute('src') || ''
    if (!isRelativePath(raw)) return
    image.dataset.hmResolved = '1'
    image.setAttribute('src', resolveToFileUrl(baseDir, raw))
  }
  const scanImages = (root) => {
    if (root.tagName === 'IMG') fixImage(root)
    else root.querySelectorAll?.('img').forEach(fixImage)
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
