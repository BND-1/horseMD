# Transaction-first source sync — Phase 1 plain paragraph authority plan

## Status

- Phase: 1 — first authoritative family
- Scope: top-level unmarked plain-paragraph inline replacement only
- Current live publication: legacy remains authoritative
- Parent architecture: `docs/transaction-first-source-sync-migration.md`
- Shadow qualification: `docs/transaction-first-source-sync-phase0-shadow-plan.md`

Phase 1 starts only after Phase 0 has proven that the live editor can capture transaction evidence, compare it with the final legacy candidate, reject unsupported structure, and leave publication unchanged.

This phase does **not** switch the application to transaction-first immediately. It first makes authoritative eligibility a named, testable contract. Live publication can be promoted only after that contract is implemented, shadow-qualified, and safely wired against a clean `Editor.jsx` baseline.

## Objective

Promote one deliberately narrow transaction family:

```text
one user edit
  -> one docChanged PM transaction
  -> one ReplaceStep
  -> from/to stay inside one mapped top-level paragraph
  -> old and new paragraph are plain text with no marks/atoms
  -> inserted slice is inline plain text only
  -> source bytes at the owned range match the removed PM text
  -> candidate parses to the expected PM document
  -> transaction-first patch may own publication
```

Everything else falls back.

The target is not “all ReplaceStep edits”. `ReplaceStep` is an implementation shape, not proof of user intent. A structural split, list lift, marked replacement, syntax input rule, or empty-block transition may also involve a `ReplaceStep` and must not be promoted merely because its constructor name matches.

## Authoritative family name

The first promotable family is:

`plain-paragraph-inline-replace`

It includes, when all proofs below pass:

- inserting ordinary text inside a non-empty top-level paragraph,
- deleting ordinary text while the paragraph remains non-empty,
- replacing a selection inside one paragraph with ordinary unmarked text,
- edits at the beginning or end of the paragraph when the inserted bytes are not Markdown block-prefix syntax,
- the same operations in duplicate-text paragraphs, provided the SourceRangeMap identifies exactly one PM paragraph/source range.

## Explicit exclusions

Phase 1 must reject:

- headings,
- blockquotes,
- list items and task items,
- table cells,
- fenced/indented code blocks,
- inline code or any marked text,
- inline atoms such as images/math/HTML nodes,
- empty paragraphs without a proven source slot,
- edits that empty a previously non-empty paragraph,
- paragraph Enter/split operations,
- paragraph merge/join operations,
- `ReplaceAroundStep` and every non-`ReplaceStep` family,
- multiple doc-changing transactions in one captured batch,
- multiple steps in the owned transaction,
- slices with open edges or block content,
- Markdown-sensitive inserted syntax already rejected by the source mapper,
- block-prefix-sensitive insertions already rejected by the source mapper,
- stale source maps,
- stale source checkpoints,
- stale callback documents,
- composition / paste / programmatic replace / generated-scratch / list-input-rule flows already excluded by the editor controller.

Paragraph split/merge support remains useful code in the legacy transaction mapper, but it is **not** part of the first authoritative promotion family. Structural paragraph operations need their own family and lifecycle evidence.

## Ownership proof

Add an exported classifier to `transaction-first-source-sync.js`:

```text
classifyPhaseOnePlainParagraphTransaction(...)
```

The classifier must prove all of the following before the source mapper runs:

1. Exactly one `docChanged` transaction exists.
2. That transaction contains exactly one step.
3. The step is a `ReplaceStep` with finite `from` / `to`.
4. The step's `before` document matches the captured old document.
5. `from` and `to` resolve inside the same parent.
6. The parent is a **top-level paragraph** (`depth === 1`).
7. The old paragraph contains only unmarked text.
8. The replacement slice is empty or contains only closed, unmarked text nodes.
9. One and only one Phase-0 SourceRangeMap entry owns the entire PM range.
10. The post-step node at the same top-level start remains a non-empty plain paragraph.
11. The transaction's final document equals the captured `newState.doc`.

