// The rich→source sync verifies one candidate several times — reprint escape
// levels, the owner validator, the flush check, the trace shadow — and each
// called Milkdown's parser on the same string: a full parse, ~0.3 s per call
// on a 250 KB Yuque export (≈1 s+ on a slow Windows laptop). Parsing is pure
// and ProseMirror nodes are immutable, so the last few results are reused.
export function memoizeLastParses(parse, size = 3) {
  const entries = []
  const memo = (markdown) => {
    if (typeof markdown !== 'string') return parse(markdown)
    const hit = entries.findIndex((entry) => entry.markdown === markdown)
    if (hit >= 0) {
      const [entry] = entries.splice(hit, 1)
      entries.unshift(entry)
      return entry.doc
    }
    const doc = parse(markdown)
    entries.unshift({ markdown, doc })
    if (entries.length > size) entries.length = size
    return doc
  }
  // Record a parse made elsewhere from the same remark (mdast → ParserState).
  memo.prime = (markdown, doc) => {
    if (typeof markdown !== 'string' || !doc) return
    const hit = entries.findIndex((entry) => entry.markdown === markdown)
    if (hit >= 0) entries.splice(hit, 1)
    entries.unshift({ markdown, doc })
    if (entries.length > size) entries.length = size
  }
  memo.unmemoized = parse
  return memo
}
