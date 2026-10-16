import { sourceVisibleIndex } from '../mode-visible-map.js'

const markdownLines = (value) => {
  const source = String(value || '')
  const lines = []
  let start = 0
  for (let index = 0; index <= source.length; index += 1) {
    if (index < source.length && source[index] !== '\n' && source[index] !== '\r') continue
    const end = index
    let eol = ''
    if (index < source.length) {
      if (source[index] === '\r' && source[index + 1] === '\n') {
        eol = '\r\n'
        index += 1
      } else {
        eol = source[index]
      }
    }
    lines.push({ start, end, eol, text: source.slice(start, end) })
    start = index + 1
  }
  return lines
}

const lineEndingFor = (source, line) => {
  if (line?.eol) return line.eol
  const priorEndings = [...String(source || '').slice(0, line?.start || 0).matchAll(/\r\n|\r|\n/g)]
  return priorEndings.at(-1)?.[0] ||
    (source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n')
}

const visibleLineText = (line) => sourceVisibleIndex(String(line || '')).text

// Slash commands are two user-visible operations executed as one intent:
// remove the temporary `/query` paragraph, then replace that exact block with
// the selected structure. Capture the authored line before either command can
// publish a debounced markdownUpdated callback, so global source/canonical
// divergence elsewhere in the document cannot move the replacement.
export const captureSlashBlockSourceIntent = ({ source, queryText, sourceOffset, id }) => {
  const markdown = String(source || '')
  const query = String(queryText || '')
  if (!query.startsWith('/') || !id) return null
  const lines = markdownLines(markdown)
  const matches = (line) => visibleLineText(line.text) === query
  const mapped = Number.isFinite(sourceOffset)
    ? lines.find((line) => (
        sourceOffset >= line.start && sourceOffset <= line.end && matches(line)
      )) || lines.find((line) => (
        sourceOffset > 0 && sourceOffset - 1 >= line.start && sourceOffset - 1 <= line.end && matches(line)
      ))
    : null
  const candidates = lines.filter(matches)
  const line = mapped || (candidates.length === 1 ? candidates[0] : null)
  if (!line) return null
  return {
    id,
    source: markdown,
    rawStart: line.start,
    rawEnd: line.end,
    lineEnding: lineEndingFor(markdown, line),
    query
  }
}

const completeFenceBlock = (value) => {
  const lines = String(value || '').replace(/(?:\r\n|\r|\n)+$/, '').split(/\r\n|\r|\n/)
  if (lines.length < 2) return false
  const open = lines[0].match(/^\s*(`{3,}|~{3,})/)
  const close = lines.at(-1).match(/^\s*(`{3,}|~{3,})\s*$/)
  return !!(open && close && open[1][0] === close[1][0] && close[1].length >= open[1].length)
}

const completeDisplayMathBlock = (value) => {
  const lines = String(value || '').replace(/(?:\r\n|\r|\n)+$/, '').split(/\r\n|\r|\n/)
  if (lines.length < 2) return false
  return /^ {0,3}\$\$\s*$/.test(lines[0]) && /^ {0,3}\$\$\s*$/.test(lines.at(-1))
}

// Serializing an isolated empty math node can emit `$$\n\n$$`, while the same
// node in the live document canonicalizes to `$$\n$$`. The interior blank row
// is serializer-owned, not user-authored. Collapse only a whitespace-only
// interior; non-empty math and intentional internal blank lines stay intact.
const compactEmptyDisplayMathBlock = (value) => {
  const lines = String(value || '').split(/\r\n|\r|\n/)
  if (
    lines.length > 2 &&
    /^ {0,3}\$\$\s*$/.test(lines[0]) &&
    /^ {0,3}\$\$\s*$/.test(lines.at(-1)) &&
    lines.slice(1, -1).every((line) => !line.trim())
  ) {
    return `${lines[0]}\n${lines.at(-1)}`
  }
  return String(value || '')
}

export const applySlashBlockSourceIntent = ({ intent, blockMarkdown }) => {
  if (!intent || typeof blockMarkdown !== 'string') return null
  const codeLike = intent.id === 'code' || intent.id === 'math' || intent.id.startsWith('code:')
  if (!codeLike) return null
  const replacement = blockMarkdown.replace(/(?:\r\n|\r|\n)+$/, '')
  const ownedReplacement = intent.id === 'math'
    ? compactEmptyDisplayMathBlock(replacement)
    : replacement
  const completeBlock = intent.id === 'math'
    ? completeDisplayMathBlock(ownedReplacement)
    : completeFenceBlock(ownedReplacement)
  if (!completeBlock) return null
  const authoredReplacement = ownedReplacement.replace(/\r\n|\r|\n/g, intent.lineEnding)
  return intent.source.slice(0, intent.rawStart) +
    authoredReplacement +
    intent.source.slice(intent.rawEnd)
}
