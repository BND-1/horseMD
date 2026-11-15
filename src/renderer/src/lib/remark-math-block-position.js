// Crepe's LaTeX feature (remarkMathBlock) turns every `$$ … $$` block into a
// `code` node with lang "LaTeX" but drops the block's `position`. The source
// reprint engine locates every block by its source offsets, so without one an
// edit inside a math block (typing in a new 公式 block from the slash menu, or
// in one read from the file) printed the whole document twice around the
// edit, verification rejected it and the editor showed "富文本与源码不一致".
// Do the same conversion first, keeping the position; Crepe's pass then finds
// no `math` node. Registered in remarkPluginsCtx before Crepe's plugins.
export function remarkMathBlockWithPosition() {
  return (tree) => {
    const walk = (parent) => {
      if (!Array.isArray(parent?.children)) return
      parent.children.forEach((node, index) => {
        if (node.type === 'math') {
          parent.children[index] = { type: 'code', lang: 'LaTeX', value: node.value, position: node.position }
          return
        }
        walk(node)
      })
    }
    walk(tree)
  }
}

// A line that is exactly `$$…$$` is display math (issue #18; Typora, VS Code).
// remark-math reads it as a paragraph holding one `$$` inline math, so the
// editor used to rewrite the text before parsing (normalizeDisplayMath:
// `$$x$$` → `$$\nx\n$$`). The source baseline kept the authored line, the
// editor held a math block, and the first sync after any click printed the
// block as three lines: the document turned dirty without an edit (mobile
// review 2026-11-14, the welcome tour's formula). Here the parse itself makes
// it a math block with the paragraph's position, so the reprint keeps the
// authored line. Only a paragraph that is the whole line (blanks around it
// allowed), like the old rewrite: `- $$x$$`, `> $$x$$` and `a $$x$$ b` stay
// inline.
export function remarkSingleLineDisplayMath() {
  return (tree, file) => {
    const source = String(file?.value ?? '')
    if (!source.includes('$$')) return
    // Offsets exclude a BOM; file.value keeps it (see remarkFixMarkerOffsetForBom).
    const bom = source.charCodeAt(0) === 0xfeff ? 1 : 0
    const walk = (parent) => {
      if (!Array.isArray(parent?.children)) return
      parent.children.forEach((node, index) => {
        if (node.type !== 'paragraph') { walk(node); return }
        const only = node.children?.length === 1 ? node.children[0] : null
        const start = node.position?.start?.offset
        const end = node.position?.end?.offset
        if (only?.type !== 'inlineMath' || !Number.isInteger(start) || !Number.isInteger(end)) return
        const text = source.slice(start + bom, end + bom)
        if (!/^\$\$[^\n]*[^$\n]\$\$[ \t]*$/.test(text) || /^\$\$\$/.test(text)) return
        const lineStart = Math.max(bom, source.lastIndexOf('\n', start + bom - 1) + 1)
        const lineEnd = source.indexOf('\n', end + bom)
        if (!/^[ \t]*$/.test(source.slice(lineStart, start + bom))) return
        if (!/^[ \t]*\r?$/.test(source.slice(end + bom, lineEnd < 0 ? source.length : lineEnd))) return
        parent.children[index] = { type: 'code', lang: 'LaTeX', meta: null, value: only.value, position: node.position }
      })
    }
    walk(tree)
  }
}
