const PAGE_DIMENSIONS_MM = Object.freeze({
  A4: [210, 297],
  A3: [297, 420],
  Letter: [215.9, 279.4]
})

const PAGINATION_VALUES = new Set(['none', 'h1', 'h2', 'h3', 'hr'])

export const DEFAULT_PDF_OPTIONS = Object.freeze({
  pageSize: 'A4',
  orientation: 'portrait',
  pagination: 'none',
  customWidth: 210,
  customHeight: 297
})

function clampDimension(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(1000, Math.max(50, number)) : fallback
}

export function normalizePdfOptions(options = {}) {
  const pageSize = Object.hasOwn(PAGE_DIMENSIONS_MM, options.pageSize) || options.pageSize === 'Custom'
    ? options.pageSize
    : DEFAULT_PDF_OPTIONS.pageSize
  return {
    pageSize,
    orientation: options.orientation === 'landscape' ? 'landscape' : 'portrait',
    pagination: PAGINATION_VALUES.has(options.pagination) ? options.pagination : 'none',
    customWidth: clampDimension(options.customWidth, DEFAULT_PDF_OPTIONS.customWidth),
    customHeight: clampDimension(options.customHeight, DEFAULT_PDF_OPTIONS.customHeight)
  }
}

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
      // Electron printToPDF custom Size values are inches (unlike the native
      // print API, whose similarly named structure uses microns).
      width: Number((width / 25.4).toFixed(4)),
      height: Number((height / 25.4).toFixed(4))
    }
  }
}

function paginationCss(pagination) {
  if (/^h[1-3]$/.test(pagination)) {
    return `.doc ${pagination}:not(:first-child) { break-before: page; page-break-before: always; }`
  }
  if (pagination === 'hr') {
    return '.doc hr { border: 0; margin: 0; height: 0; break-after: page; page-break-after: always; }'
  }
  return ''
}

// Print stylesheet for PDF export: a clean, warm reading layout.
const BASE_PDF_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .doc {
    font-family: 'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Hiragino Sans GB',
      'Source Han Sans SC', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
    font-size: 14.5px; line-height: 1.75; color: #2a2620;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
    word-wrap: break-word;
  }
  .doc > :first-child { margin-top: 0 !important; }
  .doc h1, .doc h2, .doc h3, .doc h4, .doc h5, .doc h6 {
    color: #16130e; font-weight: 700; line-height: 1.3; margin: 1.6em 0 0.6em;
    page-break-after: avoid;
  }
  .doc h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 2px solid #e6e1d8; letter-spacing: -0.01em; }
  .doc h2 { font-size: 1.5em; padding-bottom: 0.2em; border-bottom: 1px solid #ece7de; }
  .doc h3 { font-size: 1.25em; }
  .doc h4 { font-size: 1.05em; }
  .doc h5 { font-size: 1em; }
  .doc h6 { font-size: 0.92em; color: #6b655c; }
  .doc p { margin: 0.85em 0; }
  .doc a { color: #c86b35; text-decoration: none; border-bottom: 1px solid rgba(200,107,53,.35); }
  .doc strong { font-weight: 700; color: #16130e; }
  .doc em { font-style: italic; }
  .doc ul, .doc ol { margin: 0.8em 0; padding-left: 1.6em; }
  .doc li { margin: 0.32em 0; }
  .doc li::marker { color: #c86b35; }
  .doc blockquote {
    margin: 1em 0; padding: 0.5em 1.1em; border-left: 3px solid #c86b35;
    background: rgba(200,107,53,.06); color: #6b655c; border-radius: 0 6px 6px 0;
    page-break-inside: avoid;
  }
  .doc blockquote p { margin: 0.3em 0; }
  .doc code {
    font-family: 'SF Mono', SFMono-Regular, Consolas, Monaco, monospace; font-size: 0.88em;
    background: #f4f1ea; padding: 0.12em 0.4em; border-radius: 4px; color: #b3431f;
  }
  .doc pre {
    background: #f4f1ea; border: 1px solid #e6e1d8; border-radius: 8px;
    padding: 14px 16px; margin: 1em 0; overflow: hidden; page-break-inside: avoid;
  }
  .doc pre code {
    background: none; padding: 0; color: #2a2620; font-size: 0.86em; line-height: 1.6;
    white-space: pre-wrap; word-break: break-word;
  }
  .doc table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.95em; page-break-inside: avoid; }
  .doc th, .doc td { border: 1px solid #e6e1d8; padding: 8px 12px; text-align: left; vertical-align: top; }
  .doc th { background: #f4f1ea; font-weight: 700; color: #16130e; }
  .doc tr:nth-child(even) td { background: #faf8f4; }
  .doc img { max-width: 100%; height: auto; border-radius: 6px; display: block; margin: 1em auto; page-break-inside: avoid; }
  .doc hr { border: none; border-top: 1px solid #e6e1d8; margin: 1.8em 0; }
  .doc input[type="checkbox"] { margin-right: 0.4em; }
`

export function buildPdfCss(options = {}) {
  const page = resolvePdfPage(options)
  return `@page { size: ${page.width}mm ${page.height}mm; margin: 20mm 18mm; }\n${BASE_PDF_CSS}\n${paginationCss(page.pagination)}`
}

export const PDF_CSS = buildPdfCss(DEFAULT_PDF_OPTIONS)

export function buildPdfDocument(html, options = {}) {
  const css = buildPdfCss(options)
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="doc">${html}</div></body></html>`
}
