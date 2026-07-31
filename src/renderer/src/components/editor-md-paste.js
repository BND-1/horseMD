// Smart paste for Markdown.
//
// Milkdown's default paste does NOT parse pasted Markdown source — pasting a doc
// with `#` headings / tables / blockquotes / `$$` math / ```fences / `---` front
// matter lands as flat text. This handler runs in the DOM CAPTURE phase (before
// ProseMirror's own paste handler, which would build a slice from text/html and
// bypass us), reads text/markdown when HorseMD supplied it and otherwise inspects
// text/plain. When the payload clearly IS Markdown, it runs through Milkdown's
// own remark parser so it renders with full fidelity. Scoped triggers:
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

const fencedMermaid = (text) => {
  const normalized = String(text || '').replace(/\r\n?/g, '\n')
  const match = normalized.match(/^(`{3,}|~{3,})[ \t]*mermaid[^\n]*\n([\s\S]*?)\n\1[ \t]*$/i)
  if (!match) return null
  return {
    body: match[2].replace(/\s+$/, ''),
    markdown: normalized
  }
}

const mermaidPaste = (text) => {
  const fenced = fencedMermaid(text)
  if (fenced) return fenced
  if (!startsAsMermaid(text)) return null
  const body = String(text || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  const fence = body.includes('```') ? '````' : '```'
  return {
    body,
    markdown: `${fence}mermaid\n${body}\n${fence}`
  }
}

const codeBlockAtDom = (view, element) => {
  if (!element) return null
  try {
    const mapped = view.posAtDOM(element, 0)
    const $pos = view.state.doc.resolve(mapped)
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      const node = $pos.node(depth)
      if (node.type.name === 'code_block') {
        return { node, pos: $pos.before(depth) }
      }
    }
    const candidates = [
      { node: view.state.doc.nodeAt(mapped), pos: mapped },
      { node: $pos.nodeAfter, pos: mapped },
      { node: $pos.nodeBefore, pos: mapped - ($pos.nodeBefore?.nodeSize || 0) }
    ]
    const direct = candidates.find(({ node }) => node?.type?.name === 'code_block')
    if (direct) return direct
  } catch {}

  // CodeMirror node views can shield their internal DOM from posAtDOM. Match
  // the wrapper's document-order index to code_block nodes as a stable fallback.
  const domBlocks = [...view.dom.querySelectorAll('.milkdown-code-block')]
  const index = domBlocks.indexOf(element)
  if (index < 0) return null
  const documentBlocks = []
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'code_block') documentBlocks.push({ node, pos })
    return true
  })
  return documentBlocks[index] || null
}

const insertMermaidBesideCodeBlock = (view, target, body) => {
  try {
    const type = view.state.schema.nodes.code_block
    const node = type.create(
      { language: 'mermaid' },
      body ? view.state.schema.text(body) : null
    )
    const tr = target.node.textContent.trim()
      ? view.state.tr.insert(target.pos + target.node.nodeSize, node)
      : view.state.tr.replaceWith(target.pos, target.pos + target.node.nodeSize, node)
    view.dispatch(tr.scrollIntoView())
    return true
  } catch {
    return false
  }
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
export function attachMdPasteHandler(view, parse, prepareRawMarkdownPaste, markUserEdit) {
  const onPaste = (event) => {
    // Browsers provide text/plain alongside text/html. Numbered headings and
    // divider-like prose in that fallback can resemble Markdown; keep the
    // structured HTML instead of flattening headings, marks and images.
    const plainText = event.clipboardData?.getData('text/plain') || ''
    const markdownText = event.clipboardData?.getData('text/markdown') || ''
    const text = markdownText || plainText
    const html = event.clipboardData?.getData('text/html') || ''
    const pastedMermaid = mermaidPaste(text)
    const codeBlockElement = event.target.closest?.('.milkdown-code-block')
    const targetCodeBlock = codeBlockAtDom(view, codeBlockElement)

    // CodeMirror owns paste inside code blocks. The old fallback waited for two
    // Mermaid headers to become one text node, then searched the whole source
    // for another header. That duplicated diagrams when a label happened to
    // contain a header-like phrase. Handle a real second Mermaid paste at the
    // DOM/PM block boundary instead: fill an empty block or insert one sibling.
    if (
      pastedMermaid &&
      targetCodeBlock &&
      String(targetCodeBlock.node.attrs.language || '').toLowerCase() === 'mermaid'
    ) {
      const hasExistingDiagram = !!targetCodeBlock.node.textContent.trim()
      const insertPos = hasExistingDiagram
        ? targetCodeBlock.pos + targetCodeBlock.node.nodeSize
        : targetCodeBlock.pos
      const cancelRawPaste = prepareRawMarkdownPaste?.({
        markdown: hasExistingDiagram
          ? `\n\n${pastedMermaid.markdown}`
          : pastedMermaid.markdown,
        from: insertPos,
        to: hasExistingDiagram
          ? insertPos
          : targetCodeBlock.pos + targetCodeBlock.node.nodeSize
      })
      markUserEdit?.()
      if (insertMermaidBesideCodeBlock(view, targetCodeBlock, pastedMermaid.body)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      } else {
        cancelRawPaste?.()
      }
      return
    }

    // Other code blocks retain normal CodeMirror paste semantics.
    if (targetCodeBlock || view.state.selection.$from.parent.type.name === 'code_block') return

    const structuredHtml = hasStructuredWebHtml(html)
    const shouldHandleRawMarkdown = text && looksLikeMarkdown(text) &&
      (markdownText || !structuredHtml || rawMarkdownCoversStructuredHtml(text, html))

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
    if (pastedMermaid) {
      const node = schema.nodes.code_block.create(
        { language: 'mermaid' },
        pastedMermaid.body ? schema.text(pastedMermaid.body) : null
      )
      cancelRawPaste = prepareRawMarkdownPaste?.({
        markdown: pastedMermaid.markdown,
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
      event.stopImmediatePropagation()
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
