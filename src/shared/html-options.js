export const HTML_THEMES = ['clean', 'paper', 'reading', 'night']
export const HTML_WIDTHS = ['compact', 'standard', 'wide', 'full']

export const DEFAULT_HTML_OPTIONS = Object.freeze({
  theme: 'clean',
  contentWidth: 'standard',
  fontSizePx: 17,
  lineHeight: 1.8,
  includeDocumentTitle: false,
  includeToc: false,
  tocDepth: 3,
  tocTitle: 'Contents'
})

const clamp = (value, min, max, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

export function normalizeHtmlOptions(options = {}) {
  return {
    theme: HTML_THEMES.includes(options.theme) ? options.theme : DEFAULT_HTML_OPTIONS.theme,
    contentWidth: HTML_WIDTHS.includes(options.contentWidth) ? options.contentWidth : DEFAULT_HTML_OPTIONS.contentWidth,
    fontSizePx: clamp(options.fontSizePx, 12, 24, DEFAULT_HTML_OPTIONS.fontSizePx),
    lineHeight: clamp(options.lineHeight, 1.4, 2.4, DEFAULT_HTML_OPTIONS.lineHeight),
    includeDocumentTitle: options.includeDocumentTitle === true,
    includeToc: options.includeToc === true,
    tocDepth: Math.round(clamp(options.tocDepth, 1, 6, DEFAULT_HTML_OPTIONS.tocDepth)),
    tocTitle: String(options.tocTitle || DEFAULT_HTML_OPTIONS.tocTitle).slice(0, 100)
  }
}

export function createHtmlOptions(tocTitle = DEFAULT_HTML_OPTIONS.tocTitle) {
  return normalizeHtmlOptions({ ...DEFAULT_HTML_OPTIONS, tocTitle })
}