The existing byte and semantic proofs then run as a second layer:

- raw source range equals removed PM text,
- raw block body equals old PM paragraph text,
- syntax-sensitive insertion checks,
- exact authored BOM/CRLF preservation,
- parser semantic equality with the expected document.

The classifier answers “is this transaction family allowed to ask for authority?” The mapper answers “does this exact source snapshot prove byte ownership?” Both must pass.

## Result contract

Owned candidates should carry:

- `family: 'plain-paragraph-inline-replace'`
- `ok: true`
- `reason: 'plain-text-transactions'`
- exact authored `markdown`
- bounded source-map/step telemetry

Rejected candidates should preserve the original source and expose a stable Phase-1 reason where the classifier rejected before mapping.

Suggested classifier reasons:

- `phase1-changed-transaction-count`
- `phase1-step-count`
- `phase1-step-not-replace`
- `phase1-transaction-chain-mismatch`
- `phase1-unresolvable-range`
- `phase1-cross-parent-range`
- `phase1-non-top-level-paragraph`
- `phase1-non-plain-source-paragraph`
- `phase1-structural-slice`
- `phase1-range-outside-source-map`
- `phase1-result-not-plain-paragraph`
- `phase1-result-empty-paragraph`
- `phase1-final-document-mismatch`

Mapper rejection reasons remain mapper-owned and should not be rewritten, for example:

- `syntax-sensitive-insert`
- `block-prefix-sensitive-insert`
- `raw-range-text-mismatch`
- `semantic-document-mismatch`

This separation makes telemetry answer whether failure was **family ownership** or **byte/semantic proof**.

## Publication rule

When authoritative wiring is eventually enabled, transaction bytes may publish only if:

```text
classifier owned
AND source-range snapshot exact
AND source mapper ok
AND semantic validator ok
AND editor flow gate allows transaction authority
```

Any failure uses the established legacy path. There is no partial transaction patch and no mixed owner inside one batch.

For the first promotion, authority should remain separately gated from the historical `__hmTransactionSourcePrimary` experiment. Prefer a transaction-first rollout mode/feature flag whose meaning is tied to this classifier rather than silently reusing a broader old experiment.

## Shadow promotion evidence

Before live authority:

- ordinary insertion: byte-equal,
- ordinary deletion: byte-equal,
- same-paragraph replacement: byte-equal,
- paragraph start/end edits: byte-equal when syntax-safe,
- duplicate paragraph: byte-equal on the correct occurrence,
- BOM + CRLF document: byte-equal and exact raw convention preserved,
- syntax-sensitive input: rejected,
- marked paragraph: rejected,
- paragraph Enter/split: rejected by Phase-1 classifier,
- list/quote/table edit: rejected,
- rapid/coalesced callbacks: stale/rejected rather than mis-owned,
- undo/redo of an eligible inline edit: either explicitly classified and proven or remains fallback; do not inherit authority accidentally.

No warning toast is permitted for expected shadow rejection/staleness.

## Tests

### Core classifier tests

Extend `scripts/test-transaction-first-source-sync.mjs` with:

- plain insertion owned and family named,
- plain deletion owned while paragraph remains non-empty,
- same-paragraph selection replacement owned,
- heading rejected,
- marked paragraph rejected,
- list paragraph rejected,
- paragraph split rejected as structural slice,
- non-ReplaceStep rejected,
- deletion-to-empty rejected,
- duplicate paragraph maps only its owning entry,
- stale source map remains rejected before authority.

### Live shadow tests

Extend `scripts/test-transaction-first-shadow-ui.mjs` only with deterministic cases. Do not make CI depend on timing-sensitive stale classifications unless the callback timing is explicitly controlled.

### Regression floor

Keep green:

