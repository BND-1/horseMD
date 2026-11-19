// Images in content copied from another document (user report 2026-11-19):
// a copy keeps the authored `assets/p.png`, and the document it is pasted
// into reads that path against its OWN folder, so every image broke. The
// copy carries its document's path (SOURCE_DOC_MIME); the paste finds the
// relative image references here, main copies the files into the target's
// ./assets (the rule for any image inserted from a local file) or rewrites
// the path when the file already lies inside the target's folder, and the
// pasted Markdown is rewritten at exactly those byte ranges, so the raw
// paste keeps every other byte.
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { isRelativePath } from '../components/editor-images.js'

export const SOURCE_DOC_MIME = 'application/x-horsemd-source'

const unescapeDestination = (raw) => raw.replace(/\\([!-/:-@[-`{-~])/g, '$1')

// A link destination starting at `j` in `text` (after `](` or `]:` and any
// blanks): `<…>` or a bare run with balanced parentheses.
function destinationAt(text, j) {
  if (text[j] === '<') {
    for (let k = j + 1; k < text.length; k++) {
      if (text[k] === '\\') { k++; continue }
      if (text[k] === '\n') return null
      if (text[k] === '>') return { start: j, end: k + 1, raw: text.slice(j + 1, k), angle: true }
    }
    return null
  }
  let depth = 0
  let k = j
  for (; k < text.length; k++) {
    const c = text[k]
    if (c === '\\') { k++; continue }
    if (/\s/.test(c)) break
    if (c === '(') depth++
    else if (c === ')') { if (depth === 0) break; depth-- }
  }
  return k > j ? { start: j, end: k, raw: text.slice(j, k), angle: false } : null
}

// The destination of a resource image / definition inside its source slice:
// the first `opener` whose destination reads back as the node's url (alt
// text and titles may hold the same characters).
function findDestination(source, from, to, opener, url) {
  const slice = source.slice(from, to)
  let fallback = null
  let count = 0
  for (let i = slice.indexOf(opener); i >= 0; i = slice.indexOf(opener, i + 1)) {
    let j = i + opener.length
    while (j < slice.length && /[ \t\n]/.test(slice[j])) j++
    const dest = destinationAt(slice, j)
    if (!dest) continue
    count++
    fallback = fallback || dest
    if (dest.raw === url || unescapeDestination(dest.raw) === url) {
      return { ...dest, start: from + dest.start, end: from + dest.end }
    }
  }
  // Character references in the destination: trust the only candidate.
  return count === 1 ? { ...fallback, start: from + fallback.start, end: from + fallback.end } : null
}

const IMG_SRC_RE = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
const decodeAttr = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

// Every relative image reference in `markdown`:
// { start, end, url, kind: 'md' | 'html', angle?, quote? } — start/end
// cover the destination as written (with its `<>` or quotes).
export function collectRelativeImageRefs(markdown) {
  const text = String(markdown || '')
  if (!/!\[|<img/i.test(text)) return []
  let tree
  try {
    tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  } catch {
    return []
  }
  const refs = []
  const imageIds = new Set()
  const definitions = []
  const walk = (node) => {
    const pos = node.position
    const from = pos?.start?.offset
    const to = pos?.end?.offset
    if (node.type === 'image' && Number.isInteger(from) && isRelativePath(node.url)) {
      const dest = findDestination(text, from, to, '](', node.url)
      if (dest) refs.push({ start: dest.start, end: dest.end, url: node.url, kind: 'md', angle: dest.angle })
    } else if (node.type === 'imageReference') {
      imageIds.add(node.identifier)
    } else if (node.type === 'definition') {
      definitions.push(node)
    } else if (node.type === 'html' && Number.isInteger(from)) {
      const slice = text.slice(from, to)
      for (const m of slice.matchAll(IMG_SRC_RE)) {
        const value = m[1] ?? m[2] ?? m[3]
        const url = decodeAttr(value)
        if (!isRelativePath(url)) continue
        const quote = m[1] != null ? '"' : m[2] != null ? "'" : ''
        const end = from + m.index + m[0].length
        refs.push({ start: end - value.length - quote.length * 2, end, url, kind: 'html', quote })
      }
    }
    if (Array.isArray(node.children)) node.children.forEach(walk)
  }
  walk(tree)
  for (const def of definitions) {
    const from = def.position?.start?.offset
    if (!imageIds.has(def.identifier) || !Number.isInteger(from) || !isRelativePath(def.url)) continue
    const dest = findDestination(text, from, def.position.end.offset, ']:', def.url)
    if (dest) refs.push({ start: dest.start, end: dest.end, url: def.url, kind: 'md', angle: dest.angle })
  }
  return refs.sort((a, b) => a.start - b.start)
}

const escapeAttr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

function spell(ref, url) {
  if (ref.kind === 'html') return `"${escapeAttr(url)}"`
  if (ref.angle || /[\s()<>]/.test(url)) return `<${url.replace(/[<>\\]/g, '\\$&')}>`
  return url
}

// `mapping` url → new url; references without an entry stay as written.
export function rewriteImageRefs(markdown, refs, mapping) {
  const text = String(markdown || '')
  let out = ''
  let cursor = 0
  for (const ref of refs) {
    const next = mapping[ref.url]
    if (!next || next === ref.url || ref.start < cursor) continue
    out += text.slice(cursor, ref.start) + spell(ref, next)
    cursor = ref.end
  }
  return out + text.slice(cursor)
}

const normDir = (path) => {
  if (!path) return null
  const norm = String(path).replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  const dir = i >= 0 ? norm.slice(0, i) : ''
  return /^[a-zA-Z]:/.test(dir) ? dir.toLowerCase() : dir
}

export function sameDocumentFolder(a, b) {
  const da = normDir(a)
  const db = normDir(b)
  return da != null && db != null && da === db
}

export function readSourceDocPath(clipboardData) {
  try {
    const raw = clipboardData?.getData?.(SOURCE_DOC_MIME)
    if (!raw) return null
    const path = JSON.parse(raw)?.docPath
    return typeof path === 'string' && path ? path : null
  } catch {
    return null
  }
}
