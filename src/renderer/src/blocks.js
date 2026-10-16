// Shared block-type definitions used by the editor, status-bar switcher,
// the selection toolbar and the right-click menu — so every surface that
// changes a paragraph's level stays in sync.

export const BLOCK_TYPES = [
  { id: 'paragraph', name: 'paragraph', label: 'Text', short: '¶', commandId: 'editor.block.paragraph' },
  { id: 'h1', name: 'heading', level: 1, label: 'Heading 1', short: 'H1', commandId: 'editor.block.h1' },
  { id: 'h2', name: 'heading', level: 2, label: 'Heading 2', short: 'H2', commandId: 'editor.block.h2' },
  { id: 'h3', name: 'heading', level: 3, label: 'Heading 3', short: 'H3', commandId: 'editor.block.h3' },
  { id: 'h4', name: 'heading', level: 4, label: 'Heading 4', short: 'H4', commandId: 'editor.block.h4' },
  { id: 'h5', name: 'heading', level: 5, label: 'Heading 5', short: 'H5', commandId: 'editor.block.h5' },
  { id: 'h6', name: 'heading', level: 6, label: 'Heading 6', short: 'H6', commandId: 'editor.block.h6' }
]

// The compact set shown in the on-selection floating toolbar.
export const SELECTION_BLOCK_IDS = ['paragraph', 'h1', 'h2', 'h3']

export const blockById = (id) => BLOCK_TYPES.find((b) => b.id === id)

export function labelForBlockId(id) {
  const def = blockById(id)
  if (def) return def.label
  // Fallback for block types we don't switch between (code, quote, list…)
  if (!id) return 'Text'
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' ')
}

// Resolve the id of the textblock the selection currently sits in.
export function currentBlockId(state) {
  const { $from } = state.selection
  let depth = $from.depth
  while (depth > 0 && !$from.node(depth).isTextblock) depth--
  const node = depth >= 0 ? $from.node(depth) : null
  if (!node) return 'paragraph'
  if (node.type.name === 'heading') return 'h' + (node.attrs.level || 1)
  if (node.type.name === 'paragraph') return 'paragraph'
  return node.type.name
}
