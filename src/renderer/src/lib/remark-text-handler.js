import { cjkFriendlyToMarkdown } from 'mdast-util-to-markdown-cjk-friendly'

// Milkdown's default remark `text` stringify handler has a fast path,
// `if (/^[^*_\\]*\s+$/.test(value)) return value`, meant to keep the space
// before a mark (`a **b**`) from being entity-encoded. It also skips every
// other escape for ANY text node that ends in whitespace — typically the text
// right before inline code. So a paragraph whose text is `    second ` +
// `code` serialized as `    second \`code\``, which reopens as an indented
// code block; `1. foo ` / `# h ` / `- x ` / `> q ` before inline code became a
// list / heading / quote (fuzz seed 36, 2026-10-06: Tab at a paragraph start
// inserts four spaces). The canonical then agreed with the broken candidate,
// so validation could not catch it.
//
// Keep the fast path's intent — trailing whitespace stays raw — but escape the
// non-whitespace head with the normal `state.safe`. A whitespace-only run is
// raw unless it starts a line with a space/tab, whose first character is encoded exactly
// as mdast-util-to-markdown encodes any other leading space (`&#x20;`, which
// source preservation spells as the U+200B sentinel).
const TRAILING_WHITESPACE_FAST_PATH = /^([^*_\\]*?)(\s+)$/

const encodeCharacter = (character) =>
  `&#x${character.charCodeAt(0).toString(16).toUpperCase()};`

export function safeTrailingWhitespaceTextHandler(node, parent, state, info) {
  // The CJK-friendly strong/emphasis handler (below) asks the next text node
  // to encode its first character when it is outside the BMP (an emoji):
  // `**foo.**&#x1F600;`. Its own text handler does that; this one replaces it.
  if (state.cjkFriendlyEncodeAfterSupplementaryText) {
    state.cjkFriendlyEncodeAfterSupplementaryText = false
    const [first = ''] = [...node.value]
    if (first) {
      const rest = safeTrailingWhitespaceTextHandler({ ...node, value: node.value.slice(first.length) }, parent, state, { ...info, before: ';' })
      return `&#x${first.codePointAt(0).toString(16).toUpperCase()};${rest}`
    }
  }
  const value = node.value
  const match = TRAILING_WHITESPACE_FAST_PATH.exec(value)
  if (!match) return state.safe(value, { ...info, encode: [] })
  const [, head, tail] = match
  if (!head) {
    const before = info?.before
    const atLineStart = !before || /[\r\n]$/.test(before)
    // Only a leading space/tab is indentation; a soft-break text node ("\n")
    // stays raw exactly as before.
    return atLineStart && /^[ \t]/.test(value) ? encodeCharacter(value[0]) + value.slice(1) : value
  }
  return state.safe(head, { ...info, after: tail[0], encode: [] }) + tail
}

// Milkdown's default strong/emphasis stringify handlers keep the authored
// marker (`__x__` stays `__`) but skip CommonMark's attention encoding, so a
// bold run ending in punctuation followed by a letter printed `**foo.**abc`,
// which parses back as literal asterisks (Yuque exports: `**<font>…</font>**`
// then typed text). The CJK-friendly handlers (the ones remark-cjk-friendly
// registers, also handling `**「重点」**内容`) encode `**foo.**&#x61;bc`;
// wrap them so the node's own marker is still used.
const withMarker = (handle, option) => {
  const wrapped = (node, parent, state, info) => {
    const saved = state.options[option]
    if (node?.marker) state.options[option] = node.marker
    try {
      return handle(node, parent, state, info)
    } finally {
      state.options[option] = saved
    }
  }
  wrapped.peek = (node, _parent, state) => node?.marker || state.options[option] || '*'
  return wrapped
}

const cjkAttention = cjkFriendlyToMarkdown().handlers
export const strongStringifyHandler = withMarker(cjkAttention.strong, 'strong')
export const emphasisStringifyHandler = withMarker(cjkAttention.emphasis, 'emphasis')
