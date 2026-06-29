// Phase 1 verification: pure-function tests for strikeInputWouldCorruptCriticMarkup.
// Run: node scripts/test-strike-guard.mjs
import { strikeInputWouldCorruptCriticMarkup as wouldCorrupt } from '../src/renderer/src/strikeGuard.js'

let pass = 0
let fail = 0
function check(name, textBefore, typed, expected) {
  let got
  try {
    got = wouldCorrupt(textBefore, typed)
  } catch (e) {
    got = 'THREW: ' + e.message
  }
  const ok = got === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  → got ${got}, want ${expected}`)
  if (ok) pass++
  else fail++
}

// ── MUST flag (would corrupt a CriticMarkup marker) ──────────────────────────
// Typing the new text after the command inserts `{~~旧~>~~}` (cursor after ~>).
check('cmd+type: 新 after {~~旧~>', '{~~旧~>', '新', true)
// Typing the inner tildes of the marker.
check('type ~ after {~~', '{~~', '~', true)
check('type ~ after {~~旧', '{~~旧', '~', true)
// The `~` that forms `~>` separator.
check('type ~ of ~> sep', '{~~旧', '~', true)
// Typing the closing `~~` of the marker — content spans `~>`.
check('type closing ~~ (content spans ~>)', '{~~old~>new~', '~', true)
check('type 2nd closing ~', '{~~old~>new~~', '~', true)
// Typing `}` that closes the marker (match still spans ~>).
check('type closing }', '{~~old~>new~~', '}', true)
// Marker earlier in the line; typing any char would make run() delete to cursor.
check('marker earlier, type a', '{~~old~>new~~} stuff ', 'a', true)
check('marker earlier, type ~ for a later strike', '{~~old~>new~~} x ~~hi', '~', true)
// Typing the ~> separator inside an open {~~ marker (before-match ends with `{`).
check('type ~ to form ~> sep (open marker)', 'note {~~p', '~', true)
check('open {~~old type ~', 'note {~~old', '~', true)
// A ~ sequence BEFORE the opener: exec's leftmost match isn't right after `{`,
// but an unclosed `{~~` is still in the textblock → must block.
check('tilde before unclosed opener', '~x {~~a', '~', true)
// A closed marker earlier still re-triggers exec (leftmost) → block to avoid
// delete-to-cursor corruption; the user loses auto-strike on that line (rare)
// but the marker is safe.
check('plain strike after CLOSED marker (still blocks)', '{~~a~>b~~} ~~', 'x~~', true)

// ── MUST NOT flag (normal strike / unrelated typing) ─────────────────────────
check('plain ~~bold~~ final ~', '~~bol', 'd~~', false)
check('plain single ~hi~ final ~', '~hi', '~', false)
check('plain ~~strike~~ typed fresh', 'some ~~tex', 't~~', false)
check('strike after space', ' ~~h', 'i~~', false)
check('lone ~ not part of strike', 'a~b', 'c', false)
check('no tildes at all', 'hello wor', 'ld', false)
check('heading hash', '#', ' ', false)
check('bold **', '**h', 'i**', false)
// {~~ alone (3 chars) can't form a strike match yet — no content+close — so
// nothing corrupts; the char inserts normally.
check('type ~ after {~ (no match possible)', '{~', '~', false)
// Other CriticMarkup openers use - + = >, which the strike rule (tildes only)
// never matches, so typing near them can't corrupt via strike.
check('{-- open type letter', 'x {--a', 'b', false)
check('{++ open type letter', 'x {++a', 'b', false)
check('{== open type letter', 'x {==a', 'b', false)
check('{>> open type letter', 'x {>>a', 'b', false)
// `~~a~>b` with NO braces is not a CriticMarkup marker; strike may fire — out of scope.
check('~~a~>b no braces', '~~a~>b', '~', false)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
