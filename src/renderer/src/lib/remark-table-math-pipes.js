// Inline math in a GFM table cell (#179 follow-up, 2026-11-19). A cell's `|`
// must be written `\|`; GitHub and markdown-it (VS Code) take the escape out
// before the formula is read, so `$\left\| x \right\|$` is |x| there.
// mdast-util-gfm-table does that for inline code only: the formula kept
// `\|`, which KaTeX draws as ‖ — and a `|` typed in a formula inside a cell
// was saved bare, so the reopened table split at it.
//
// Parse: the same unescape as inline code in a table (`\|` → `|`, `\\`
// kept). Write: `|` → `\|`; the formula's own `\|` (‖) cannot be written in
// a cell at all (a `\\` pair is consumed first, then the `|` ends the
// cell), so it becomes `\Vert`, which KaTeX draws the same.
import { mathToMarkdown } from 'mdast-util-math'

const unescapeCellPipe = (value) => value.replace(/\\([\\|])/g, ($0, $1) => ($1 === '|' ? $1 : $0))

export function remarkTableMathPipes() {
  const visit = (node, inCell) => {
    if (inCell && node.type === 'inlineMath' && typeof node.value === 'string' && node.value.includes('\\')) {
      node.value = unescapeCellPipe(node.value)
    }
    if (Array.isArray(node.children)) {
      const cell = inCell || node.type === 'tableCell'
      for (const child of node.children) visit(child, cell)
    }
  }
  return (tree) => visit(tree, false)
}

export function cellMathValue(value) {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '\\' && value[i + 1] === '\\') {
      out += '\\\\'
      i++
    } else if (c === '\\' && value[i + 1] === '|') {
      out += /[A-Za-z]/.test(value[i + 2] || '') ? '\\Vert ' : '\\Vert'
      i++
    } else if (c === '|') {
      out += '\\|'
    } else {
      out += c
    }
  }
  return out
}

const defaultInlineMath = mathToMarkdown().handlers.inlineMath

export function inlineMathStringifyHandler(node, parent, state, info) {
  if (!state.stack?.includes('tableCell') || !String(node.value || '').includes('|')) {
    return defaultInlineMath(node, parent, state, info)
  }
  return defaultInlineMath({ ...node, value: cellMathValue(node.value) }, parent, state, info)
}
inlineMathStringifyHandler.peek = defaultInlineMath.peek
