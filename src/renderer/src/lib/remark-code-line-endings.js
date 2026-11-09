// Line endings inside code, read the way the spec reads them.
//
// Code blocks and math: micromark keeps a CRLF file's `\r\n` inside code and
// math values, but CodeMirror (the editor of both) inserts `\n` on Enter. One
// block then held both spellings: the editor had `text\n`, the re-parsed
// source `text\r\n`, and every edit in a CRLF file's code block failed the
// save check (Air 0.13.251 trace-63191). Line endings are the file's format,
// not the code's content (Typora reads them the same way): values hold `\n`,
// and source writes spell them in the file's own style.
//
// Inline code: CommonMark converts a line ending inside a code span to a
// space (spec §6.1) — it renders as one. mdast keeps the raw `\n`, and the
// serializer writes a space where the next line would start with syntax, so
// the same span read back differently (`docs/empty-paragraph-contract.md`,
// a span wrapped before `===`). The value holds the space, as the spec says.
const BLOCK_LITERAL = new Set(['code', 'math'])

function walk(node, crlf) {
  if (crlf && BLOCK_LITERAL.has(node?.type) && typeof node.value === 'string' && node.value.includes('\r')) {
    node.value = node.value.replace(/\r\n?/g, '\n')
  }
  if (node?.type === 'inlineCode' && typeof node.value === 'string' && /[\r\n]/.test(node.value)) {
    node.value = node.value.replace(/\r\n|\r|\n/g, ' ')
  }
  if (Array.isArray(node?.children)) for (const child of node.children) walk(child, crlf)
}

export function remarkNormalizeCodeLineEndings() {
  return (tree, file) => {
    const source = typeof file?.value === 'string' ? file.value : ''
    walk(tree, !source || source.includes('\r'))
  }
}
