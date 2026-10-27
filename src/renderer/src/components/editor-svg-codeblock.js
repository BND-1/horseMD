// ```svg code blocks (#166): AI tools often hand out diagrams as a fenced
// SVG block. The block shows the picture by default, with a 「图 | 代码」
// switch next to Copy.
//
// The picture is Crepe's own code-block preview (renderPreview, the channel
// Mermaid and LaTeX use), as the same data:image/svg+xml <img> the inline
// SVG of #162 renders as (editor-html.js `svgCodeImage`): no script runs,
// ids and <style> stay inside the image, never live DOM. It keeps its own
// size (a 100×100 icon stays 100×100), scaled down to the line.
//
// Crepe's preview toggle knows two states: picture only, or code with the
// picture under it. 图 is the first; 代码 is the second with the picture
// panel hidden (`hm-svg-mode-code`). The switch drives Crepe's (hidden)
// toggle button, so Crepe's own state stays the source of truth for which
// panel it shows. View-only: nothing reaches the Markdown, never dirty; the
// mode lives on the node view's DOM (lost on reopen, like a code fold).
import { EditorView as CodeMirrorView } from '@codemirror/view'
import { svgCodeImage } from './editor-html.js'

const SVG_LANGUAGES = new Set(['svg', 'image/svg+xml'])
export const isSvgCodeLanguage = (language) => SVG_LANGUAGES.has(String(language || '').trim().toLowerCase())

const BLOCK = 'hm-svg-code-block'
const CODE_MODE = 'hm-svg-mode-code'
const SWITCH = 'hm-svg-mode'

