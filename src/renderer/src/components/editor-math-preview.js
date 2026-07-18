// Live KaTeX preview while typing inline math (issue #45).
//
// Milkdown's inline-math input rule (/\$([^$]+)$/) only fires when the CLOSING $
// is typed, so while typing `$x^2` (no closing yet) there's no preview — the
// filer's complaint. This plugin shows a small KaTeX preview tooltip near the
// caret whenever the text before the caret looks like an UNCLOSED inline-math
// span (`$<mathy-content>`), so the rendered formula appears as they type.
// Typing the closing $ converts it to a real math_inline node (the existing
// input rule) and the tooltip hides (the pattern no longer matches).
//
// Purely additive: reads editor state + renders a floating div. Never touches
// the document, never intercepts key events → no typing regression. Hides on
// non-empty selection, inside code blocks, when the content isn't mathy (so
// prose like `$5` / `$HOME` doesn't trigger a preview), and on blur.
import { Plugin } from '@milkdown/prose/state'
import katex from 'katex'
import { inlineMathAtCaret } from './editor-inline-math.js'

// Chars that signal the content is actually math (not prose). Without one of
// these, `$5`/`$cost` would pop a pointless preview.
const MATHY = /[\\^_{}]/

// Find an unclosed inline-math span ending at the caret: a `$` (not escaped, not
// part of `$$`) followed by content with no closing `$` before the caret.
function unclosedMathContent(textBeforeCaret) {
  const m = textBeforeCaret.match(/(?:^|[^\\$])\$([^$\n]+)$/)
  if (!m) return null
  const content = m[1]
  if (!content || !MATHY.test(content)) return null
  return content
}

// One shared tooltip for the whole app (one per editor would leave N hidden
// divs for N tabs). Lazy-created on first use; lives until page unload.
let tip = null
let innerEditListenersMounted = false

const renderKatex = (target, content) => {
  if (!content) return false
  try {
    target.innerHTML = katex.renderToString(content, { throwOnError: false, displayMode: false })
    return true
  } catch {
    return false
  }
}

const placeTip = (target, left, top) => {
  target.style.left = `${Math.round(left)}px`
  target.style.top = `${Math.round(top)}px`
  target.style.display = ''
  const rect = target.getBoundingClientRect()
  const margin = 8
  if (rect.right > window.innerWidth - margin) {
    target.style.left = `${Math.max(margin, Math.round(window.innerWidth - rect.width - margin))}px`
  }
  if (rect.bottom > window.innerHeight - margin) {
    target.style.top = `${Math.max(margin, Math.round(top - rect.height - 36))}px`
  }
}

const previewInlineEditor = (editor) => {
  const target = getTip()
  if (!renderKatex(target, editor.textContent || '')) {
    target.style.display = 'none'
    return
  }
  const anchor = editor.closest('.milkdown-latex-inline-edit') || editor
  const rect = anchor.getBoundingClientRect()
  placeTip(target, rect.left, rect.bottom + 8)
}

const clearInlineEditor = (editor) => {
  if (!editor) return
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(editor)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  document.execCommand?.('delete')
  editor.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType: 'deleteContentBackward',
    data: null
  }))
}

const enhanceInlineEditor = (popup, getT) => {
  if (!popup || popup.querySelector('.hm-inline-math-clear')) return
  const confirm = popup.querySelector('button')
  if (!confirm) return

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'hm-inline-math-clear'
  button.textContent = getT?.('math.clear') || 'Clear'
  button.title = getT?.('math.clear') || 'Clear'
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    clearInlineEditor(popup.querySelector('.ProseMirror'))
  })
  confirm.insertAdjacentElement('afterend', button)
}

const mountInlineEditListeners = (getT) => {
  if (innerEditListenersMounted) return
  innerEditListenersMounted = true
  const schedule = (event) => {
    const editor = event.target?.closest?.('.milkdown-latex-inline-edit .ProseMirror')
    if (!editor) return
    requestAnimationFrame(() => {
      enhanceInlineEditor(editor.closest('.milkdown-latex-inline-edit'), getT)
      previewInlineEditor(editor)
    })
  }
  document.addEventListener('focusin', schedule, true)
  document.addEventListener('input', schedule, true)
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!document.activeElement?.closest?.('.milkdown-latex-inline-edit')) {
        if (tip) tip.style.display = 'none'
      }
    }, 0)
  }, true)
  const observer = new MutationObserver(() => {
    document.querySelectorAll('.milkdown-latex-inline-edit').forEach((popup) => enhanceInlineEditor(popup, getT))
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

function getTip(getT) {
  if (tip) return tip
  tip = document.createElement('div')
  tip.className = 'hm-math-preview'
  tip.style.display = 'none'
  document.body.appendChild(tip)
  mountInlineEditListeners(getT)
  return tip
}

export function mathPreviewPlugin(getT) {
  let raf = 0
  const hide = () => { const t = getTip(getT); t.style.display = 'none' }

  const render = (view) => {
    raf = 0
    const t = getTip(getT)
    const { state } = view
    const { selection } = state
    if (!view.hasFocus() || !selection.empty) return hide()
    const $head = selection.$head
    // Never inside a code block (typing ` there is literal).
    if ($head.parent.type.name === 'code_block') return hide()
    const blockText = $head.parent.textBetween(0, $head.parent.content.size, '\n', '\uFFFC')
    const complete = inlineMathAtCaret(blockText, $head.parentOffset)
    // Keep the existing conservative unclosed-$ preview, but a complete pair
    // around the caret is unambiguous and may contain plain digits (#68).
    const textBefore = state.doc.textBetween($head.start(), $head.pos, '\n')
    const content = complete?.value || unclosedMathContent(textBefore)
    if (!content) return hide()
    if (!renderKatex(t, content)) return hide()
    // Position just below the caret (coordsAtPos = one layout read; only when showing).
    const coords = view.coordsAtPos(selection.head)
    placeTip(t, coords.left, coords.bottom + 6)
  }

  const schedule = (view) => {
    if (raf) cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => render(view))
  }

  return new Plugin({
    view(view) {
      // Hide when the editor loses focus (otherwise the tooltip lingers).
      const onBlur = () => hide()
      view.dom.addEventListener('blur', onBlur)
      schedule(view)
      return {
        update: (v) => schedule(v),
        destroy: () => {
          view.dom.removeEventListener('blur', onBlur)
          if (raf) cancelAnimationFrame(raf)
          // Don't remove the shared tip — other editors / later mounts reuse it.
        },
      }
    },
  })
}
