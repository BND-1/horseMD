# Transaction-first source sync — Phase 1 plain paragraph authority plan

## Status

- Phase: 1 — first authoritative family
- Scope: top-level unmarked plain-paragraph inline replacement only
- Current live publication: legacy remains authoritative by default; explicit authority is allowlisted to the plain-paragraph family
- Parent architecture: `docs/transaction-first-source-sync-migration.md`
- Shadow qualification: `docs/transaction-first-source-sync-phase0-shadow-plan.md`
- Current application version: `0.13.132`
- Current production lifecycle: one shared revision-bound `SourceSyncTransactionJournal`; no private `transactionFirstShadowPending`
- Current structure ownership: exact single-list-subtree journals may publish transaction bytes; unsupported families remain legacy fallback

Phase 1 starts only after Phase 0 has proven that the live editor can capture transaction evidence, compare it with the final legacy candidate, reject unsupported structure, and leave publication unchanged.

This phase does **not** switch the application to transaction-first immediately. It first makes authoritative eligibility a named, testable contract. Live publication can be promoted only after that contract is implemented, shadow-qualified, and safely wired against a clean `Editor.jsx` baseline.

## Current checkpoint (2026-08-27)

Phase 1 production wiring now consumes the shared `SourceSyncTransactionJournal`. Dispatch captures revision/source/canonical/oldDoc, complete transaction batches, per-Step documents and StepMaps once; `plain-paragraph-transaction-owner.js` classifies and maps the complete journal at callback/forced-flush time. The old scalar `transactionFirstShadowPending` and per-dispatch whole-document SourceRangeMap lifecycle are removed from `Editor.jsx`; the historical module remains compatibility-test-only.

The default application still publishes ordinary paragraphs through legacy unless the explicit authority gate is enabled. Shadow, authority, 1000-paragraph BOM/CRLF, list subtree callback/forced-flush, 39/39 source probes and adjacent high-risk list/input-rule UI matrices are green. Code-block, table, quote and other unported structural journals remain outside this authority family.

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

RS-75 adds no new source mapper. It only vetoes whole-row deletion when raw tail identity proves an in-place list edit: identical raw prefix, indent, marker token and marker spacing, with body changing from non-empty to blank/`<br />`. The existing `diverged-nested-list-change` mapper then owns the body-empty transition. A dedicated core regression also proves genuine tail row deletion is still owned by `diverged-tail-line-delete`. The real `引用后输入手测.md + plain` cell now passes append/save/delete/reopen.

### 2026-08-25 — RS-76 leading-space sentinel tail lifecycle

The remaining `list-spaces` first divergence was another legacy source-owner gap. The test deliberately leaves leading whitespace in a bullet item after deleting its marker text. Before deletion, canonical uses `&#x20;` while authored source uses U+200B as source-only syntax. After the body is deleted to whitespace-only, the serializer emits a spaces-only bullet row. On the heavily diverged fixture no generic visible mapper can identify that zero-visible edit, and the old sentinel post-process never runs because core already returned `visible-stream-mismatch`.

RS-76 adds a tail-only owner with a full raw proof: canonical prefixes before the last row are byte-identical; previous last row is a bullet with `&#x20;` plus non-whitespace text; next last row keeps the same canonical bullet/indent and contains only horizontal whitespace; authored source ends in a matching sentinel-backed bullet whose decoded body equals canonical previous. Only then does it replace the authored final row, preserve its bullet token, copy the spaces-only suffix, and remove U+200B. Parsing confirms leaving U+200B after visible body deletion would turn it into real paragraph text. The real `引用后输入手测.md + list-spaces` cell now passes the full cycle under the unchanged semantic/list-slot integrity gate. The subsequent 0.13.121 full matrix confirmed the entire fixture 5/5.

### 2026-08-25 — RS-77 localized sentinel reconciliation after body deletion

The same sentinel lifecycle appeared through a different legacy path on `11111.md + list-spaces`. Here core did **not** fail closed: `localized-change` successfully mapped the edit but left `* U+200B  ` in its candidate. The facade already invoked `reconcileLeadingSpaceSentinelTransition`, yet that helper located result rows by the previous visible body. Once the body became empty, the lookup could no longer find the patched sentinel row, and strict semantic/list-slot validation correctly rejected the candidate.

RS-77 extends only that post-process. When the ordinary previous-visible result lookup returns nothing and `nextVisible` is empty, it may use the exact source line ordinal only if the source sentinel row is uniquely proven, source/result line counts are unchanged, the corresponding result line still contains the sentinel, and removing it makes that row's visible text exactly equal to `nextVisible`. The dedicated core test, full markdown-preservation suite, build, and real `11111.md + list-spaces` cycle pass. The 0.13.121 full matrix before this fix was 18/20; the formal 0.13.122 rerun reached **19/20**, with all `11111.md` cells green and only `反馈.md + plain` remaining.

### 2026-08-25 — RS-78 globally-diverged tail bullet body-empty ownership

The final 19/20 baseline blocker was another exact ownership gap. `反馈.md` already ends inside a bullet list, so the family `plain` append actually creates a new bullet item. On reopen, authored source ends in `- 而为` while canonical ends in `* 而为`. Deleting the body leaves the same PM list slot as `* <br />`, but the document's earlier blockquote/list structural divergence makes global visible mapping ambiguous and core returns `visible-stream-mismatch`. A simple one-divergence synthetic did not reproduce the failure, so the permanent regression retains the complete captured source/canonical triple rather than broadening a generic mapper.

