import { Plugin, PluginKey } from '@milkdown/prose/state'

// Math (LaTeX) helpers.
//
// remark-math (what Milkdown Crepe's Latex feature uses under the hood) only
// treats `$$…$$` as DISPLAY / block math when each `$$` delimiter sits on its
// own line:
//     $$\nx^2\n$$   → block math  ✓
//     $$x^2$$       → INLINE math $x^2$  ✗   (the $$ collapses to a single $)
// Most people write display math on a single line (`$$x^2$$`), which remark-math
// then silently downgrades to inline — the formula breaks / KaTeX errors
// (GitHub issue #18: "$$…$$ forced into $…$"). VSCode's math parser is lenient
// about this; remark-math is not.
//
// Opening a file no longer rewrites the text: the parse itself makes such a
// line a math block (lib/remark-math-block-position.js
// remarkSingleLineDisplayMath), so the authored line stays in the source.
// normalizeDisplayMath is left for Markdown pastes, whose bytes are parsed
// separately. It rewrites a standalone `$$…$$` line into the multi-line
// block form BEFORE parse, so it renders as display math. It is:
//   - idempotent (already-multi-line block math is untouched);
//   - code-safe (fenced ```/~~~ blocks and inline `code` are stashed so `$$`
//     inside code is never touched);
//   - conservative (only lines that are EXACTLY `$$…$$` are rewritten — inline
//     `$x$` and mid-line `text $$x$$ text` are left alone).

// Private-use chars as stash sentinels (never appear in real Markdown, and avoid
// null bytes that trip some tooling).
const OPEN = '\uE000'
const CLOSE = '\uE001'
const HOLE = /\uE000(\d+)\uE001/g

export function normalizeDisplayMath(md) {
  if (!md || md.indexOf('$$') === -1) return md

  const holes = []
  const stash = (s) => `${OPEN}${holes.push(s) - 1}${CLOSE}`

  // 1) Protect code regions so `$$` inside them is left verbatim.
  let out = md
    .replace(/```[\s\S]*?```/g, stash) // fenced ```
    .replace(/~~~[\s\S]*?~~~/g, stash) // fenced ~~~
    .replace(/`[^`\n]*`/g, stash) // inline `code` (single line)

  // 2) A line that is exactly $$…$$ → split into the block form remark-math
  //    recognizes. Non-greedy + end-anchored so it only matches ONE block per
  //    line (not "$$a$$ $$b$$"); leading/trailing whitespace tolerated.
  out = out.replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, (_m, inner) => `$$\n${inner}\n$$`)

  // 3) Restore code.
  out = out.replace(HOLE, (_m, i) => holes[Number(i)] ?? '')

  return out
}

// Promote typed `$$…$$` (single-line) to block math.
//
// Crepe's inline-math input rule fires on the FIRST closing `$` of `$$x²$$`
// (matching `$x²$`), swallowing the content as inline math before the user can
// type the second `$`. handleTextInput runs BEFORE input rules, so we intercept
// the closing `$`:
//   - `$$content$` (one `$` short) → insert `$` as PLAIN TEXT (return true → the
//     inline rule never fires, so the `$$…` survives for one more keystroke).
//   - `$$content$$` (complete)     → replace the whole run with a code_block
//     (language LaTeX). Round-trips as `$$\n…\n$$` (same as paste).
// Single `$content$` (no preceding `$`) is left alone → the inline rule handles
// it normally.
const TYPING_KEY = new PluginKey('hm-math-block-typing')

export function createMathBlockPromotionPlugin() {
  return new Plugin({
    key: TYPING_KEY,
    props: {
      handleTextInput(view, from, _to, text) {
        if (text !== '$') return false
        const $from = view.state.doc.resolve(from)
        const parent = $from.parent
        if (!parent.isTextblock) return false
        const before = parent.textBetween(0, $from.parentOffset, '\n')
        const full = before + '$'

        // `$$content$$` complete → replace the whole run with a code_block.
        const blockMatch = full.match(/\$\$([^\n$]+)\$\$$/)
        if (blockMatch) {
          const codeType = view.state.schema.nodes.code_block
          if (!codeType) return false
          const content = blockMatch[1]
          const start = from - (blockMatch[0].length - 1) // start of `$$content$` in `before`
          const codeNode = codeType.create(
            { language: 'LaTeX' },
            content ? view.state.schema.text(content) : null
          )
          const tr = view.state.tr.replaceWith(start, from, codeNode)
          tr.setMeta('addToHistory', true)
          view.dispatch(tr)
          return true
        }

        // `$$content$` (one `$` short) → insert `$` as plain text, prevent the
        // inline-math input rule from firing on `$content$`.
        if (/\$\$([^\n$]+)\$$/.test(full)) {
          view.dispatch(view.state.tr.insertText('$', from))
          return true
        }
        return false
      }
    }
  })
}
