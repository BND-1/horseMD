// A task item's paragraph starts AFTER its `[ ] ` / `[x] ` (positions).
//
// mdast-util-gfm-task-list-item moves the paragraph start past the checkbox
// only when the text after it starts with plain text. `- [ ] **重要**：…`,
// `- [ ] <mark …>…</mark>`, `- [ ] [链接](…)` kept the start ON the checkbox,
// so whenever the source reprint printed that paragraph whole it replaced the
// checkbox too and the task became a plain item (combination test). Parse
// side, registered after remark-gfm.
const CHECKBOX = /^\[[ xX]\][ \t]/

function fix(node, source) {
  if (!node || !Array.isArray(node.children)) return
  if (node.type === 'listItem' && typeof node.checked === 'boolean') {
    const paragraph = node.children.find((child) => child.type === 'paragraph')
    const start = paragraph?.position?.start
    if (start && Number.isInteger(start.offset)) {
      const match = CHECKBOX.exec(source.slice(start.offset, start.offset + 8))
      if (match) {
        paragraph.position.start = { ...start, offset: start.offset + match[0].length, column: start.column + match[0].length }
      }
    }
  }
  for (const child of node.children) fix(child, source)
}

export function remarkTaskParagraphPosition() {
  return (tree, file) => {
    const source = String(file?.value ?? '')
    if (source.includes('[')) fix(tree, source)
  }
}