RS-78 adds one final-row-only proof before generic diverged mapping. Previous and next canonical prefixes before the final content row must be byte-identical; both final rows must be the same bullet indent/token/spacing with only non-empty→empty body change; authored source must itself end in a same-indent bullet whose body visible text equals canonical previous. Only then is the authored final body removed, preserving its original marker spelling, spacing, EOL, and all earlier bytes. RS-76's sentinel-specific owner stays earlier in dispatch. The dedicated RS-78 core regression, full markdown-preservation suite, source structure fingerprint, 35/35 probes, source-transaction-sync, build, and real `反馈.md + plain` cycle pass. The formal 0.13.123 four-file × five-operation matrix also passes 20/20.

The legacy automated baseline is no longer the Phase 1 blocker. A clean-baseline isolation run removed the complete 44-line transaction-first shadow live wiring from `Editor.jsx`, rebuilt 0.13.123, and reran the full four-file × five-operation matrix: the pure legacy path still passed 20/20 / exit 0. The shadow wiring was then restored byte-for-byte. This proves the family baseline does not depend on transaction-first telemetry, even though the accumulated dirty tree is still too broad to turn that proof into a clean branch commit without risking unrelated history.

Live authority is qualified behind a separate development-only gate, `globalThis.__hmTransactionFirstAuthority === true`; it is not aliased to the historical broad `__hmTransactionSourcePrimary` flag and remains off by default. RS-79 exposed one final ordering error in that wiring: an owned authoritative transaction still waited until after legacy preservation/integrity, so a legacy candidate could emit a transient `ok=false` before transaction-first replaced the final publication. The live callback now performs an early reconcile only for an exact owned, allowlisted `plain-paragraph-inline-replace` snapshot whose callback canonical matches the current PM document; it publishes transaction bytes before legacy preservation. Rejected, syntax-sensitive, structural, list, paste, generated-scratch, stale, or otherwise unproven checkpoints are not consumed and continue through the existing legacy fallback plus late reconcile.

Long-document qualification also forced a SourceRangeMap performance correction. The scalar `pmPosToMarkdownOffset()` reparses and recollects the full document on every call, while Phase 1 needs start/end positions for every eligible paragraph. `createPmPosToMarkdownOffsetMapper()` now prepares one immutable parse/block snapshot per SourceRangeMap and reuses the same mapping logic for all positions; the scalar API remains compatible. A 1000-paragraph, >120KB, BOM+CRLF authority-on Electron regression edits an early paragraph, a middle paragraph, and a tail paragraph. All three publish transaction bytes, the entire run records zero `integrity ok=false`, source mode matches exactly, save preserves BOM/CRLF and untouched bytes, and observed edit-to-reconcile timings were approximately 0.7s, 0.7s, and 1.75s. The small authority UI still proves Markdown-sensitive `*`, paragraph Enter/split, and list Backspace publish legacy bytes; shadow/policy/core/source-map/markdown-preservation/source-transaction-sync are green, and with the authority flag off the full 4×5 family matrix remains 20/20.

See `docs/diverged-tail-image-delete-regression.md` and RS-73 in `docs/rich-source-fidelity-bug-family.md`.

### 2026-08-27 — shared revision-bound journal production migration

- added `lib/source-sync/transaction-journal.js` as the only production transaction lifecycle;
- journal entries now retain per-Step documents as well as StepMaps, allowing focused owners to replay exact multi-transaction chains;
- added `plain-paragraph-transaction-owner.js`; it consumes the shared journal and owns no mutable checkpoint state;
- removed `transactionFirstShadowPending`, `advanceTransactionFirstSourceSync()` and `buildPlainParagraphSourceRangeMap()` from production `Editor.jsx` wiring;
- callback and forced flush now plan list/plain ownership from the same journal and publish through `SourceSyncCoordinator`;
- fixed normalized→raw boundary maintenance for a journal that inserts in one block and later replaces another block; terminal newline and authored EOL bytes remain intact;
- the old transaction-first core remains temporarily for policy/compatibility pure tests only.

Validation at this checkpoint:

- production build — PASS;
- shared journal, plain owner, list owner, mapper and Coordinator pure contracts — PASS;
- shadow UI and authority UI — PASS;
- 1000-paragraph BOM/CRLF authority UI — PASS;
- list callback + immediate forced-flush + save + cold reopen — PASS;
- source fidelity probes — PASS, 39/39;
- RS68 at 5/18/70 ms, RS84, RS85, nested ordered Enter and task Enter/fill — PASS.

## Exit criteria

Phase 1 is complete only when:

- [x] the authoritative family is explicitly classified,
- [x] structural `ReplaceStep` lookalikes are rejected before mapping,
- [x] byte/semantic proof remains fail-closed,
- [x] shadow evidence covers insertion/deletion/replacement and key negative families,
- [x] exact BOM/CRLF behavior is covered,
- [x] authoritative coordinator tests prove transaction publication and fallback behind an explicit family allowlist,
- [ ] live authority is committed from a clean Editor baseline (technical isolation and UI qualification are complete; branch checkpoint remains blocked by the broad accumulated dirty tree),
- [x] explicit live authority flag owns plain insert/delete/rapid replace and falls back for syntax/split/list UI cases,
- [x] current shadow source/integrity/UI regressions remain green,
- [x] automated 1000-paragraph BOM/CRLF authority-on qualification shows zero first-divergence integrity failures and exact source/save bytes,
- [ ] manual long-document qualification shows no first-divergence integrity failure.

Until every live-promotion criterion is met, Phase 1 remains a migration branch capability rather than normal application behavior.
