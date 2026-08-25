# Transaction-first source synchronization migration

## Status

This document defines the incremental migration from HorseMD's serializer-diff-first source preservation model to transaction-first source synchronization.

The migration is intentionally additive. The current preservation, integrity, save/reopen and source-fidelity regression systems remain the safety net until a transaction family has independently earned ownership.

## Why migrate

HorseMD currently has to reconstruct user intent after Crepe/ProseMirror has already changed the document and Crepe has serialized a new canonical Markdown snapshot. The preservation layer compares four different views:

- the last authored Markdown source,
- the previous canonical Markdown,
- the next canonical Markdown,
- the current ProseMirror document.

For ordinary text this is often sufficient. For structural Markdown it is inherently ambiguous because one rich-text tree can have many valid source spellings: `-` vs `*`, `1.` vs `1)`, tight vs loose lists, task sentinels, empty-item placeholders, serializer marker normalization, and `<br />` placeholders.

That means one user action can produce several serializer-only changes near the real edit. A post-serialization mapper must then infer which bytes express user intent and which bytes are formatter noise. Recent RS regressions have repeatedly shown that an individually reasonable mapper can claim the wrong structural transaction when its ownership proof is wider than the user's actual edit.

Timing makes this harder. Several ProseMirror transactions can be coalesced before a deferred `markdownUpdated` callback, so the preservation layer may observe `A -> D` without the semantically useful intermediate states `B` and `C`.

The long-term source of truth should therefore move earlier in the pipeline:

```text
user input
  -> ProseMirror transaction / Step
  -> owned PM range / structural operation
  -> authored-source patch
  -> parse + structural validation
  -> publish
```

instead of:

```text
user input
  -> ProseMirror changes
  -> whole-document canonical serialization
  -> old/new Markdown diff
  -> infer intent
  -> authored-source patch
```

## Existing assets we should preserve

This is not a rewrite from zero. HorseMD already has the most expensive parts of the migration:

- a ProseMirror transaction observer,
- `mapPlainTextTransactionsToSource()` with byte-ownership and fail-closed checks,
- `pmPosToMarkdownOffset()` / `markdownOffsetToPmPos()`,
- source structure/list-slot fingerprints,
- semantic integrity validation,
- save/reopen validation,
- source-fidelity probes and UI regressions,
- the RS family as a concrete semantic acceptance matrix.

The migration should turn those pieces into a clearer architecture rather than replace them all at once.

## Core invariants

### 1. A transaction path must prove ownership before editing source

A transaction-first handler may modify only source bytes it can map to the pre-transaction PM state without ambiguity. If mapping is ambiguous, the handler returns `rejected` and the old preservation path remains authoritative.

No transaction family gets a heuristic fallback inside the transaction-first layer.

### 2. Authored spelling remains source-owned

Transaction-first does not mean stringify the edited PM subtree. The source map owns raw spelling such as:

- bullet marker token,
- ordered delimiter,
- indentation,
- task marker/sentinel form,
- tight/loose separators,
- local line ending / BOM where applicable.

A transaction handler should patch the smallest owned range and leave untouched bytes untouched.

### 3. Validation remains stricter than mapping

A successful patch still has to pass parser/PM semantic validation and the relevant structural fingerprint. The new architecture removes the need to infer intent from canonical Markdown; it does not weaken integrity.

### 4. Transaction batches are atomic

A handler owns a complete transaction family or none of it. If a callback contains one supported edit plus an unsupported structural edit, the whole transaction-first candidate is rejected and the fallback path handles the batch.

### 5. Source maps are snapshots

A source-range map is valid only for the exact `(authoredSource, PM doc)` checkpoint from which it was built. It is never silently reused after an unrelated transaction.

## Target components

### SourceRangeMap

A parse/checkpoint-time index that binds PM positions/nodes to authored Markdown ranges. The mature form should expose at least:

```text
PM block/node position
  -> authored node range
  -> marker range, body range, child range(s)
  -> source spelling metadata
```

The first implementation is deliberately narrower: top-level plain paragraphs whose complete PM text is byte-for-byte equal to one contiguous normalized source range.

Anything with marks, inline atoms, escapes, list/quote ownership, or a non-contiguous source spelling is excluded from the first map.

### TransactionPatchEngine

Consumes a PM transaction batch plus a SourceRangeMap and produces one of:

- `owned`: exact source patch + proof metadata,
- `rejected`: explicit reason, no source mutation.

The current `mapPlainTextTransactionsToSource()` is the first engine implementation and should be reused rather than duplicated.

### TransactionFirstCoordinator

Keeps rollout policy out of `Editor.jsx`. It runs the transaction candidate, compares it with the legacy candidate when available, records diagnostics, and decides which result is publishable according to the rollout mode.

Initial rollout modes:

- `shadow`: calculate transaction-first, publish legacy only.
- `observe`: same publication behavior as shadow, but treat byte equality with legacy as promotion evidence.
- `authoritative`: publish the transaction candidate when ownership + validation succeeds; otherwise fall back to legacy.

No family moves directly from unsupported to authoritative.

## Migration phases

### Phase 0 — freeze the contract

Goal: make architecture and ownership rules explicit without changing behavior.

