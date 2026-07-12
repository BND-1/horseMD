import { toString as mdastToString } from 'mdast-util-to-string'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { textareaOffsetY } from './textarea-metrics.js'
// Parse source headings with CommonMark semantics so source and rich outlines
// agree on fenced code, Setext headings, escaping and inline formatting. Cache
// the last immutable textarea value: source scrollspy calls this repeatedly and
// a 100k+ document must not be reparsed on every scroll event.
const sourceHeadingParser = unified().use(remarkParse)
let cachedHeadingMarkdown = null
let cachedSourceHeadings = []

export function parseSourceHeadings(md) {
  if (!md) return []
  if (md === cachedHeadingMarkdown) return cachedSourceHeadings
  const out = []
  try {
    const tree = sourceHeadingParser.parse(md)
    const walk = (node) => {
      if (node.type === 'heading' && Number.isFinite(node.position?.start?.offset)) {
        out.push({
          level: node.depth,
          text: mdastToString(node).trim(),
          charOffset: node.position.start.offset
        })
      } else if (node.type === 'html' && Number.isFinite(node.position?.start?.offset)) {
        const html = String(node.value || '').match(/^\s*<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>\s*$/i)
        if (html) {
          out.push({
            level: Number(html[1]),
            text: html[2].replace(/<[^>]+>/g, '').trim(),
            charOffset: node.position.start.offset
          })
        }
      }
      node.children?.forEach(walk)
    }
    walk(tree)
    out.sort((a, b) => a.charOffset - b.charOffset)
  } catch {
    // Keep source mode usable for temporarily malformed text while typing.
  }
  cachedHeadingMarkdown = md
  cachedSourceHeadings = out
  return cachedSourceHeadings
}

// Scroll the SOURCE textarea to a heading by text (via char-ratio). Used by the
// source-mode outline jump (#40). Returns true on success.
export function scrollSourceToHeading(textarea, md, heading) {
  if (!textarea || !md || !heading) return false
  const charOffset = typeof heading === 'object' && Number.isFinite(heading.charOffset)
    ? heading.charOffset
    : parseSourceHeadings(md).find((item) => item.text === heading)?.charOffset
  if (!Number.isFinite(charOffset)) return false
  const denom = textarea.scrollHeight - textarea.clientHeight
  try {
    textarea.scrollTop = textareaOffsetY(textarea, charOffset)
  } catch {
    if (denom > 0) textarea.scrollTop = (charOffset / md.length) * denom
  }
  return true
}
