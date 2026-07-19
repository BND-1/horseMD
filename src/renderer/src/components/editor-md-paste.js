// Smart paste for Markdown.
//
// Milkdown's default paste does NOT parse pasted Markdown source — pasting a doc
// with `#` headings / tables / blockquotes / `$$` math / ```fences / `---` front
// matter lands as flat text. This handler runs in the DOM CAPTURE phase (before
// ProseMirror's own paste handler, which would build a slice from text/html and
// bypass us), reads text/plain from the clipboard, and — when it clearly IS
// Markdown — runs it through Milkdown's own remark parser so it renders with full
// fidelity. Scoped triggers:
//   (1) raw mermaid code that starts with a diagram header → a mermaid block;
//   (2) any strong Markdown block marker → parse the whole clipboard as Markdown.
// Never takes over when pasting INTO a code block (append code there).
import { Slice, Fragment } from '@milkdown/prose/model'
import { startsAsMermaid } from './editor-mermaid.js'
import { normalizeDisplayMath } from './editor-math.js'
import { hasStructuredWebHtml } from './editor-web-paste.js'

function looksLikeMarkdown(text) {
  if (/^#{1,6}\s/m.test(text)) return true
  if (/^```/m.test(text)) return true
  if (/^>\s/m.test(text)) return true
  if (/^\|.*\|.*\n/m.test(text)) return true
  if (/^([-*+]\s|\d+\.\s)/m.test(text)) return true
  if (/\$\$/.test(text)) return true
  if (/^(\*\*\*|---)\s*$/m.test(text)) return true // hr / front-matter fence
  return false
}

// A browser can expose a Markdown copy as both text/plain and rendered HTML.
// Retaining the plain text is only safe when it accounts for the meaningful
// structure in that HTML. For example, a WeChat fallback such as "1. ..."
// must not replace a real heading, bold mark, or image from text/html.
function rawMarkdownCoversStructuredHtml(text, html) {
  const has = (pattern) => pattern.test(html)
  if (has(/<h[1-6](?:\s|>)/i) && !/^#{1,6}\s/m.test(text)) return false
  if (has(/<(?:ul|li)(?:\s|>)/i) && !/^[-*+]\s/m.test(text)) return false
  if (has(/<(?:ol)(?:\s|>)/i) && !/^\d+\.\s/m.test(text)) return false
  if (has(/<table(?:\s|>)/i) && !/^\|.*\|.*\n/m.test(text)) return false
  if (has(/<(?:strong|b)(?:\s|>)/i) && !/(?:\*\*|__)/.test(text)) return false
  if (has(/<(?:em|i)(?:\s|>)/i) && !/(?:\*[^*\n]+\*|_[^_\n]+_)/.test(text)) return false
  if (has(/<a(?:\s|>)/i) && !/\[[^\]]+\]\([^\)]+\)/.test(text)) return false
  if (has(/<img(?:\s|>)/i) && !/!\[[^\]]*\]\([^\)]+\)/.test(text)) return false
  if (has(/<br(?:\s|\/?>)/i) && !/\\\r?\n/.test(text)) return false
  return true
}

// Attach a capture-phase paste listener on the editor DOM. Returns a cleanup fn.
export function attachMdPasteHandler(view, parse, prepareRawMarkdownPaste) {
  const onPaste = (event) => {
    // Pasting INTO a code block should append code, not restructure.
    if (view.state.selection.$from.parent.type.name === 'code_block') return
    // Browsers provide text/plain alongside text/html. Numbered headings and
    // divider-like prose in that fallback can resemble Markdown; keep the
    // structured HTML instead of flattening headings, marks and images.
    const text = event.clipboardData?.getData('text/plain') || ''
    const html = event.clipboardData?.getData('text/html') || ''
    const structuredHtml = hasStructuredWebHtml(html)
    const shouldHandleRawMarkdown = text && looksLikeMarkdown(text) &&
      (!structuredHtml || rawMarkdownCoversStructuredHtml(text, html))

    // A Markdown-aware app often puts both a rendered HTML fragment and its
    // exact Markdown source on the clipboard. When the source covers all HTML
    // structure, parse that source ourselves instead of letting ProseMirror
    // consume HTML and serialize it again later. Web pages whose plain fallback
    // omits real headings, marks, links, or images keep the HTML path.
    if (structuredHtml && !shouldHandleRawMarkdown) return
    if (!text) return
    const schema = view.state.schema

    let handled = false
    let cancelRawPaste = null
    if (startsAsMermaid(text)) {
      const body = text.replace(/\s+$/, '')
      const node = schema.nodes.code_block.create(
        { language: 'mermaid' },
        body ? schema.text(body) : null
      )
      cancelRawPaste = prepareRawMarkdownPaste?.({
        markdown: text,
        from: view.state.selection.from,
        to: view.state.selection.to
      })
      handled = insert(view, Fragment.from(node))
    } else if (shouldHandleRawMarkdown) {
      const doc = parse(normalizeDisplayMath(text))
      if (doc && doc.content && doc.content.size > 0) {
        cancelRawPaste = prepareRawMarkdownPaste?.({
          markdown: text,
          from: view.state.selection.from,
          to: view.state.selection.to
        })
        handled = insert(view, doc.content)
      }
    }

    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    } else {
      cancelRawPaste?.()
    }
  }
  // capture = true so we run BEFORE ProseMirror's own paste handler (which would
  // build a slice from text/html and skip us).
  view.dom.addEventListener('paste', onPaste, true)
  return () => view.dom.removeEventListener('paste', onPaste, true)
}

function insert(view, fragment) {
  try {
    const tr = view.state.tr.replaceSelection(new Slice(fragment, 0, 0))
    tr.scrollIntoView()
    view.dispatch(tr)
    return true
  } catch {
    return false
  }
}
