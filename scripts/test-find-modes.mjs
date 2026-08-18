// Pure-logic tests for the find match options (issue: VSCode-style find modes).
// Covers matchCase / wholeWord / regex / multiline / in-selection primitives in
// find.js — the DOM (Highlight API, textarea overlay, ProseMirror wiring) is
// covered by scripts/test-find-modes-ui.mjs.
// Run: node scripts/test-find-modes.mjs
import {
  compileFindMatcher,
  expandReplacement,
  matchIndices
} from '../src/renderer/src/find.js'

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
  if (ok) pass += 1
  else fail += 1
}

const starts = (hits) => hits.map((hit) => hit.start)
const both = (hits) => hits.map((hit) => [hit.start, hit.end])

// ── case sensitivity ─────────────────────────────────────────────────────────
check('default is case-insensitive',
  starts(matchIndices('Hello hello HELLO', 'hello')), [0, 6, 12])
check('matchCase finds only exact case',
  starts(matchIndices('Hello hello HELLO', 'hello', { matchCase: true })), [6])
check('matchCase with CJK query still matches',
  starts(matchIndices('苹果 苹果', '苹果', { matchCase: true })), [0, 3])

// ── whole word ───────────────────────────────────────────────────────────────
check('wholeWord skips catfish/catalog/CAT-adjacent runs',
  starts(matchIndices('A cat, catfish, catalog. CAT!', 'cat', { wholeWord: true })), [2, 25])
check('wholeWord + matchCase is exact',
  starts(matchIndices('Cat cat CAT', 'Cat', { wholeWord: true, matchCase: true })), [0])
check('wholeWord treats CJK as word chars (no inner-CJK match)',
  starts(matchIndices('红苹果香 苹果', '苹果', { wholeWord: true })), [5])
check('wholeWord treats underscore as a word char',
  starts(matchIndices('foo_bar foo', 'foo', { wholeWord: true })), [8])

// ── regex ────────────────────────────────────────────────────────────────────
check('regex matches carry variable-length extents',
  both(matchIndices('12px and 5px', /\d+px/.source, { regex: true })), [[0, 4], [9, 12]])
check('regex matchCase restricts classes',
  starts(matchIndices('AB ab CD', '[A-Z]{2,}', { regex: true, matchCase: true })), [0, 6])
check('regex without matchCase widens classes',
  starts(matchIndices('AB ab CD', '[A-Z]{2,}', { regex: true })), [0, 3, 6])
check('invalid regex reports an error instead of throwing',
  compileFindMatcher('[', { regex: true }).error, 'invalid-regex')
check('invalid regex yields zero matches',
  matchIndices('a[b', '[', { regex: true }), [])
check('zero-width regex parts are skipped without hanging',
  both(matchIndices('aabaa', 'a*', { regex: true })), [[0, 2], [3, 5]])
check('plain queries keep non-overlapping advances',
  starts(matchIndices('aaaa', 'aa')), [0, 2])

// ── multiline ────────────────────────────────────────────────────────────────
check('regex ^/$ anchor per line (m flag)',
  starts(matchIndices('start\nmiddle\nend', '^end$', { regex: true })), [13])
check('plain multiline query matches across lines',
  starts(matchIndices('x\nline1\nline2\ny', 'line1\nline2')), [2])
check('multiline plain query does not match a gap',
  matchIndices('line1\nzzz\nline2', 'line1\nline2'), [])
check('regex spans lines with [\\s\\S]',
  both(matchIndices('foo\nbar', 'foo[\\s\\S]bar', { regex: true })), [[0, 7]])

// ── replacement templates ────────────────────────────────────────────────────
check('regex replacement expands capture groups',
  expandReplacement('John Smith', '$2 $1', '(\\w+) (\\w+)', { regex: true }), 'Smith John')
check('regex replacement supports $& and $$',
  expandReplacement('12px', '$& and $$', '\\d+px', { regex: true }), '12px and $')
check('plain replacement is verbatim ($1 is literal)',
  expandReplacement('John Smith', '$1', '(\\w+)', { regex: false }), '$1')
check('replacement on invalid regex falls back verbatim',
  expandReplacement('x', '$1', '[', { regex: true }), '$1')

// ── in-selection scoping primitive (offset filtering used by the hook) ───────
const scoped = (text, query, sel, opts = {}) =>
  matchIndices(text, query, opts).filter((hit) => hit.start >= sel[0] && hit.end <= sel[1])
check('in-selection keeps only fully-contained matches',
  starts(scoped('cat cat cat', 'cat', [4, 10])), [4])
check('in-selection + regex combo',
  both(scoped('1x 2x 3x', '\\dx', [3, 7], { regex: true })), [[3, 5]])

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} find-modes: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
