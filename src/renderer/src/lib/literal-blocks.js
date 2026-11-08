// Run line-based Markdown passes outside fenced code and `$$` math blocks.

// Fenced code and `$$` math blocks are user data. A new document's source is
// built from the serialization by line passes (empty list items, `<br />`
// lines, task placeholders, empty table cells, list spacing, escape
// restoration) that read Markdown syntax — inside a formula `\\`, `- d`,
// ` <br />` are LaTeX (user report 2026-10-30: typing `\\` in a new
// document's formula paused the sync on every keystroke). Each closed block's
// content lines become one token line for the passes and come back unchanged.
// The source reprint's printed blocks go through the same kind of passes
// (`&#x20;` → U+200B, `<br />` lines; fuzz seed 562: a heading line inside a
// code block lost its `&#x20;`).
const LITERAL_TOKEN = (index) => `\uE0A0hm-literal-${index}\uE0A0`
const LITERAL_TOKEN_RE = /\uE0A0hm-literal-(\d+)\uE0A0/
const splitLines = (text) => {
  const lines = []
  const re = /([^\r\n]*)(\r\n|\r|\n|$)/g
  let match
  while ((match = re.exec(text)) && match[0] !== '') {
    lines.push({ text: match[1], sep: match[2] })
    if (!match[2]) break
  }
  return lines
}
const literalOpen = (body) => {
  const fence = body.match(/^(`{3,}|~{3,})/)
  if (fence) return { kind: 'fence', char: fence[1][0], size: fence[1].length }
  if (!body.startsWith('$$')) return null
  const rest = body.slice(2).trim()
  return rest.length > 2 && rest.endsWith('$$') ? null : { kind: 'math' }
}
const literalCloses = (open, body) => {
  if (open.kind === 'math') return /\$\$\s*$/.test(body)
  const close = body.match(/^(`{3,}|~{3,})\s*$/)
  return Boolean(close && close[1][0] === open.char && close[1].length >= open.size)
}
export const withLiteralBlocksProtected = (markdown, transform) => {
  const text = String(markdown || '')
  const lines = splitLines(text)
  const saved = []
  const out = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    out.push(line)
    // An opening fence may follow list markers (`- ```js`: an item that
    // starts with a code block); closing lines are only indented / quoted.
    const body = line.text.replace(/^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*[ \t]*/, '')
    const open = literalOpen(body)
    if (!open) continue
    let close = -1
    for (let probe = index + 1; probe < lines.length; probe += 1) {
      if (literalCloses(open, lines[probe].text.replace(/^(?:[ \t]*>)*[ \t]*/, ''))) { close = probe; break }
    }
    if (close < 0) {
      // Unclosed: everything after it is literal for Markdown too; pass it
      // through untouched by the token swap.
      out.push(...lines.slice(index + 1))
      break
    }
    if (close > index + 1) {
      // The token line keeps the quote prefix; list markers become spaces
      // (the token line must not read as another item).
      const prefix = line.text.slice(0, line.text.length - body.length).replace(/[-*+.)\d]/g, ' ')
      saved.push(lines.slice(index + 1, close))
      out.push({ text: prefix + LITERAL_TOKEN(saved.length - 1), sep: lines[close - 1].sep })
    }
    out.push(lines[close])
    index = close
  }
  if (!saved.length) return transform(text)
  const protectedText = out.map((line) => line.text + line.sep).join('')
  const result = String(transform(protectedText) ?? '')
  const restored = []
  let used = 0
  for (const line of splitLines(result)) {
    const token = line.text.match(LITERAL_TOKEN_RE)
    if (!token || !saved[Number(token[1])]) { restored.push(line.text + line.sep); continue }
    const content = saved[Number(token[1])]
    used += 1
    content.forEach((original, at) => restored.push(original.text + (at === content.length - 1 ? line.sep : original.sep)))
  }
  // A pass that dropped a token would lose the block: fall back to the
  // unprotected transform rather than return a document without it.
  return used === saved.length ? restored.join('') : transform(text)
}
