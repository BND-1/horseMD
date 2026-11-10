
import { LEADING_SPACE_SENTINEL } from './lib/markdown-leading-space.js'
import { canonicalFreshTextToSource } from './lib/markdown-preservation/core.js'
import {
  compactGeneratedListSpacing,
  normalizeEmptyListItems,
  separateEmptyListStarts
} from './lib/markdown-preservation/lists.js'
import { withoutStandaloneEmptyBlockLines } from './lib/markdown-preservation/paragraphs.js'
import { normalizeEmptyTableCells } from './lib/markdown-preservation/tables.js'

const generatedListContentStart = (line) => {
  let offset = 0
  for (;;) {
    const rest = String(line || '').slice(offset)
    const leading = rest.match(/^[ \t]*/)?.[0] || ''
    offset += leading.length
    const afterLeading = String(line || '').slice(offset)
    const quote = afterLeading.match(/^>[ \t]*/)?.[0]
    if (quote) {
      offset += quote.length
      continue
    }
    const list = afterLeading.match(/^(?:[-+*]|\d{1,9}[.)])[ \t]+/)?.[0]
    if (list) {
      offset += list.length
      continue
    }
    return offset
  }
}

// In a complete generated document, `1\\.` / `1\\)` at the beginning of a
// top-level block or list/quote item body is not cosmetic serializer spelling:
// removing that backslash creates a real ordered-list marker. Inline occurrences
// later in the same paragraph remain safe to restore. Compare canonical and
// translated lines after their structural quote/list prefixes and put the escape
// back only for the exact same number+delimiter pair.
const preserveGeneratedOrderedLiteralEscapes = (canonical, translated) => {
  const canonicalLines = String(canonical || '').split('\n')
  const translatedLines = String(translated || '').split('\n')
  if (canonicalLines.length !== translatedLines.length) return translated
  return translatedLines.map((line, index) => {
    const canonicalLine = canonicalLines[index]
    const canonicalStart = generatedListContentStart(canonicalLine)
    const protectedMarker = canonicalLine.slice(canonicalStart)
      .match(/^(\d{1,9})\\([.)])(?=[ \t]|$)/)
    if (!protectedMarker) return line
    const translatedPrefix = canonicalFreshTextToSource(
      canonicalLine.slice(0, canonicalStart)
    )
    if (!line.startsWith(translatedPrefix)) return line
    const translatedStart = translatedPrefix.length
    const rawMarker = line.slice(translatedStart)
      .match(/^(\d{1,9})([.)])(?=[ \t]|$)/)
    if (
      !rawMarker ||
      rawMarker[1] !== protectedMarker[1] ||
      rawMarker[2] !== protectedMarker[2]
    ) return line
    const markerEnd = translatedStart + rawMarker[1].length
    return line.slice(0, markerEnd) + '\\' + line.slice(markerEnd)
  }).join('\n')
}

const preserveGeneratedEmptyTaskPlaceholder = (canonical) => String(canonical || '').replace(
  /^([ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]+)[ \t]*<br\s*\/?>[ \t]*$/gim,
  `$1${LEADING_SPACE_SENTINEL}`
)

import { withLiteralBlocksProtected } from './lib/literal-blocks.js'

export const generatedScratchMarkdown = (canonical) => withLiteralBlocksProtected(canonical, generatedScratchMarkdownUnprotected)

const generatedScratchMarkdownUnprotected = (canonical) => {
  // A brand-new document is authored entirely by rich typing; its canonical is
  // the only structural source. Serializer punctuation escapes outside proven
  // code/HTML literals therefore have no author-owned spelling to preserve:
  // restore the physical characters the user typed (for example
  // `\`\`\`你好\`\`\`` -> ```你好```) instead of leaking canonical escapes into
  // source mode. Milkdown may terminate the serialization with an extra blank
  // line (or the skeleton's empty-paragraph `<br />`). Neither is authored
  // content, so the generated source ends with exactly one final newline —
  // never a phantom trailing blank line.
  // A bare `- [ ] ` is not a GFM task item: remark reparses it as ordinary
  // bracket text and loses checked:false. Keep one invisible, source-owned
  // sentinel while the task paragraph is truly empty. The remark parser plugin
  // removes that exact sentinel before ProseMirror is built on reopen.
  const generatedCanonical = preserveGeneratedEmptyTaskPlaceholder(canonical)
  const normalized = separateEmptyListStarts(compactGeneratedListSpacing(
    withoutStandaloneEmptyBlockLines(
      normalizeEmptyListItems(normalizeEmptyTableCells(generatedCanonical))
    )
  ))
  return preserveGeneratedOrderedLiteralEscapes(
    normalized,
    canonicalFreshTextToSource(normalized)
  ).replace(/\r?\n+$/, '\n')
}

