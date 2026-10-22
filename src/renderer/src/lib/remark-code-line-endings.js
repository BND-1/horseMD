// micromark keeps a CRLF file's `\r\n` inside code and math values, but
// CodeMirror (the editor of both) inserts `\n` on Enter. One block then held
// both spellings: the editor had `text\n`, the re-parsed source `text\r\n`,
// and every edit in a CRLF file's code block failed the save check (Air
// 0.13.251 trace-63191). Line endings are the file's format, not the code's
// content (Typora reads them the same way): values hold `\n`, and source
// writes spell them in the file's own style.
const LITERAL = new Set(['code', 'math'])

function walk(node) {
  if (LITERAL.has(node?.type) && typeof node.value === 'string' && node.value.includes('\r')) {
    node.value = node.value.replace(/\r\n?/g, '\n')
  }
  if (Array.isArray(node?.children)) for (const child of node.children) walk(child)
}

export function remarkNormalizeCodeLineEndings() {
  return (tree, file) => {
    const source = typeof file?.value === 'string' ? file.value : ''
    if (source && !source.includes('\r')) return
    walk(tree)
  }
}