- Document the model and rollout gates.
- Add a dedicated coordinator boundary.
- Add plain-paragraph SourceRangeMap snapshot support.
- Keep publication on the legacy path.
- Record rejection and equality reasons.

Exit criteria:

- dedicated tests for source-map snapshot identity,
- LF/CRLF/BOM preservation covered,
- duplicate paragraph text does not confuse range ownership,
- unsafe Markdown syntax remains fail-closed,
- no production publication change.

### Phase 1 — ordinary paragraph text

Goal: transaction-first becomes authoritative only for the already-proven plain text ReplaceStep family.

Supported examples:

- insert normal text inside one plain paragraph,
- delete/replace a plain selection inside one paragraph.

Remain fallback-only:

- textblock becomes empty,
- block split/merge unless independently proven,
- marked text whose source spelling is non-contiguous,
- inline code/link/math/image/HTML atoms,
- list/quote/table/code-block structure,
- Markdown syntax-sensitive insertion.

Promotion gate:

- shadow/observe telemetry shows no byte divergence for the supported family over representative real documents,
- existing transaction-source-sync unit/UI tests remain green,
- source-fidelity probes remain green,
- save/reopen remains byte-stable.

### Phase 2 — list structural operations

Goal: move the highest-cost RS families away from serializer-diff inference.

Implement each operation as a separate transaction family:

- list item split / Enter,
- empty item exit/removal,
- item merge via Backspace,
- lift/sink via Backspace/Tab/Shift-Tab,
- nested list continuation,
- task item continuation.

The list SourceRangeMap must identify at minimum:

- complete list-item raw range,
- marker raw range,
- paragraph body raw range,
- nested child ranges,
- authored indentation and delimiter style.

Each family is enabled independently and is accepted against the corresponding RS regressions before promotion.

### Phase 3 — quote/task/empty-node ownership

Handle representations where PM has an editor-owned empty node but authored Markdown may have no ordinary text bytes for it.

This phase should make such states explicit source-map entities instead of treating them as zero-visible string-diff boundaries.

### Phase 4 — tables, code blocks and remaining structural families

Tables and fenced blocks already have useful block ownership rules. Migrate them after the transaction/source-map contracts are stable, not before.

### Phase 5 — retire legacy mappers by coverage

The preservation layer becomes fallback-only for unowned transaction families. Delete a mapper only when:

- its transaction families are authoritative,
- its RS tests pass through the new path,
- shadow logging shows no production dependence on that mapper for the supported family.

Deletion is coverage-driven, not calendar-driven.

## Dual-run policy

During migration, one rich edit may produce two candidates:

```text
transactionCandidate = transaction engine(source checkpoint, PM transactions)
legacyCandidate      = preservation(previous source/canonical, next canonical)
```

Classification:

- `transaction-rejected`: expected while a family is not migrated.
- `byte-equal`: strongest promotion evidence.
- `byte-diverged`: do not promote; capture transaction family + source-map proof + both candidates.
- `legacy-unavailable`: never promote solely from this event.

A byte-diverged transaction candidate is not automatically wrong. It may preserve equivalent authored spelling better than the legacy path. But promotion requires an explicit test and review, not an automatic preference.

## Diagnostics we should collect

Keep transaction-first telemetry small and structured:

- mode,
- transaction family / step names,
- ownership result,
- rejection reason,
- source-map coverage for the touched block,
- transaction candidate reason,
- legacy candidate reason,
- comparison (`byte-equal`, `byte-diverged`, etc.),
- whether publication came from transaction or legacy.

Do not log full document bytes by default in release builds.

## How the RS regressions change role

RS tests stop being a list of preservation-mapper patches and become the migration acceptance matrix.

For each RS case, track:

1. which PM transaction family caused it,
2. whether SourceRangeMap can represent the affected structure,
3. whether transaction-first owns the complete batch,
4. exact authored-source output,
5. parser/structure integrity,
6. save/reopen stability.

A migrated RS test should ideally assert the transaction family/reason rather than a preservation mapper reason.

## First implementation slice

The first code slice lives in `src/renderer/src/lib/transaction-first-source-sync.js` and is intentionally non-invasive.

It adds:

- a plain top-level paragraph SourceRangeMap snapshot built in the same BOM/CRLF-normalized coordinate space used by `mapPlainTextTransactionsToSource()`,
- a coordinator that only accepts one changed transaction containing one ReplaceStep for Phase 1 ownership,
- explicit `shadow`, `observe`, and `authoritative` rollout modes,
- byte comparison against a supplied legacy candidate,
- structured diagnostics.

It does **not** change `Editor.jsx` publication yet. That wiring is the next small commit after the new boundary has independent tests.

## Next implementation order

1. Land this Phase 0 module + tests + document as an isolated commit.
2. Wire the coordinator into the existing transaction observer in `shadow` mode only.
3. Add trace counters for owned/rejected/equal/diverged plain-paragraph edits.
4. Run the existing source-fidelity matrix and manual long-document editing with shadow enabled.
5. Promote only the proven plain-paragraph ReplaceStep family to `authoritative`.
6. Design the list-item SourceRangeMap shape before implementing any list transaction handler.

The key rule for the rest of the migration is: **add structure to the source map before adding exceptions to the transaction patch engine.**
