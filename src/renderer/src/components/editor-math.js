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
// normalizeDisplayMath rewrites a standalone `$$…$$` line into the multi-line
// block form BEFORE parse, so it renders as display math. It is:
//   - idempotent (already-multi-line block math is untouched);
//   - code-safe (fenced ```/~~~ blocks and inline `code` are stashed so `$$`
//     inside code is never touched);
//   - conservative (only lines that are EXACTLY `$$…$$` are rewritten — inline
//     `$x$` and mid-line `text $$x$$ text` are left alone).

// Private-use chars as stash sentinels (never appear in real Markdown, and avoid
// null bytes that trip some tooling).
const OPEN = ''
const CLOSE = ''
const HOLE = new RegExp(`${OPEN}(\\d+)${CLOSE}`)

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
