// CommonMark consumes 1–3 leading ASCII spaces as indentation and interprets
// 4+ as an indented code block. Typora prefixes visibly-authored leading spaces
// with U+200B so the raw Markdown remains a paragraph without exposing an HTML
// entity in source mode. HorseMD uses the same source spelling.
export const LEADING_SPACE_SENTINEL = '\u200B'

// The sentinel is source syntax, not editor content. Remove it from parsed
// text nodes before ProseMirror is built; the source-preservation layer restores
// it whenever remark-stringify emits the corresponding `&#x20;` spelling.
export function remarkStripLeadingSpaceSentinel() {
  return (tree) => {
    const walk = (node) => {
      if (!node || typeof node !== 'object') return

      // RS-50: GFM requires some body content after `[ ]` / `[x]` to retain
      // task-list semantics. Generated scratch writes a lone U+200B while the
      // task paragraph is empty. It is source syntax, not editor text: remove
      // it only from the exact one-paragraph/one-text-node task shape. A
      // sentinel anywhere else remains ordinary authored content.
      if (
        node.type === 'listItem' &&
        node.checked !== null &&
        node.checked !== undefined &&
        Array.isArray(node.children) &&
        node.children.length === 1
      ) {
        const paragraph = node.children[0]
        if (
          paragraph?.type === 'paragraph' &&
          Array.isArray(paragraph.children) &&
          paragraph.children.length === 1 &&
          paragraph.children[0]?.type === 'text' &&
          paragraph.children[0]?.value === LEADING_SPACE_SENTINEL
        ) {
          paragraph.children = []
        }
      }

      if (
        node.type === 'text' &&
        typeof node.value === 'string' &&
        node.value.startsWith(`${LEADING_SPACE_SENTINEL} `)
      ) {
        node.value = node.value.slice(LEADING_SPACE_SENTINEL.length)
      }
      if (Array.isArray(node.children)) node.children.forEach(walk)
    }
    walk(tree)
  }
}