```sh
node scripts/test-editor-source-map.mjs
npm run test:source-transaction-sync
node scripts/test-transaction-first-source-sync.mjs
node scripts/test-transaction-first-shadow-ui.mjs
npm run test:source-fidelity-probes
npm run build
```

## Rollout steps

### 1. Contract only

- add the classifier,
- add family metadata,
- add core tests,
- keep live publication unchanged.

### 2. Shadow qualification

- run the classifier in the existing Phase-0 capture path,
- collect family-specific `byte-equal` / rejection evidence,
- expand live deterministic coverage.

### 3. Prepare authoritative coordinator

- add an explicit transaction-first authoritative gate for this family,
- prove fallback on every classifier/mapper/semantic failure,
- test publication owner selection without changing normal app behavior.

### 4. Live promotion

Only after the `Editor.jsx` dirty baseline is safely checkpointed:

- wire the explicit Phase-1 authority gate,
- keep legacy fallback intact,
- run full regression + UI matrix,
- manually edit a long document with source toggles/save/reopen,
- inspect first-divergence telemetry, not merely final self-healed state.

## Commit strategy

- plan doc first,
- classifier + unit tests in a separate clean commit,
- live qualification tests in separate test commits,
- `Editor.jsx` authority wiring in its own commit only after the existing dirty baseline is safe,
- never stage unrelated RS changes to make the migration commit convenient.

## Phase 1 progress ledger

### 2026-08-25 — ownership contract

- plan: `612dab7 docs(editor): plan plain paragraph authority`,
- classifier/core implementation: `fd1116f refactor(editor): classify plain paragraph authority`,
- family: `plain-paragraph-inline-replace`,
- paragraph split is proven to be a real `ReplaceStep` lookalike and is rejected as `phase1-structural-slice` before mapping.

### 2026-08-25 — deferred callback chain prerequisite

Live qualification proved that one scalar pending checkpoint loses A -> B -> C transaction evidence before deferred `markdownUpdated`. The dedicated follow-up plan and implementation are recorded in `docs/transaction-first-source-sync-phase1-shadow-chain-plan.md`:

- plan: `5aa6f9d`,
- core accumulator: `c688d5b`,
- rapid live qualification: `d66bedf`.

This prerequisite is now satisfied in core and in the current shadow-only working-tree wiring. Normal application publication remains legacy-owned.

### 2026-08-25 — authoritative publication policy

- implementation: `ba30242 refactor(editor): gate transaction-first authority`,
- exported family allowlist contract: `TRANSACTION_FIRST_FAMILIES.PLAIN_PARAGRAPH_INLINE_REPLACE`,
- exported pure selector: `selectTransactionFirstPublication()`,
- `AUTHORITATIVE` mode alone no longer grants publication ownership,
- transaction publication requires: matching snapshot, successful mapped transaction, complete chain family, and explicit family allowlist,
- shadow/observe, stale snapshot, rejected transaction, missing/mismatched/unallowed family all fall back to legacy (or the source checkpoint when no legacy candidate exists),
- immediate and deferred reconcile coordinators now share the same selector,
- dedicated policy regression: `scripts/test-transaction-first-authority-policy.mjs`.

Validation after the policy gate:

- authority policy/core/chain tests — PASS,
- source map — PASS, 11 groups,
- legacy source transaction mapper — PASS,
- source fidelity probes — PASS, 35/35,
- build — PASS,
- live shadow UI — PASS; normal application publication remains legacy-owned.

### 2026-08-25 — clean-baseline A/B and RS-73

Before committing live authority, the current dirty `Editor.jsx` shadow wiring was temporarily removed and the legacy source-fidelity baseline was rebuilt and exercised independently. The same family failures reproduced with shadow wiring absent and after it was restored, so transaction-first observation is not the cause of those divergences.

