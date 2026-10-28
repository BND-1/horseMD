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
