// Mark input rules that must only fire on what was just typed.
//
// ProseMirror runs an input rule's regexp against the text before the caret
// plus the typed character and does NOT require the match to end there — the
// regexp has to end with `$`. Milkdown's underscore emphasis rule is
// `/\b_(?![_\s])(.*?[^_\s])_\b/` (no `$`): with `_x_` anywhere earlier in the
// paragraph (inline code `_<font …>equals()</font>_`, Yuque's `_…_` italics),
// every keystroke turned that range into emphasis, deleted a character and
// swallowed the typed one. That text also includes inline code, which an
// emphasis/strong rule must never reach into.
//
// The rules live in Milkdown's `inputRulesCtx` array and ProseMirror reads
// `rule.match` / `rule.handler` on every keystroke, so they are patched in
// place after the editor is created.

const UNANCHORED_UNDERSCORE = String.raw`\b_(?![_\s])(.*?[^_\s])_\b`
// Same meaning, anchored at the caret: `_text_` just closed by the typed `_`,
// not preceded by a word character or another underscore.
const UNDERSCORE_EMPHASIS = /(?:^|[^\w_])_(?![_\s])([^_]*?[^_\s])_$/

export function guardMarkInputRules(rules, schema) {
  if (!Array.isArray(rules) || !schema) return 0
  const code = schema.marks.inlineCode || schema.marks.code_inline
  let patched = 0
  for (const rule of rules) {
    if (!rule || !(rule.match instanceof RegExp) || typeof rule.handler !== 'function' || rule.__hmGuarded) continue
    if (rule.match.source === UNANCHORED_UNDERSCORE) {
      rule.match = UNDERSCORE_EMPHASIS
      patched += 1
    }
    // The inline-code rule itself builds code from backticks; every other
    // mark rule stays out of text that is already code.
    if (code && !/`/.test(rule.match.source)) {
      const handler = rule.handler
      rule.handler = (state, match, start, end) => {
        if (start < end && state.doc.rangeHasMark(start, end, code)) return null
        return handler(state, match, start, end)
      }
    }
    rule.__hmGuarded = true
  }
  return patched
}
