// CommonMark consumes 1–3 leading ASCII spaces as indentation and interprets
// 4+ as an indented code block. Typora prefixes visibly-authored leading spaces
// with U+200B so the raw Markdown remains a paragraph without exposing an HTML
// entity in source mode. HorseMD uses the same source spelling.
export const LEADING_SPACE_SENTINEL = '\u200B'

// The sentinel is source syntax, not editor content. Remove it from parsed
// text nodes before ProseMirror is built; the source-preservation layer restores
// it whenever remark-stringify emits the corresponding `&#x20;` spelling.
// Only a sentinel written as the literal character is syntax. A text that
// itself starts with U+200B + a space (pasted web text; a code block turned
// into a paragraph) is written `&#x200B;` by the text handler and must read
// back as content: stripping it too left that text with no spelling at all,
// so every such paragraph paused the sync (fuzz seed 1286). A node without a
// position keeps the old rule.
const isLiteralSentinel = (node, source) => {
  const offset = node.position?.start?.offset
  if (!source || !Number.isInteger(offset)) return true
  // Offsets exclude a BOM that file.value still holds.
  const at = source.charCodeAt(0) === 0xFEFF ? offset + 1 : offset
  return source[at] === LEADING_SPACE_SENTINEL
}

const sentinelFollowedByBlank = (node, source) => {
  const offset = node.position?.start?.offset
  if (!source || !Number.isInteger(offset)) return false
  const at = (source.charCodeAt(0) === 0xFEFF ? offset + 1 : offset) + LEADING_SPACE_SENTINEL.length
  return source[at] === ' ' || source[at] === '\t'
}

export function remarkStripLeadingSpaceSentinel() {
  return (tree, file) => {
    const source = typeof file?.value === 'string' ? file.value : ''
    const walk = (node) => {
      if (!node || typeof node !== 'object') return

      // RS-50: GFM requires some body content after `[ ]` / `[x]` to retain
      // task-list semantics. Generated scratch writes a lone U+200B while the
      // task paragraph is empty. It is source syntax, not editor text: remove
      // it only from the task's FIRST paragraph when that is exactly the
      // sentinel — also when blocks follow (`- [x] ​` + a code block below:
      // the editor's empty task line; reopening kept a U+200B paragraph,
      // fuzz seed 154). A sentinel anywhere else remains ordinary authored
      // content.
      if (
        node.type === 'listItem' &&
        node.checked !== null &&
        node.checked !== undefined &&
        Array.isArray(node.children) &&
        node.children.length >= 1
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

      // A paragraph of only blanks spelled sentinel + blanks: the paragraph
      // end strips the blanks, leaving the sentinel alone. It is still the
      // sentinel (a blank follows it in the source), so the paragraph is
      // empty — it reopened holding U+200B (fuzz seed 3716, a fallback
      // writer's spelling).
      if (
        node.type === 'paragraph' &&
        Array.isArray(node.children) &&
        node.children.length === 1 &&
        node.children[0]?.type === 'text' &&
        node.children[0].value === LEADING_SPACE_SENTINEL &&
        isLiteralSentinel(node.children[0], source) &&
        sentinelFollowedByBlank(node.children[0], source)
      ) {
        node.children = []
      }
      if (
        node.type === 'text' &&
        typeof node.value === 'string' &&
        node.value.startsWith(`${LEADING_SPACE_SENTINEL} `) &&
        isLiteralSentinel(node, source)
      ) {
        node.value = node.value.slice(LEADING_SPACE_SENTINEL.length)
      }
      if (Array.isArray(node.children)) node.children.forEach(walk)
    }
    walk(tree)
  }
}
