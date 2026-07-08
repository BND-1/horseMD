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

function trimNonAsciiLinks(node) {
  if (!node || !Array.isArray(node.children)) return
  const next = []
  for (const child of node.children) {
    if (child.type === 'link' && NONASCII.test(child.url || '')) {
      for (const repl of replacementForBadLink(child)) { trimNonAsciiLinks(repl); next.push(repl) }
    } else {
      trimNonAsciiLinks(child)
      next.push(child)
    }
  }
  node.children = next
}

export function remarkUnwrapNonAsciiAutolinks() {
  return (tree) => trimNonAsciiLinks(tree)
}
