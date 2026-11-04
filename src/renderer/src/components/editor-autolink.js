import { Plugin } from '@milkdown/prose/state'

// Trim GFM autolink-literal links that greedily swallowed non-URL text.
//
// remark-gfm's autolink-literal extends a `www.`/`http://` URL across non-ASCII
// text (Chinese, full-width punctuation, …) because its terminator set is ASCII
// punctuation only. So `www.caixuetang.cn，查看…1` becomes ONE giant bogus link
// whose URL contains raw non-ASCII chars — and the whole sentence shows as a
// `[text](url)` link in source mode.
//
// Fix: for a link whose URL has non-ASCII chars, TRIM it back to its valid ASCII
// prefix (the real domain, e.g. `www.caixuetang.cn`) — kept as a normal blue
// link — and emit the trailing non-ASCII text as a plain-text sibling. So the
// domain stays clickable, the prose after it is plain text. Degenerate case
// (the domain itself is non-ASCII, e.g. `http://例え.jp`) → unwrap to plain text.
//
// Valid ASCII autolinks (`www.example.com`) have an ASCII URL → untouched.
// Parse-side remark plugin, appended to remarkPluginsCtx so it runs AFTER
// preset-gfm.
const NONASCII = /[^\x00-\x7F]/
const AUTOLINKISH = /^(https?:\/\/|www\.)/i

// nodes to splice in place of a bad link
function replacementForBadLink(node) {
  const url = node.url || ''
  const kids = node.children || []
  const singleText = kids.length === 1 && kids[0].type === 'text' ? kids[0].value : null
  if (singleText == null) {
    // Complex children (formatted text inside the link) — unwrap as-is.
    return kids.length ? kids : [{ type: 'text', value: url }]
  }
  const uCut = url.search(NONASCII)
  const tCut = singleText.search(NONASCII)
  const asciiUrl = uCut >= 0 ? url.slice(0, uCut) : url
  const asciiText = tCut >= 0 ? singleText.slice(0, tCut) : singleText
  const leftover = tCut >= 0 ? singleText.slice(tCut) : ''
  // Keep the trimmed link only if its ASCII prefix is a real domain (a '.' after
  // the scheme). Else the domain itself was non-ASCII → unwrap to plain text.
  const domainish = asciiUrl.replace(/^https?:\/\//, '')
  if (asciiUrl && domainish.includes('.') && asciiText) {
    const out = [{ type: 'link', url: asciiUrl, children: [{ type: 'text', value: asciiText }] }]
    if (leftover) out.push({ type: 'text', value: leftover })
    return out
  }
  return [{ type: 'text', value: singleText }]
}

// Only GFM autolink LITERALS (bare `www.x` / `https://x` in prose) can have
// swallowed text. An authored `[文字](https://zh.wikipedia.org/wiki/马)` or
// `<https://…>` is the user's own link and must stay one — it used to be
// unwrapped to plain text in the editor. A literal starts with its URL in the
// source; without the source, its text is its URL (www. gets http:// added).
function isAutolinkLiteral(link, source) {
  const offset = link.position?.start?.offset
  if (typeof source === 'string' && Number.isInteger(offset)) {
    // mdast offsets skip a BOM that file.value still holds.
    const first = source[offset + (source.charCodeAt(0) === 0xfeff ? 1 : 0)]
    if (first !== undefined) return first !== '[' && first !== '<'
  }
  const kids = link.children || []
  const text = kids.length === 1 && kids[0].type === 'text' ? kids[0].value : null
  const url = link.url || ''
  return text != null && (url === text || url === `http://${text}` || url === `https://${text}`)
}

function trimNonAsciiLinks(node, source) {
  if (!node || !Array.isArray(node.children)) return
  const next = []
  for (const child of node.children) {
    if (child.type === 'link' && AUTOLINKISH.test(child.url || '') && NONASCII.test(child.url || '') && isAutolinkLiteral(child, source)) {
      for (const repl of replacementForBadLink(child)) { trimNonAsciiLinks(repl, source); next.push(repl) }
    } else {
      trimNonAsciiLinks(child, source)
      next.push(child)
    }
  }
  node.children = next
}

export function remarkUnwrapNonAsciiAutolinks() {
  return (tree, file) => trimNonAsciiLinks(tree, typeof file?.value === 'string' ? file.value : String(file?.value ?? ''))
}

// Typing `<https://example.com>` (Typora behavior): the closing `>` turns the
// bracketed URL into a link whose text is the URL, which Markdown spells back
// as the same `<https://example.com>` autolink. Left as plain text it could
// only be saved with escapes (`\<https://example.com\>`).
const ANGLE_AUTOLINK = /<((?:https?|ftp):\/\/[^\s<>]+|mailto:[^\s<>]+)$/i

export function createAngleAutolinkInputPlugin() {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== '>' || from !== to) return false
        const { state } = view
        const link = state.schema.marks.link
        const $from = state.doc.resolve(from)
        if (!link || !$from.parent.isTextblock || $from.parent.type.spec.code) return false
        if (!$from.parent.type.allowsMarkType(link)) return false
        const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 500), $from.parentOffset, null, '\uFFFC')
        const match = ANGLE_AUTOLINK.exec(before)
        if (!match) return false
        const start = from - match[0].length
        // Only plain typed text: never rewrap an existing link or inline code.
        let plain = true
        state.doc.nodesBetween(start, from, (node) => {
          if (node.isText && node.marks.some((mark) => mark.type === link || mark.type.spec.code)) plain = false
        })
        if (!plain) return false
        const url = match[1]
        const marks = $from.marks().filter((mark) => mark.type !== link)
        view.dispatch(
          state.tr
            .replaceWith(start, from, state.schema.text(url, [...marks, link.create({ href: url })]))
            .removeStoredMark(link)
        )
        return true
      }
    }
  })
}
