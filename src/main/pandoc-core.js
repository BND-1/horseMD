export const PANDOC_FORMATS = Object.freeze({
  docx: { extension: 'docx', label: 'Word' },
  epub: { extension: 'epub', label: 'EPUB' },
  latex: { extension: 'tex', label: 'LaTeX' },
  odt: { extension: 'odt', label: 'OpenDocument' },
  rtf: { extension: 'rtf', label: 'Rich Text' },
  mediawiki: { extension: 'wiki', label: 'MediaWiki', to: 'mediawiki' },
  txt: { extension: 'txt', label: 'Plain Text' }
})

export function parsePandocVersion(output = '') {
  const first = String(output).split(/\r?\n/, 1)[0].trim()
  const match = first.match(/^pandoc(?:\.exe)?\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

// `to` names the writer when the extension alone doesn't (.wiki); the other
// formats keep Pandoc's choice by extension.
export function buildPandocArgs({ outputPath, sourceDir, to }) {
  const args = ['--from=gfm+tex_math_dollars', '--standalone', '--output', outputPath]
  if (to) args.push(`--to=${to}`)
  if (sourceDir) args.push(`--resource-path=${sourceDir}`)
  return args
}

export function summarizePandocStderr(output = '', limit = 4000) {
  const value = String(output).trim()
  if (!value) return null
  const maximum = Math.max(100, Number(limit) || 4000)
  return value.length > maximum ? `${value.slice(0, maximum)}…` : value
}
