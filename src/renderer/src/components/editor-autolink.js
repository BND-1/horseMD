// Unwrap GFM autolink-literal links that greedily swallowed non-URL text.
//
// remark-gfm's autolink-literal extends a `www.`/`http://` URL across non-ASCII
// text (Chinese, full-width punctuation, …) because its terminator set is ASCII
// punctuation only. So `www.caixuetang.cn，查看…1` becomes ONE giant bogus link
// whose URL contains raw non-ASCII chars (invalid in a real URL). When that
// round-trips to source it shows `[www.caixuetang.cn，…1](http://…1)` — the
// user's prose turned into a link.
//
// Fix: after remark-gfm runs, replace any link whose URL has non-ASCII chars
// with its own text children (i.e. unwrap it back to plain text). Valid ASCII
// autolinks (`www.example.com`) keep an ASCII URL → untouched. This is a parse-
// side remark plugin (runs in remarkPluginsCtx, after preset-gfm).
const NONASCII = /[^\x00-\x7F]/

function unwrapNonAsciiLinks(node) {
  if (!node || !Array.isArray(node.children)) return
  const next = []
  for (const child of node.children) {
    if (child.type === 'link' && NONASCII.test(child.url || '')) {
      // Splice the link's text children back into the parent as plain text.
      const kids = child.children && child.children.length
        ? child.children
        : [{ type: 'text', value: child.url }]
      for (const k of kids) { unwrapNonAsciiLinks(k); next.push(k) }
    } else {
      unwrapNonAsciiLinks(child)
      next.push(child)
    }
  }
  node.children = next
}

export function remarkUnwrapNonAsciiAutolinks() {
  return (tree) => unwrapNonAsciiLinks(tree)
}
