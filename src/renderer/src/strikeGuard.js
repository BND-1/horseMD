// CriticMarkup-vs-GFM-strikethrough guard (pure predicate, no imports).
//
// The GFM strikethrough INPUT RULE (node_modules/@milkdown/preset-gfm) is:
//   markRule(/(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)/, strikethroughSchema.type(ctx))
//
// prosemirror-inputrules' run() applies a rule with:
//   textBefore = parent.textBetween(... up to cursor ...) + typed
//   match = rule.match.exec(textBefore)      // exec matches ANYWHERE, not at cursor
//   if (match && match[0].length >= typed.length) handler(state, match, startPos, to)
//
// There is NO "match must end at the cursor" check. So when the user types
// inside/near a CriticMarkup substitution `{~~old~>new~~}`, exec matches the
// marker's inner tildes (e.g. `~~old~` or `~~old~>new~~`). markRule then:
//   - deletes the `~~` delimiters,
//   - addMark's the captured content,
//   - and crucially `tr.delete(textEnd, to)` — which DELETES from the marker to
//     the cursor when the match is earlier in the line.
// That destroys the marker and can wipe the line — the "替换 corrupts / deletes
// my line" bug. It fires for ANY typed character whenever a literal `{~~…~~}`
// sits earlier in the same textblock, not only for `~`.
//
// This predicate replicates that exec and decides whether the imminent strike
// match would corrupt a CriticMarkup context. The guard plugin (Editor.jsx)
// uses it to insert the typed text LITERALLY (bypassing input rules) when it
// would, so the marker survives as plain text and renders via the text-scan
// path — while plain `~~strike~~` (no CriticMarkup around) is left untouched.

export const STRIKETHROUGH_INPUT_RE = /(?<![\w:\/])(~{1,2})(.+?)\1(?!\w|\/)/

const CRITIC_OPENERS = ['{~~', '{--', '{++', '{==', '{>>']

function lastUnclosedCriticOpener(text) {
  let best = -1
  for (const op of CRITIC_OPENERS) {
    const at = text.lastIndexOf(op)
    if (at > best) best = at
  }
  if (best === -1) return -1
  // Is there a closing `}` after this opener? CriticMarkup markers all close
  // with `}` (possibly `~~}`/`++}`/`--}`/`==}<<}`/`<<}`), so a bare `}` marks
  // the marker complete.
  return text.indexOf('}', best) === -1 ? best : -1
}

// textBefore: the text in the current textblock from its start up to (but not
// including) the insertion point — mirroring prosemirror-inputrules' textBefore
// (capped at 500 chars). typed: the text about to be inserted. Returns true if
// letting the strikethrough input rule run would corrupt a CriticMarkup marker.
export function strikeInputWouldCorruptCriticMarkup(textBefore, typed) {
  const before = String(textBefore == null ? '' : textBefore)
  const full = before + (typed == null ? '' : typed)
  const m = STRIKETHROUGH_INPUT_RE.exec(full)
  if (!m) return false

  const matchStart = m.index
  const matchEnd = m.index + m[0].length
  const textBeforeMatch = full.slice(0, matchStart)
  const textAfterMatch = full.slice(matchEnd)
  const content = m[2] || ''

  // 1) The captured strike content spans a substitution separator — the marker
  //    is `~~old~>new~~` and the rule is eating across `~>`.
  if (content.includes('~>')) return true
  // 2) The strike opens immediately after `{` — the `~~` of `{~~…`.
  if (textBeforeMatch.endsWith('{')) return true
  // 3) The strike closes immediately before a marker closer (`}` / `~}`).
  if (/^(?:~?\})/.test(textAfterMatch)) return true
  // 4) An unclosed CriticMarkup opener anywhere in this textblock — the user is
  //    typing inside/near a marker that hasn't been closed yet, so a strike
  //    match (which exec finds anywhere, even before the opener) risks eating
  //    part of it. Closed markers (a `}` follows the opener) don't count.
  if (lastUnclosedCriticOpener(full) !== -1) return true

  return false
}
