export const PANDOC_FORMATS = Object.freeze({
  docx: { extension: 'docx', label: 'Word' },
  epub: { extension: 'epub', label: 'EPUB' },
  latex: { extension: 'tex', label: 'LaTeX' },
  odt: { extension: 'odt', label: 'OpenDocument' },
  rtf: { extension: 'rtf', label: 'Rich Text' },
  mediawiki: { extension: 'wiki', label: 'MediaWiki', to: 'mediawiki' },
  // Pandoc cannot infer a writer from .txt (it wrote Markdown): `plain`.
  txt: { extension: 'txt', label: 'Plain Text', to: 'plain' }
})

export function parsePandocVersion(output = '') {
  const first = String(output).split(/\r?\n/, 1)[0].trim()
  const match = first.match(/^pandoc(?:\.exe)?\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

// Whether this Pandoc's gfm reader knows `$…$` math (`pandoc
// --list-extensions=gfm` lists "+tex_math_dollars" or "-tex_math_dollars").
// Pandoc 2.10 and older do not (#167: "The extension tex_math_dollars is not
// supported for gfm" — e.g. 2.9.2.1, Ubuntu 22.04's package); 2.11–2.18 list
// it off, 2.19+ on by default.
export function gfmSupportsMathDollars(listExtensionsOutput = '') {
  return /^[+-]tex_math_dollars\s*$/m.test(String(listExtensionsOutput))
}

// `to` names the writer when the extension alone doesn't (.wiki); the other
// formats keep Pandoc's choice by extension. `mathDollars` false (old Pandoc):
// plain gfm, formulas stay as text.
// resourceDirs: extra folders searched before the source folder (rendered
// figures); `delimiter` is path.delimiter of the running platform.
export function buildPandocArgs({ outputPath, sourceDir, to, mathDollars = true, resourceDirs = [], delimiter = ':' }) {
  const args = [mathDollars ? '--from=gfm+tex_math_dollars' : '--from=gfm', '--standalone', '--output', outputPath]
  if (to) args.push(`--to=${to}`)
  const dirs = [...resourceDirs, sourceDir].filter(Boolean)
  if (dirs.length) args.push(`--resource-path=${dirs.join(delimiter)}`)
  return args
}

export function summarizePandocStderr(output = '', limit = 4000) {
  const value = String(output).trim()
  if (!value) return null
  const maximum = Math.max(100, Number(limit) || 4000)
  return value.length > maximum ? `${value.slice(0, maximum)}…` : value
}
