export const PDF_PAGE_SIZES = ['A4', 'A3', 'Letter', 'Custom']
export const PDF_PAGINATION = ['none', 'h1', 'h2', 'h3', 'hr']
export const PDF_MARGIN_PRESETS = ['normal', 'narrow', 'wide', 'custom']

export const DEFAULT_PDF_OPTIONS = Object.freeze({
  pageSize: 'A4',
  orientation: 'portrait',
  marginPreset: 'normal',
  margins: Object.freeze({ top: 20, right: 18, bottom: 20, left: 18 }),
  customWidth: 210,
  customHeight: 297,
  scale: 100,
  pagination: 'none',
  includeToc: false,
  tocTitle: 'Contents',
  tocDepth: 3,
  tocPageBreak: true,
  generateOutline: true,
  pageRanges: '',
  documentTitle: '',
  headerEnabled: false,
  headerText: '',
  includeTitle: true,
  includeDate: true,
  footerEnabled: true,
  footerText: '',
  includePageNumbers: true
})

const clamp = (value, min, max, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

const marginForPreset = (preset) => {
  if (preset === 'narrow') return { top: 10, right: 10, bottom: 10, left: 10 }
  if (preset === 'wide') return { top: 25, right: 30, bottom: 25, left: 30 }
  return { top: 20, right: 18, bottom: 20, left: 18 }
}

export function normalizePageRanges(value = '') {
  const input = String(value || '').trim()
  if (!input) return ''
  const ranges = input.split(',').map((part) => part.trim()).filter(Boolean)
  if (!ranges.length) return ''
  const normalized = ranges.map((part) => {
    const match = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/)
    if (!match) throw new Error('invalid-page-range')
    const from = Number(match[1])
    const to = Number(match[2] || match[1])
    if (from < 1 || to < from) throw new Error('invalid-page-range')
    return from === to ? String(from) : `${from}-${to}`
  })
  return normalized.join(', ')
}

export function normalizePdfOptions(options = {}) {
  const pageSize = PDF_PAGE_SIZES.includes(options.pageSize) ? options.pageSize : DEFAULT_PDF_OPTIONS.pageSize
  const marginPreset = PDF_MARGIN_PRESETS.includes(options.marginPreset)
    ? options.marginPreset
    : DEFAULT_PDF_OPTIONS.marginPreset
  const presetMargins = marginForPreset(marginPreset)
  const suppliedMargins = marginPreset === 'custom' ? options.margins || {} : presetMargins
  return {
    pageSize,
    orientation: options.orientation === 'landscape' ? 'landscape' : 'portrait',
    marginPreset,
    margins: {
      top: clamp(suppliedMargins.top, 0, 100, presetMargins.top),
      right: clamp(suppliedMargins.right, 0, 100, presetMargins.right),
      bottom: clamp(suppliedMargins.bottom, 0, 100, presetMargins.bottom),
      left: clamp(suppliedMargins.left, 0, 100, presetMargins.left)
    },
    customWidth: clamp(options.customWidth, 50, 1000, DEFAULT_PDF_OPTIONS.customWidth),
    customHeight: clamp(options.customHeight, 50, 1000, DEFAULT_PDF_OPTIONS.customHeight),
    scale: clamp(options.scale, 50, 200, DEFAULT_PDF_OPTIONS.scale),
    pagination: PDF_PAGINATION.includes(options.pagination) ? options.pagination : DEFAULT_PDF_OPTIONS.pagination,
    includeToc: options.includeToc === true,
    tocTitle: String(options.tocTitle || DEFAULT_PDF_OPTIONS.tocTitle).slice(0, 100),
    tocDepth: Math.round(clamp(options.tocDepth, 1, 6, DEFAULT_PDF_OPTIONS.tocDepth)),
    tocPageBreak: options.tocPageBreak !== false,
    generateOutline: options.generateOutline !== false,
    pageRanges: normalizePageRanges(options.pageRanges),
    documentTitle: String(options.documentTitle || '').slice(0, 300),
    headerEnabled: options.headerEnabled === true,
    headerText: String(options.headerText || '').slice(0, 300),
    includeTitle: options.includeTitle !== false,
    includeDate: options.includeDate === true,
    footerEnabled: options.footerEnabled !== false,
    footerText: String(options.footerText || '').slice(0, 300),
    includePageNumbers: options.includePageNumbers !== false
  }
}

export function createPdfOptions(title = '', tocTitle = DEFAULT_PDF_OPTIONS.tocTitle) {
  return normalizePdfOptions({ ...DEFAULT_PDF_OPTIONS, documentTitle: title, tocTitle })
}
