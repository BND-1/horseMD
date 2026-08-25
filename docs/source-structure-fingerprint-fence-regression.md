# RS-74: list-slot fence scanner swallowed later lists

## Status

Fixed in the 0.13.119 working candidate. This report covers only the source-structure fingerprint scanner. It does **not** close the remaining `plain` / `list-spaces` family failures or the separate literal triple-backtick semantic-integrity failure.

## First divergence

The real fixture `HorseMD-0.13.33-引用后输入手测.md` contains same-line literal triple-backtick text, for example ```` ```你好``` ````. The old `source-structure-fingerprint.js` scanner treated the opening run as a fenced-code opener. Because it did not validate the opener constraints, it entered an unterminated fence state and skipped every later physical line. Real ordered and unordered list slots after that text therefore disappeared from the source-side fingerprint.

The parser/semantic document could still be usable, but the strict list-slot gate compared different structural regions between authored source and canonical Markdown. The original family cell failed as `source-locked-after-append` / `source-list-structure-mismatch`.

## Root cause

The list-slot fingerprint is intentionally smaller than the Markdown parser AST, but its fenced-code exclusion still has to respect fence boundaries. The old scanner was too broad in two ways:

1. a backtick fence opener was accepted even when its info string itself contained backticks, so same-line literal ```` ```你好``` ```` was misclassified;
2. closing runs were not tied tightly enough to opener character, opener length, and trailing-content rules.

This was a fingerprint-scanner bug, not a reason to weaken semantic or list-slot integrity validation.

## Fix contract

`source-structure-fingerprint.js` now uses an explicit opener descriptor `{ char, length }`.

- opener: 0–3 leading spaces followed by at least three backticks or tildes;
- backtick opener: remaining info text must not contain another backtick;
- closer: same fence character as opener;
- closer length: at least the opener run length;
- closer suffix: whitespace only.

As a result, same-line literal triple-backtick text is ordinary text for the fingerprint, while genuine fenced-code contents remain excluded from list-slot validation.

## Permanent core regression

`scripts/test-source-structure-fingerprint.mjs` now proves three boundaries:

1. same-line ```` ```你好``` ```` does not hide a later `1. ...` list slot;
2. a three-backtick line cannot close an opener of four backticks;
3. a would-be closing fence with trailing body text does not close the fence.

The pre-existing genuine fenced-code exclusion test remains green.

## Real fixture evidence

Verified on the 0.13.118 codebase plus the RS-74 scanner change before the version bump:

- `node scripts/test-source-structure-fingerprint.mjs` — PASS;
- `npm run build` — PASS;
- `HorseMD-0.13.33-引用后输入手测.md + ordered` — append/save/delete/reopen full cycle PASS;
- same fixture `unordered` — PASS;
- same fixture `spaces` — PASS;
- `npm run test:source-fidelity-probes` — 35/35 PASS;
- `npm run test:source-transaction-sync` — PASS.

The full fixture matrix still exposes independent failures and must remain fail-closed:

- `plain`: delete stage reaches `diverged-tail-line-delete`, then the candidate has one fewer empty ordered slot than the current PM/canonical structure (`list-slot-count` mismatch);
- `list-spaces`: delete stage returns `visible-stream-mismatch` and the source remains locked.

These are follow-up first divergences, not extensions of the fence scanner rule.

## Separate triple-backtick semantic failure

`test:literal-triple-backtick-source-ui` currently fails before source mode opens. Temporary trace instrumentation showed the stored candidate as `# ```你好````, while the canonical representation escapes the backticks. Re-parsing the authored candidate produces an `inlineCode` mark, so semantic integrity rejects it. Crucially the same trace reports `listSlotsMatch=true`.

Therefore that failure is outside RS-74: the list-slot scanner is no longer the failing proof. It must be handled as a separate source/semantic ownership problem rather than by weakening the scanner or integrity gate.
