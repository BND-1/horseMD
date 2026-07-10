import { parserCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/prose/state'
import { copyToClipboard, fireToast } from '../ui.js'
import { dirOf, isRelativePath, resolveToFileUrl } from './editor-images.js'
import { inlineRichStyles } from './editor-copy.js'
import { attachMdPasteHandler } from './editor-md-paste.js'
import { createToolbarScanner } from './editor-toolbar.js'

const clamp = (value, min, max) => {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

const mountSlashMenuBounds = ({ host, scrollEl, cleanups }) => {
  const root = host
  const margin = 8
  let raf = 0

  const schedule = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      fix()
    })
  }

  const fix = () => {
    const menu = root.querySelector('.milkdown-slash-menu[data-show="true"]')
    if (!menu || menu.offsetParent === null) return
    const rect = menu.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const boundsRect = scrollEl?.getBoundingClientRect?.()
    const safe = {
      left: Math.max(0, boundsRect?.left ?? 0) + margin,
      top: Math.max(0, boundsRect?.top ?? 0) + margin,
      right: Math.min(window.innerWidth, boundsRect?.right ?? window.innerWidth) - margin,
      bottom: Math.min(window.innerHeight, boundsRect?.bottom ?? window.innerHeight) - margin
    }
    if (safe.right <= safe.left || safe.bottom <= safe.top) return

    const left = Number.parseFloat(menu.style.left || '0')
    const top = Number.parseFloat(menu.style.top || '0')
    let nextLeft = left
    let nextTop = top

    if (rect.left < safe.left) nextLeft += safe.left - rect.left
    else if (rect.right > safe.right) nextLeft -= rect.right - safe.right

    if (rect.top < safe.top) nextTop += safe.top - rect.top
    else if (rect.bottom > safe.bottom) nextTop -= rect.bottom - safe.bottom

    nextLeft = clamp(nextLeft, left + safe.left - rect.left, left + safe.right - rect.right)
    nextTop = clamp(nextTop, top + safe.top - rect.top, top + safe.bottom - rect.bottom)

    if (Math.abs(nextLeft - left) > 0.5) menu.style.left = `${Math.round(nextLeft)}px`
    if (Math.abs(nextTop - top) > 0.5) menu.style.top = `${Math.round(nextTop)}px`

    const groups = menu.querySelector('.menu-groups')
    if (groups) {
      const previousMaxHeight = groups.style.maxHeight
      const tabGroup = menu.querySelector('.tab-group')
      const tabHeight = tabGroup?.getBoundingClientRect?.().height || 0
      const available = Math.max(96, safe.bottom - safe.top - tabHeight - 16)
      const nextMaxHeight = `${Math.min(420, Math.floor(available))}px`
      groups.style.maxHeight = nextMaxHeight
      if (previousMaxHeight !== nextMaxHeight) schedule()
    }
  }

  const observer = new MutationObserver(schedule)
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'data-show']
  })
  window.addEventListener('resize', schedule)
  scrollEl?.addEventListener('scroll', schedule, { passive: true })
  cleanups.push(() => {
    if (raf) cancelAnimationFrame(raf)
    observer.disconnect()
    window.removeEventListener('resize', schedule)
    scrollEl?.removeEventListener('scroll', schedule)
  })
}

