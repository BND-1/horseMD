// In-cell line breaks for tables (issue #7), with a clean <br> round-trip.
//
// GFM table cells must be a single line; the only valid in-cell break is <br>.
// Three surgical pieces, none of which touch Milkdown's node definitions:
//   1. keymap     — Enter / Shift+Enter inside a cell inserts a hardbreak node
//                   (renders as <br> in the editor).
//   2. serialize  — a custom remark `break` handler emits <br> *only* inside a
//                   tableCell; everywhere else it defers to the default (so normal
//                   paragraph line breaks are unchanged).
//   3. parse      — a remark transform turns inline `<br>` html nodes into break
//                   nodes, so <br> in a cell renders as a line break (and the
//                   previously-dropped <br> now shows up).
import { keymap } from '@milkdown/prose/keymap'
import { baseKeymap, chainCommands } from '@milkdown/prose/commands'
import { defaultHandlers } from 'mdast-util-to-markdown'

const BR_RE = /^<br\s*\/?>$/i
// Node types whose children are phrasing content — the only places an inline
// <br> legitimately appears, so we only rewrite there (never at block level,
// which would produce an invalid mdast break).
const PHRASING_PARENTS = new Set([
  'paragraph',
  'heading',
  'tableCell',
  'emphasis',
  'strong',
  'delete',
  'link'
])

// --- 2. serialize: break → <br> inside a table cell ---
export function tableCellBreakHandler(node, parent, state, info) {
  if (state.stack && state.stack.includes('tableCell')) return '<br>'
  // A hard break at the very start or end of a paragraph/heading has no
  // Markdown spelling: `  \n` there is a whitespace-only line (or is dropped
  // by the parser, or ends the heading). Write nothing instead of a stray
  // line — the validator compares such edge breaks as absent.
  if ((parent?.type === 'paragraph' || parent?.type === 'heading') && Array.isArray(parent.children)) {
    const index = parent.children.indexOf(node)
    const isBreak = (child) => child?.type === 'break'
    const leading = parent.children.slice(0, index).every(isBreak)
    const trailing = parent.children.slice(index + 1).every(isBreak)
    if ((leading || trailing) && parent.children.some((child) => !isBreak(child))) return ''
  }
  // A heading is one line: `  \n` would end it and start a paragraph. Spell a
  // break inside a heading as `<br>`, which parses back to the same break.
  if (state.stack && (state.stack.includes('headingAtx') || state.stack.includes('headingSetext'))) return '<br>'
  return defaultHandlers.break(node, parent, state, info)
}

// --- 3. parse: inline <br> html → break ---
export function brToBreakRemarkPlugin() {
  return (tree) => {
    const walk = (node) => {
      if (!node || !Array.isArray(node.children)) return
      if (PHRASING_PARENTS.has(node.type)) {
        node.children = node.children.map((c) =>
          c && c.type === 'html' && BR_RE.test((c.value || '').trim()) ? { type: 'break' } : c
        )
      }
      node.children.forEach(walk)
    }
    walk(tree)
  }
}

// --- 1. keymap: insert a break inside a table cell ---
function inTableCell($from) {
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name
    if (name === 'table_cell' || name === 'table_header') return true
  }
  return false
}

export function tableBreakKeymap() {
  const insertBreak = (state, dispatch) => {
    const { $from, empty } = state.selection
    if (!empty || !inTableCell($from)) return false
    const br = state.schema.nodes.hardbreak
    if (!br) return false
    if (dispatch) {
      dispatch(state.tr.replaceSelectionWith(br.create({ isInline: false }), true).scrollIntoView())
    }
    return true
  }
  // Enter and Shift+Enter both break the line in a cell (plain Enter otherwise
  // just jumps out of the table — issue #7's complaint).
  // A heading is one line, so Shift+Enter in a heading splits it exactly like
  // Enter (Typora 2026-10-12: `### 甲乙|丙丁` → `### 甲乙` + `### 丙丁` for both
  // keys) instead of inserting a line break the heading cannot hold.
  const splitHeading = (state, dispatch, view) => {
    const { $from, $to } = state.selection
    if ($from.parent.type.name !== 'heading' || !$from.sameParent($to)) return false
    return baseKeymap.Enter(state, dispatch, view)
  }
  // In a paragraph Shift+Enter writes a plain newline (Typora 2026-10-12:
  // `甲乙|丙丁` → `甲乙\n丙丁`), i.e. Milkdown's inline ("soft") break, which
  // the default "preserve single line breaks" display shows as a line break.
  // With that setting off a soft break renders as a space, so the hard break
  // (two spaces + newline) stays — the key must visibly break the line.
  const softBreak = (state, dispatch) => {
    const { $from, $to } = state.selection
    const br = state.schema.nodes.hardbreak
    if (!br || $from.parent.type.name !== 'paragraph' || !$from.sameParent($to)) return false
    if (typeof document === 'undefined' || !document.body.classList.contains('hm-preserve-soft-breaks')) return false
    if (dispatch) {
      dispatch(state.tr.replaceSelectionWith(br.create({ isInline: true }), true).scrollIntoView())
    }
    return true
  }
  return keymap({ Enter: insertBreak, 'Shift-Enter': chainCommands(insertBreak, splitHeading, softBreak), 'Mod-Enter': insertBreak })
}
