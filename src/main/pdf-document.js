import {
  DEFAULT_PDF_OPTIONS,
  normalizePdfOptions
} from '../shared/pdf-options.js'
import { buildPdfPrintStyles } from './pdf-print-styles.js'

const PAGE_DIMENSIONS_MM = Object.freeze({
  A4: [210, 297],
  A3: [297, 420],
  Letter: [215.9, 279.4]
})

export { DEFAULT_PDF_OPTIONS, normalizePdfOptions }

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

export function resolvePdfPage(options = {}) {
  const normalized = normalizePdfOptions(options)
  let [width, height] = normalized.pageSize === 'Custom'
    ? [normalized.customWidth, normalized.customHeight]
    : PAGE_DIMENSIONS_MM[normalized.pageSize]
  if (normalized.orientation === 'landscape') [width, height] = [height, width]
  return {
    ...normalized,
    width,
    height,
    printPageSize: {
      // Electron printToPDF custom Size values are inches.
      width: Number((width / 25.4).toFixed(4)),
      height: Number((height / 25.4).toFixed(4))
    }
  }
}

export function buildPdfCss(options = {}) {
  const page = resolvePdfPage(options)
  return buildPdfPrintStyles(page)
}

const normalizeHeadings = (headings, depth) => (Array.isArray(headings) ? headings : [])
  .map((heading, index) => ({
    id: String(heading?.id || `hm-pdf-heading-${index + 1}`),
    level: Math.min(6, Math.max(1, Number(heading?.level) || 1)),
    text: String(heading?.text || '').trim()
  }))
  .filter((heading) => heading.text && heading.level <= depth)

export function buildPdfToc(headings, options = {}) {
  const page = normalizePdfOptions(options)
  if (!page.includeToc) return ''
  const items = normalizeHeadings(headings, page.tocDepth)
  if (!items.length) return ''
  const root = { level: 0, children: [] }
  const stack = [root]
  for (const heading of items) {
    while (stack.length > 1 && stack.at(-1).level >= heading.level) stack.pop()
    const node = { ...heading, children: [] }
    stack.at(-1).children.push(node)
    stack.push(node)
  }
  const render = (nodes) => `<ol>${nodes.map((node) => (
    `<li><a href="#${escapeHtml(node.id)}">${escapeHtml(node.text)}</a>${node.children.length ? render(node.children) : ''}</li>`
  )).join('')}</ol>`
  return `<nav class="pdf-toc${page.tocPageBreak ? ' break-after' : ''}"><h1>${escapeHtml(page.tocTitle)}</h1>${render(root.children)}</nav>`
}

export function buildPdfDocument(source, options = {}) {
  const payload = typeof source === 'string' ? { html: source, headings: [], title: '' } : source || {}
  const page = normalizePdfOptions(options)
  const title = page.documentTitle || payload.title || 'HorseMD'
  const css = buildPdfCss(page)
  const toc = buildPdfToc(payload.headings, page)
  const csp = "default-src 'none'; img-src data: file: https: http:; style-src 'unsafe-inline'; font-src data: file:;"
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${toc}<main class="doc">${payload.html || ''}</main></body></html>`
}

const templateStyle = 'font-size:8px;color:#777;width:100%;padding:0 12mm;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:flex;justify-content:space-between;gap:12px;'

export function buildPdfHeaderFooter(options = {}) {
  const page = normalizePdfOptions(options)
  const title = escapeHtml(page.documentTitle)
  const headerLeft = [page.includeTitle ? title : '', page.headerText ? escapeHtml(page.headerText) : '']
    .filter(Boolean)
    .join(' · ')
  const headerRight = page.includeDate ? '<span class="date"></span>' : ''
  const footerLeft = page.footerText ? escapeHtml(page.footerText) : ''
  const footerRight = page.includePageNumbers
    ? '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>'
    : ''
  const headerTemplate = page.headerEnabled
    ? `<div style="${templateStyle}"><span>${headerLeft}</span>${headerRight}</div>`
    : '<span></span>'
  const footerTemplate = page.footerEnabled
    ? `<div style="${templateStyle}"><span>${footerLeft}</span>${footerRight}</div>`
    : '<span></span>'
  return {
    displayHeaderFooter: page.headerEnabled || page.footerEnabled,
    headerTemplate,
    footerTemplate
  }
}