export function mountEditorDomBindings({
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
  reportActiveBlock,
  refreshLevel,
  scheduleLevel,
  setBlock,
  setCtxMenu,
  setLevel,
  setZoom,
  getT,
  isDestroyed
}) {
  if (!view) return

  const updateHighlightActive = () => {
    const v = viewRef.current
    let active = false
    if (v && v.hasFocus()) {
      const { from, $from, empty, to } = v.state.selection
      const type = v.state.schema.marks.highlight
      if (type) {
        active = empty
          ? ($from.storedMarks || []).some((m) => m.type === type)
          : v.state.doc.rangeHasMark(from, to, type)
      }
    }
    document
      .querySelectorAll('.milkdown-toolbar .hm-highlight-item')
      .forEach((b) => b.classList.toggle('active', active))
  }

  const onKeydown = (e) => {
    markUserEdit()
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
    if (window.api?.platform === 'ios' || window.api?.platform === 'android') return
    e.preventDefault()
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
    updateHighlightActive()
  }

  const onUserEditIntent = () => markUserEdit()
  const onPointerDown = (e) => {
    view.dom.__horsemdLastPointerDown = {
      left: e.clientX,
      top: e.clientY,
      at: Date.now()
    }
    markUserEdit()
  }
  view.dom.addEventListener('keydown', onKeydown)
  view.dom.addEventListener('beforeinput', onUserEditIntent, true)
  view.dom.addEventListener('input', onUserEditIntent, true)
  view.dom.addEventListener('paste', onUserEditIntent, true)
  view.dom.addEventListener('drop', onUserEditIntent, true)
  view.dom.addEventListener('cut', onUserEditIntent, true)
  view.dom.addEventListener('compositionend', onUserEditIntent, true)
  view.dom.addEventListener('mousedown', onPointerDown, true)
  view.dom.addEventListener('contextmenu', onContextMenu)
  cleanups.push(() => view.dom.removeEventListener('keydown', onKeydown))
  cleanups.push(() => view.dom.removeEventListener('beforeinput', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('input', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('paste', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('drop', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('cut', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('compositionend', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('mousedown', onPointerDown, true))
  cleanups.push(() => view.dom.removeEventListener('contextmenu', onContextMenu))

  const onBlur = () => setLevel(null)
  const onFocus = () => refreshLevel()
  view.dom.addEventListener('blur', onBlur)
  view.dom.addEventListener('focus', onFocus)
  cleanups.push(() => view.dom.removeEventListener('blur', onBlur))
  cleanups.push(() => view.dom.removeEventListener('focus', onFocus))

  const scrollEl = host.closest('.editor-scroll')
  mountSlashMenuBounds({ host, scrollEl, cleanups })
  if (scrollEl) {
    let scrollLevelTimer = 0
    const onScroll = () => {
      if (scrollLevelTimer) clearTimeout(scrollLevelTimer)
      scrollLevelTimer = setTimeout(() => {
        scrollLevelTimer = 0
        refreshLevel()
      }, 150)
    }
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    cleanups.push(() => {
      scrollEl.removeEventListener('scroll', onScroll)
      if (scrollLevelTimer) clearTimeout(scrollLevelTimer)
    })
  }

  const onMove = () => scheduleLevel()
  view.dom.addEventListener('mousemove', onMove, { passive: true })
  cleanups.push(() => view.dom.removeEventListener('mousemove', onMove))

  document.addEventListener('selectionchange', onSelChange)
  cleanups.push(() => document.removeEventListener('selectionchange', onSelChange))

  const onLinkClick = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return
    const a = e.target.closest?.('a')
    const href = a?.getAttribute('href')
    if (!href) return
    if (/^(https?:|mailto:)/i.test(href)) {
      e.preventDefault()
      e.stopPropagation()
      window.api.openExternal(href)
    } else if (/^file:/i.test(href) && window.api.openFileUrl) {
      e.preventDefault()
      e.stopPropagation()
      window.api.openFileUrl(href)
    } else if (isRelativePath(href) && !href.startsWith('#') && window.api.openFileUrl) {
      const baseDir = dirOf(docPath)
      if (!baseDir) return
      e.preventDefault()
      e.stopPropagation()
      window.api.openFileUrl(resolveToFileUrl(baseDir, href))
    }
  }

  const onCopy = (e) => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !view.dom.contains(sel.anchorNode)) return
    if (sel.anchorNode?.parentElement?.closest?.('.cm-editor')) return
    try {
      const frag = sel.getRangeAt(0).cloneContents()
      const wrap = document.createElement('div')
      wrap.appendChild(frag)
      inlineRichStyles(wrap)
      const plain = sel.toString()
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

  const imageHandlingActive = (e) =>
    !e.target.closest?.('.cm-editor, input, textarea, .caption-input')
  const onPasteImage = (e) => {
    if (!imageHandlingActive(e)) return
    const items = e.clipboardData?.items
    if (!items) return
    const imgItem = [...items].find((it) => it.kind === 'file' && it.type.startsWith('image/'))
    if (!imgItem) return
    const file = imgItem.getAsFile()
    if (!file) return
    e.preventDefault()
    e.stopImmediatePropagation()
    insertUploadedImage(file, true)
  }
  const onDropImage = (e) => {
    if (!imageHandlingActive(e)) return
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const at = view.posAtCoords({ left: e.clientX, top: e.clientY })
    if (at) {
      const $pos = view.state.doc.resolve(at.pos)
      view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
    }
    files.forEach(insertUploadedImage)
  }

  let lastImgClick = { src: null, at: 0 }
  const onImgClick = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
    if (
      e.target.closest?.(
        '.caption-input, .operation, .operation-item, .image-resize-handle, button, input, textarea'
      )
    )
      return
    const img = e.target.closest?.('img') || e.target.closest?.('.image-wrapper')?.querySelector?.('img')
    if (!img || !view.dom.contains(img)) return
    const src = img.currentSrc || img.getAttribute('src')
    if (!src) return
    const now = e.timeStamp || Date.now()
    if (lastImgClick.src === src && now - lastImgClick.at < 350) {
      e.preventDefault()
      setZoom({ type: 'img', src })
      lastImgClick = { src: null, at: 0 }
    } else {
      lastImgClick = { src, at: now }
    }
  }

  const onCaptionBtn = (e) => {
    const op = e.target.closest?.('.milkdown-image-block .operation-item')
    if (!op) return
    const block = op.closest('.milkdown-image-block')
    let tries = 0
    const tryFocus = () => {
      if (isDestroyed()) return
      const input = block?.querySelector('input.caption-input')
      if (input) {
        input.focus()
      } else if (tries++ < 12) {
        setTimeout(tryFocus, 30)
      }
    }
    setTimeout(tryFocus, 0)
  }

  const onCopyBtn = (e) => {
    const btn = e.target.closest?.('.copy-button')
    if (!btn || !view.dom.contains(btn)) return
    btn.classList.add('hm-copied')
    setTimeout(() => btn.classList.remove('hm-copied'), 1100)
    fireToast(getT('code.copied'))
  }

  const onMermaidClick = (e) => {
    const svg = e.target.closest?.('.milkdown-code-block .preview svg')
    if (!svg || !view.dom.contains(svg)) return
    const clone = svg.cloneNode(true)
    clone.removeAttribute('width')
    clone.removeAttribute('height')
    clone.style.cssText = ''
    setZoom({ type: 'svg', html: clone.outerHTML })
  }

  view.dom.addEventListener('click', onLinkClick, true)
  view.dom.addEventListener('click', onImgClick, true)
  view.dom.addEventListener('click', onMermaidClick, true)
  view.dom.addEventListener('click', onCaptionBtn)
  view.dom.addEventListener('click', onCopyBtn, true)
  view.dom.addEventListener('copy', onCopy, true)
  view.dom.addEventListener('paste', onPasteImage, true)
  view.dom.addEventListener('drop', onDropImage, true)
  cleanups.push(
    attachMdPasteHandler(view, (md) => {
      try {
        return crepe.editor.ctx.get(parserCtx)(md)
      } catch {
        return null
      }
    })
  )
  cleanups.push(() => view.dom.removeEventListener('click', onLinkClick, true))
  cleanups.push(() => view.dom.removeEventListener('click', onImgClick, true))
  cleanups.push(() => view.dom.removeEventListener('click', onMermaidClick, true))
  cleanups.push(() => view.dom.removeEventListener('click', onCaptionBtn))
  cleanups.push(() => view.dom.removeEventListener('click', onCopyBtn, true))
  cleanups.push(() => view.dom.removeEventListener('copy', onCopy, true))
  cleanups.push(() => view.dom.removeEventListener('paste', onPasteImage, true))
  cleanups.push(() => view.dom.removeEventListener('drop', onDropImage, true))

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
    let imgScanRaf = 0
    const scheduleImgScan = () => {
      if (imgScanRaf) return
      imgScanRaf = requestAnimationFrame(() => {
        imgScanRaf = 0
        scanImgs(view.dom)
      })
    }
    const imgObserver = new MutationObserver(() => scheduleImgScan())
    imgObserver.observe(view.dom, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    })
    cleanups.push(() => {
      if (imgScanRaf) cancelAnimationFrame(imgScanRaf)
      imgObserver.disconnect()
    })
  }

  const { scanToolbars, cleanup: cleanupToolbarScan } = createToolbarScanner({
    liveEditors,
    self,
    t: getT,
    updateHighlightActive
  })
  scanToolbars()
  cleanups.push(cleanupToolbarScan)
}