// Every mounted editor's scan, so a preview render (the language or the
// text changed) re-checks the toolbars on the next frame.
const scans = new Set()
let scanFrame = 0
export function requestSvgCodeBlockScan() {
  if (scanFrame || !scans.size) return
  scanFrame = requestAnimationFrame(() => {
    scanFrame = 0
    for (const scan of scans) scan()
  })
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

// renderPreview for an svg block: the preview HTML (Crepe sanitizes it with
// DOMPurify, which keeps an <img> with a data: URL).
export function svgCodePreviewHtml(text, t) {
  const image = svgCodeImage(text)
  if (!image) {
    if (!String(text || '').trim()) return null
    return `<div class="hm-svg-code-error">${escapeHtml(t('svgCode.invalid'))}</div>`
  }
  const width = image.width ? ` width="${Math.round(image.width)}"` : ''
  const fluid = image.width ? '' : ' hm-svg-code-fluid'
  return `<img class="hm-svg-code-image${fluid}" src="${image.src}" alt=""${width}>`
}

const blockLanguage = (block) =>
  String(block.querySelector(':scope > .tools .language-button')?.textContent || block.querySelector('.language-button')?.textContent || '').trim()

export function mountSvgCodeBlockToggle({ view, cleanups, getT }) {
  const dom = view.dom
  const t = (key, fallback) => {
    const value = getT?.(key)
    return !value || value === key ? fallback : value
  }

  // The code each block showed at the last refresh. Crepe hides the code
  // as soon as a block has a preview, so typing a new ```svg block would lose
  // its code at the first complete `</svg>`: while the code is focused and
  // changing, the block switches to 代码 instead.
  const lastText = new WeakMap()
  const typedAt = new WeakMap()
  const onCodeInput = (event) => {
    const block = event.target?.closest?.('.milkdown-code-block')
    if (block && event.target.closest('.cm-editor')) typedAt.set(block, Date.now())
  }
  const codeText = (block) => {
    const editor = block.querySelector('.cm-editor')
    const cm = editor ? CodeMirrorView.findFromDOM(editor) : null
    return cm ? cm.state.doc.toString() : null
  }

  const toggleButton = (block) => block.querySelector('.tools .tools-button-group .preview-toggle-button')
  const previewOnly = (block) => Boolean(block.querySelector('.codemirror-host.hidden'))

  const refresh = (block) => {
    const isSvg = isSvgCodeLanguage(blockLanguage(block))
    const group = block.querySelector('.tools .tools-button-group')
    let control = group?.querySelector(`:scope > .${SWITCH}`) || null
    if (!isSvg) {
      // Writes only when something changes: the observer sees them.
      if (control) control.remove()
      if (block.classList.contains(BLOCK)) block.classList.remove(BLOCK, CODE_MODE)
      return
    }
    if (!block.classList.contains(BLOCK)) block.classList.add(BLOCK)
    if (!group) return
    if (!control) {
      control = document.createElement('span')
      control.className = SWITCH
      control.setAttribute('role', 'group')
      control.contentEditable = 'false'
      for (const mode of ['image', 'code']) {
        const button = document.createElement('button')
        button.type = 'button'
        button.dataset.mode = mode
        control.appendChild(button)
      }
      group.insertBefore(control, group.querySelector(':scope > .copy-button') || group.firstChild)
    }
    // No preview (an empty block): nothing to switch.
    const hasPreview = Boolean(toggleButton(block))
    const text = codeText(block)
    const typed = lastText.has(block) && text !== lastText.get(block)
    lastText.set(block, text)
    // Focus may already have left: Chromium blurs the code once Crepe hides it.
    const typing = Date.now() - (typedAt.get(block) || 0) < 2000
    if (hasPreview && typed && typing && previewOnly(block)) {
      setMode(block, 'code')
      return
    }
    if (control.hidden === hasPreview) control.hidden = !hasPreview
    const mode = !hasPreview || !previewOnly(block) ? 'code' : 'image'
    const codeMode = hasPreview && mode === 'code'
    if (block.classList.contains(CODE_MODE) !== codeMode) block.classList.toggle(CODE_MODE, codeMode)
    const label = t('svgCode.switch', 'SVG view')
    if (control.getAttribute('aria-label') !== label) control.setAttribute('aria-label', label)
    for (const button of control.querySelectorAll('button')) {
      const text = button.dataset.mode === 'image' ? t('svgCode.image', 'Image') : t('svgCode.code', 'Code')
      if (button.textContent !== text) button.textContent = text
      const pressed = button.dataset.mode === mode ? 'true' : 'false'
      if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed)
    }
  }

  const scan = () => {
    for (const block of dom.querySelectorAll('.milkdown-code-block')) refresh(block)
  }

  const setMode = (block, mode) => {
    const toggle = toggleButton(block)
    if (!toggle) return
    // 图 = Crepe's preview-only state; 代码 = code (+ the preview, hidden).
    if (previewOnly(block) !== (mode === 'image')) toggle.click()
    // Vue applies the class on its next tick.
    queueMicrotask(() => refresh(block))
    requestAnimationFrame(() => refresh(block))
  }

  const onClick = (event) => {
    const button = event.target?.closest?.(`.${SWITCH} > button`)
    const block = button?.closest('.milkdown-code-block')
    if (!block || !dom.contains(block)) return
    event.preventDefault()
    event.stopPropagation()
    setMode(block, button.dataset.mode)
  }
  // Keep the switch from taking ProseMirror's selection.
  const onMouseDown = (event) => {
    if (event.target?.closest?.(`.${SWITCH}`)) event.preventDefault()
  }

  let pending = 0
  const schedule = () => {
    if (pending) return
    pending = requestAnimationFrame(() => {
      pending = 0
      scan()
    })
  }
  const observer = new MutationObserver(schedule)
  observer.observe(dom, { childList: true, subtree: true })
  scans.add(scan)
  scan()

  dom.addEventListener('mousedown', onMouseDown, true)
  dom.addEventListener('click', onClick, true)
  dom.addEventListener('beforeinput', onCodeInput, true)
  dom.addEventListener('paste', onCodeInput, true)
  cleanups.push(() => {
    dom.removeEventListener('beforeinput', onCodeInput, true)
    dom.removeEventListener('paste', onCodeInput, true)
    observer.disconnect()
    scans.delete(scan)
    if (pending) cancelAnimationFrame(pending)
    dom.removeEventListener('mousedown', onMouseDown, true)
    dom.removeEventListener('click', onClick, true)
  })
}
