// Pandoc reads the Markdown source, so a ```mermaid block, a ```svg block, an
// inline <svg> or an .svg image reached Word / ODT / EPUB / RTF / LaTeX as
// code (or not at all: Word without rsvg-convert, RTF takes only PNG/JPEG).
// Typora puts the rendered diagrams into those exports. Here the renderer
// finds those figures and their exact source ranges and turns each into an
// SVG image (`data:` URL, scripts dropped, intrinsic size); main rasterizes
// them to PNG and replaces only the ones that rendered (pandoc-figures.js in
// main). The Markdown itself is never changed.
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { svgCodeImage } from '../components/editor-html.js'
import { renderMermaidForExport } from '../components/editor-mermaid.js'

// Formats whose files embed images (LaTeX: main writes them beside the .tex).
export const PANDOC_FIGURE_FORMATS = new Set(['docx', 'odt', 'epub', 'rtf', 'latex'])
const MAX_FIGURES = 200
const SVG_SOURCE_RE = /^\s*<svg\b[\s\S]*<\/svg>\s*$/i

const startOf = (node) => node?.position?.start?.offset
const endOf = (node) => node?.position?.end?.offset

// width / height when the SVG gives none (Mermaid: width="100%" and a
// max-width style): max-width or the viewBox.
function fallbackSize(src) {
  try {
    const text = decodeURIComponent(String(src).replace(/^data:image\/svg\+xml;charset=utf-8,/, ''))
    const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement
    const box = String(svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
    const ratio = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0 ? box[3] / box[2] : null
    const maxWidth = Number((/max-width:\s*([\d.]+)px/i.exec(svg.getAttribute('style') || '') || [])[1])
    if (maxWidth > 0 && ratio) return { width: maxWidth, height: maxWidth * ratio }
    if (ratio) return { width: box[2], height: box[3] }
  } catch {
    // not parseable: no size
  }
  return null
}

function toFigure(image) {
  if (!image?.src) return null
  const size = image.width && image.height ? { width: image.width, height: image.height } : fallbackSize(image.src)
  if (!size) return null
  return { src: image.src, width: Math.round(size.width), height: Math.round(size.height) }
}

const isLocalSvgPath = (url) => /\.svg(?:[?#].*)?$/i.test(url) && !/^(?:https?:|data:)/i.test(url)

function resolveLocalPath(url, sourcePath) {
  let path = String(url).replace(/[?#].*$/, '')
  try { path = decodeURI(path) } catch { /* keep as written */ }
  if (/^file:\/\//i.test(path)) {
    path = path.replace(/^file:\/\//i, '')
    if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1)
    return path
  }
  if (/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(path)) return path
  if (!sourcePath) return null
  const dir = sourcePath.replace(/[\\/][^\\/]*$/, '')
  const sep = sourcePath.includes('\\') && !sourcePath.includes('/') ? '\\' : '/'
  return `${dir}${sep}${path.replace(/^\.[\\/]/, '')}`
}

/**
 * markdown → [{ start, end, alt, title, src, width, height }] in source order.
 * Figures that cannot be rendered (invalid Mermaid, unreadable file, not one
 * <svg>) are left out: their source stays as written.
 */
export async function collectPandocFigures(markdown, { format, sourcePath = null, readFile = null } = {}) {
  if (!PANDOC_FIGURE_FORMATS.has(format)) return []
  const source = String(markdown || '')
  if (!/```|~~~|<svg|\.svg/i.test(source)) return []
  let tree
  try {
    tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(source)
  } catch {
    return []
  }
  const found = []
  const walk = (node) => {
    if (found.length >= MAX_FIGURES) return
    const start = startOf(node)
    const end = endOf(node)
    if (Number.isInteger(start) && Number.isInteger(end)) {
      const lang = String(node.lang || '').toLowerCase()
      if (node.type === 'code' && (lang === 'mermaid' || lang === 'svg')) {
        found.push({ kind: lang, start, end, code: node.value || '' })
        return
      }
      // An <svg> alone in its paragraph (or an HTML block): GFM splits it
      // into inline html nodes, so test the paragraph's source as a whole.
      if ((node.type === 'paragraph' || node.type === 'html') && SVG_SOURCE_RE.test(source.slice(start, end))) {
        found.push({ kind: 'svg', start, end, code: source.slice(start, end) })
        return
      }
      if (node.type === 'image' && isLocalSvgPath(node.url || '')) {
        found.push({ kind: 'file', start, end, url: node.url, alt: node.alt || '', title: node.title || '' })
        return
      }
    }
    for (const child of node.children || []) walk(child)
  }
  walk(tree)

  const figures = []
  for (const item of found) {
    let image = null
    try {
      if (item.kind === 'mermaid') {
        const svg = await renderMermaidForExport(item.code, { theme: 'default' })
        image = svg ? svgCodeImage(svg) : null
      } else if (item.kind === 'svg') {
        image = svgCodeImage(item.code)
      } else if (item.kind === 'file' && readFile) {
        const path = resolveLocalPath(item.url, sourcePath)
        const file = path ? await readFile(path) : null
        image = file?.content ? svgCodeImage(file.content) : null
      }
    } catch {
      image = null
    }
    const figure = toFigure(image)
    if (!figure) continue
    figures.push({ start: item.start, end: item.end, alt: item.alt || '', title: item.title || '', ...figure })
  }
  return figures
}