The first actionable baseline divergence was `123321.md + plain` (RS-73): after deleting the appended marker, structural Backspace moved into the previous deeply nested ordered item and the next Backspace deleted an inline image atom. Authored source kept that image as a standalone tail row while canonical attached it to the nested list; because the atom has no visible characters, the legacy generic mapper returned `visible-stream-mismatch`. This was fixed in the legacy preservation path with a strict `diverged-tail-image-delete` owner rather than by widening transaction-first eligibility or visible mapping.

Post-fix evidence:

- RS-73 dedicated core regression — PASS,
- markdown-preservation regression — PASS,
- build — PASS,
- focused real `123321.md` first-divergence trace — `ok=true`, no warning toast,
- all five `123321.md` family cells — PASS,
- complete 4×5 family matrix — **still not all green**; independent failures remain in `HorseMD-0.13.33-引用后输入手测.md` and `反馈.md`.

### 2026-08-25 — RS-74 list-slot fence scanner baseline repair

The next first divergence in `HorseMD-0.13.33-引用后输入手测.md` was not caused by transaction-first observation. The legacy list-slot fingerprint scanner treated same-line literal ```` ```你好``` ```` as an unterminated fenced-code opener and therefore hid all later list slots from strict structure validation. RS-74 fixes only that scanner boundary: backtick opener info may not contain backticks, and a closing fence must use the same character, be at least as long as the opener, and contain only trailing whitespace.

Post-fix baseline evidence: the original `ordered` cell now passes append/save/delete/reopen, `unordered` and `spaces` on the same fixture also pass, core fence regressions pass, build passes, source-fidelity probes remain 35/35, and source-transaction-sync remains green. At the RS-74 checkpoint the fixture still had a later `plain` delete failure plus `list-spaces`; those are tracked independently. Separately, the literal triple-backtick UI currently fails semantic integrity because `# ```你好```` reparses with an `inlineCode` mark; its trace has `listSlotsMatch=true`, so it is not part of RS-74.

### 2026-08-25 — RS-75 adjacent empty ordered-slot delete ownership

The next `plain` first divergence was again a legacy ownership bug, not a transaction-first shadow effect. The tail had one already-empty ordered slot followed by `1) 测试`. Deleting that body produced a second empty slot. Because both empty list bodies have no visible text, the broad tail delete proof treated the newly emptied `1)` row as if it had disappeared and the previous empty slot had become the tail. It deleted the authored row and failed strict list-slot count validation.

RS-75 adds no new source mapper. It only vetoes whole-row deletion when raw tail identity proves an in-place list edit: identical raw prefix, indent, marker token and marker spacing, with body changing from non-empty to blank/`<br />`. The existing `diverged-nested-list-change` mapper then owns the body-empty transition. A dedicated core regression also proves genuine tail row deletion is still owned by `diverged-tail-line-delete`. The real `引用后输入手测.md + plain` cell now passes append/save/delete/reopen. `list-spaces` remains the next independent baseline failure.

Therefore Phase 1 live authority remains blocked. The migration gate is doing its intended job: baseline failures are being separated from shadow behavior before publication ownership changes. Do not mark the clean-baseline or long-document criteria complete until the remaining first divergences are independently resolved or explicitly quarantined by a proven contract.

See `docs/diverged-tail-image-delete-regression.md` and RS-73 in `docs/rich-source-fidelity-bug-family.md`.

## Exit criteria

Phase 1 is complete only when:

- [x] the authoritative family is explicitly classified,
- [x] structural `ReplaceStep` lookalikes are rejected before mapping,
- [x] byte/semantic proof remains fail-closed,
- [x] shadow evidence covers insertion/deletion/replacement and key negative families,
- [x] exact BOM/CRLF behavior is covered,
- [x] authoritative coordinator tests prove transaction publication and fallback behind an explicit family allowlist,
- [ ] live authority is committed from a clean Editor baseline,
- [x] current shadow source/integrity/UI regressions remain green,
- [ ] manual long-document qualification shows no first-divergence integrity failure.

Until every live-promotion criterion is met, Phase 1 remains a migration branch capability rather than normal application behavior.
