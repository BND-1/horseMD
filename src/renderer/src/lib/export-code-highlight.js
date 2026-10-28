// Syntax colours for code blocks in PDF / HTML export. The export rebuilds
// each block from the full ProseMirror text (CodeMirror only paints the
// visible lines), which dropped the editor's highlighting: every block came
// out black. Same parser as the editor (@codemirror/language-data) and the
// same colours (Crepe's oneDark highlight style), as inline styles so both
// templates show them. Text without a token style keeps the export's own
// code colour (the editor's #abb2bf would be faint on white paper).
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightTree, tagHighlighter } from '@lezer/highlight'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'

const MAX_CODE_LENGTH = 200000
const ALIASES = { svg: 'xml', vue: 'vue', sh: 'shell', zsh: 'shell' }

// oneDark paints plain identifiers ivory (#abb2bf) and invalid tokens white:
// unreadable on paper, so those keep the default colour.
const SKIP_COLORS = new Set(['#abb2bf', '#ffffff'])
const toCss = (spec) => {
  const out = []
  if (spec.color && !SKIP_COLORS.has(String(spec.color).toLowerCase())) out.push(`color:${spec.color}`)
  if (spec.fontWeight) out.push(`font-weight:${spec.fontWeight}`)
  if (spec.fontStyle) out.push(`font-style:${spec.fontStyle}`)
  if (spec.textDecoration) out.push(`text-decoration:${spec.textDecoration}`)
  return out.join(';')
}
// One class per oneDark rule; the style of a token is its rules' CSS joined.
const STYLES = oneDarkHighlightStyle.specs.map(toCss)
const HIGHLIGHTER = tagHighlighter(oneDarkHighlightStyle.specs.map((spec, index) => ({ tag: spec.tag, class: `s${index}` })))
const styleOf = (classes) => classes.split(' ').map((name) => STYLES[Number(name.slice(1))]).filter(Boolean).join(';')

const parserCache = new Map()
async function parserFor(language) {
  const name = String(language || '').trim().toLowerCase()
  if (!name) return null
  const key = ALIASES[name] || name
  if (parserCache.has(key)) return parserCache.get(key)
  let parser = null
  try {
    const description = LanguageDescription.matchLanguageName(languages, key, true)
    const support = description ? (description.support || await description.load()) : null
    parser = support?.language?.parser || null
  } catch {
    parser = null
  }
  parserCache.set(key, parser)
  return parser
}

/**
 * Code text → lines of [text, style] segments (style '' = default colour),
 * or null when the language is unknown / has no parser (the block stays as
 * plain text, as before).
 */
export async function highlightCodeLines(text, language) {
  const code = String(text || '')
  if (!code || code.length > MAX_CODE_LENGTH) return null
  const parser = await parserFor(language)
  if (!parser) return null
  let tree
  try {
    tree = parser.parse(code)
  } catch {
    return null
  }
  const lines = [[]]
  const push = (from, to, style) => {
    const parts = code.slice(from, to).split('\n')
    parts.forEach((part, index) => {
      if (index > 0) lines.push([])
      if (part) lines[lines.length - 1].push([part, style])
    })
  }
  let at = 0
  highlightTree(tree, HIGHLIGHTER, (from, to, classes) => {
    if (from > at) push(at, from, '')
    push(from, to, styleOf(classes))
    at = to
  })
  if (at < code.length) push(at, code.length, '')
  return lines
}
