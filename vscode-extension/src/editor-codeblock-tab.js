// Code-block Tab override (issue #39).
//
// Milkdown's code-block (via Crepe's code-mirror FEATURE) injects
// `keymap.of(defaultKeymap.concat(indentWithTab))`. `indentWithTab` binds Tab to
// "re-indent the current line" (indentation inserted at the line start per the
// indent unit), so when the cursor is mid-line or at line-end, Tab indents the
// WHOLE line instead of inserting a tab at the cursor — the opposite of what a
// user writing code in a Markdown code block expects.
//
// FIX: a higher-precedence keymap that binds Tab to "insert a real tab char at
// the selection" (CodeMirror's standard cursor-indent behavior). Shift-Tab is
// NOT touched, so block dedent (indentWithTab's Shift-Tab) still works.
//
// INJECTION POINT: the `[CrepeFeature.CodeMirror]` featureConfig `extensions`
// field. Crepe's code-mirror feature pushes `config.extensions` AFTER
// `indentWithTab` when building codeBlockConfig.extensions, and `Prec.highest`
// guarantees our binding is tried before `indentWithTab`'s regardless of array
// order — the documented CM6 way to override a default keymap. This is the
// SUPPORTED channel; we deliberately do NOT use the eager-mount prototype mod
// (editor-codeblock-eager.js) — that's for mount lifecycle, not keymaps, and a
// keymap belongs in the editor's extension set.
import { keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'

// Insert a real tab character at the current selection (replacing the selection,
// like typing). Returns true so the key is consumed (no fall-through to
// indentWithTab / defaultKeymap).
const insertTabAtCursor = (view) => {
  if (view.readOnly) return false
  view.dispatch(view.state.replaceSelection('\t'))
  return true
}

// Prec.highest ⇒ wins over indentWithTab (same key, lower precedence).
// Exported as a single Extension; Editor.jsx adds it to featureConfig.extensions.
export const tabAtCursorKeymap = Prec.highest(
  keymap.of([{ key: 'Tab', run: insertTabAtCursor }])
)

// Guard against CM API drift (mirrors editor-codeblock-eager.js): if a future
// bump removes Prec/keymap, surface it instead of silently losing the override.
if (typeof Prec?.highest !== 'function' || typeof keymap?.of !== 'function') {
  // eslint-disable-next-line no-console
  console.warn('[horsemd] code-block Tab override: @codemirror API changed — #39 may return.')
}
