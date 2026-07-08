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
function getTip() {
  if (tip) return tip
  tip = document.createElement('div')
  tip.className = 'hm-math-preview'
  tip.style.display = 'none'
  document.body.appendChild(tip)
  return tip
}

export function mathPreviewPlugin() {
  let raf = 0
  const hide = () => { const t = getTip(); t.style.display = 'none' }

  const render = (view) => {
    raf = 0
    const t = getTip()
    const { state } = view
    const { selection } = state
    if (!view.hasFocus() || !selection.empty) return hide()
    const $head = selection.$head
    // Never inside a code block (typing ` there is literal).
    if ($head.parent.type.name === 'code_block') return hide()
    // Text in the current textblock up to the caret (ProseMirror's Node has no
    // lineAt; textBetween handles inline nodes by their text content).
    const textBefore = state.doc.textBetween($head.start(), $head.pos, '\n')
    const content = unclosedMathContent(textBefore)
    if (!content) return hide()
    let html
    try {
      html = katex.renderToString(content, { throwOnError: false, displayMode: false })
    } catch {
      return hide()
    }
    t.innerHTML = html
    // Position just below the caret (coordsAtPos = one layout read; only when showing).
    const coords = view.coordsAtPos(selection.head)
    t.style.left = Math.round(coords.left) + 'px'
    t.style.top = Math.round(coords.bottom + 6) + 'px'
    t.style.display = ''
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
