# Transaction-first source sync — Phase 0 shadow rollout plan

## Status

- Phase: 0 — contract freeze / behavior-neutral shadow rollout
- Publication authority: legacy source-preservation path only
- Production behavior change allowed: **none**
- Parent architecture: `docs/transaction-first-source-sync-migration.md`
- Phase-0 core boundary: `src/renderer/src/lib/transaction-first-source-sync.js`

This document is the execution plan and migration ledger for wiring the already-tested transaction-first boundary into the live rich editor without taking publication ownership.

## Goal

Turn the existing transaction experiment in `Editor.jsx` into a real dual-run observation path:

```text
PM transaction
  -> snapshot SourceRangeMap
  -> transaction-first candidate
  -> hold as pending shadow evidence

Crepe markdownUpdated
  -> legacy preservation candidate
  -> final legacy integrity checks / marker corrections
  -> compare final legacy bytes with pending transaction candidate
  -> record byte-equal / byte-diverged / rejected / stale
  -> publish legacy bytes exactly as before
```

The important change in Phase 0 is **evidence quality**, not source ownership.

Today the editor can run `mapPlainTextTransactionsToSource()` in a shadow mode, but that result is discarded before `markdownUpdated` produces the actual legacy candidate. A discarded candidate cannot prove equivalence and therefore cannot support a safe promotion decision.

## Non-goals

Phase 0 does not:

- make transaction-first authoritative in normal production editing,
- broaden ownership beyond the existing single-`ReplaceStep` plain-text family,
- add list, quote, table, code-block or marked-text transaction handlers,
- relax semantic or list-structure integrity,
- delete any legacy preservation mapper,
- change generated-scratch behavior,
- change input-rule marker reconstruction,
- change save/source-switch behavior.

The existing opt-in `transactionPrimaryEnabled` path is kept behaviorally intact during this slice so existing targeted tests retain their current contract. Replacing that path is a later promotion step, not part of Phase 0 shadow wiring.

## Source-of-truth rule

Phase 0 follows three separate truths:

1. **PM transaction / Step** — what operation happened.
2. **Authored Markdown checkpoint** — how untouched bytes are spelled.
3. **Parser + structure validation** — whether the candidate still means the live document.

No one layer substitutes for the other two.

## Implementation slices

### Slice A — staged shadow lifecycle API

Extend `transaction-first-source-sync.js` with an explicit two-stage API:

- capture a transaction candidate against an exact source/PM snapshot,
- reconcile that captured candidate later against the final legacy result.

Required properties:

- capture must retain only bounded metadata plus the candidate needed for byte comparison,
- capture must be tied to the exact authored source and `oldState.doc` / `newState.doc`,
- reconcile must fail closed when the source checkpoint or callback document no longer matches,
- shadow/observe reconcile can never select transaction bytes for publication,
- every result must expose a stable classification reason.

The one-shot `runTransactionFirstSourceSync()` API remains available for focused unit tests and future authoritative use.

### Slice B — live `Editor.jsx` shadow wiring

At `handleSourceTransactions`:

1. Keep all existing transaction eligibility gates.
2. Build `buildPlainParagraphSourceRangeMap()` from `lastMarkdownRef.current` + `oldState.doc`.
3. Capture a transaction-first shadow candidate.
4. Store only the latest eligible pending checkpoint for reconciliation.
5. Keep the existing opt-in primary path unchanged.

At `markdownUpdated`:

1. Let the complete legacy pipeline finish constructing and validating `preserved`.
2. Reconcile the pending transaction-first checkpoint against that **final** legacy candidate.
3. Clear the checkpoint after reconcile or when it is proven stale.
4. Continue publishing `preserved.markdown` exactly as before.

The comparison must happen after list-input marker restoration and integrity fallback, otherwise shadow telemetry would compare against an intermediate legacy candidate that the app never publishes.

### Slice C — bounded telemetry

Use `globalThis.__hmTransactionFirstTrace` as the primary structured trace.

Each reconciled event should include, without full-document bytes by default:

- `mode`
- `ownership`
- `transactionReason`
- `comparison`
- `promotionEligible`
- `publicationOwner`
- `sourceMapEntries`
- `stepNames`
- `reconcileReason`
- source checkpoint length / candidate length only when useful

Expected comparison classes:

- `byte-equal`
- `byte-diverged`
- `transaction-rejected`
- `legacy-unavailable`
- `shadow-stale-source`
- `shadow-stale-document`

The trace is diagnostic evidence only. It must not influence publication in Phase 0.

## Snapshot lifetime rules

A pending shadow checkpoint is valid only while all of these still hold:

- current authored source is the same source string used at capture,
- the callback/live PM document equals the captured `newState.doc`,
- the candidate belongs to the captured `oldState.doc`,
- no special editing flow has independently taken source ownership.

Clear or reject pending shadow state when any of these occur:

- raw Markdown paste,
- list conversion ownership,
- whole-document replacement,
- generated scratch,
- programmatic replacement,
- composition,
- transaction quarantine,
- a newer eligible transaction supersedes the pending checkpoint,
- a legacy callback publishes a different PM document.

A stale shadow checkpoint is expected during deferred/coalesced callbacks. Staleness is telemetry, not an integrity error and must not show a user warning.

## Tests to add or extend

### Unit: `scripts/test-transaction-first-source-sync.mjs`

Add staged-lifecycle coverage for:

- capture owned plain text -> reconcile byte-equal,
- capture owned plain text -> reconcile byte-diverged,
- shadow reconcile always publishes legacy,
- source changed before reconcile -> stale-source classification,
- PM doc changed before reconcile -> stale-document classification,
- transaction rejection is retained through reconcile,
- trace entry contains step family / source-map coverage without requiring document bytes.

### Existing regression suites

Must remain green:

```sh
node scripts/test-editor-source-map.mjs
npm run test:source-transaction-sync
node scripts/test-transaction-first-source-sync.mjs
npm run test:source-fidelity-probes
```

Run targeted UI transaction tests that already cover the opt-in primary path before changing any primary behavior.

## Manual shadow qualification

With shadow explicitly enabled in a development run, exercise:

- insert one normal character in a plain paragraph,
- delete a normal character,
- replace a same-paragraph selection,
- edit duplicate paragraph text where the same body appears twice,
- type Markdown-sensitive syntax such as `*` and confirm rejection,
- edit marked text and confirm rejection/fallback,
- perform list Enter / Backspace / Tab and confirm rejection rather than accidental ownership,
- perform rapid consecutive paragraph edits and inspect stale/coalesced classifications.

A plain-text family is promotable only after representative sessions show owned events are byte-equal with the final legacy publication and unsupported families stay rejected.

## Acceptance criteria

Phase 0 shadow wiring is complete only when:

- [ ] a live PM transaction produces a staged transaction-first checkpoint,
- [ ] the checkpoint is compared with the final legacy candidate in `markdownUpdated`,
- [ ] normal shadow mode cannot publish transaction bytes,
- [ ] stale source/doc checkpoints fail closed without a toast,
- [ ] unsupported structural edits remain rejected,
- [ ] telemetry is bounded and does not log full documents by default,
- [ ] existing source/integrity regressions remain green,
- [ ] targeted diff checks pass for the new migration files/hunks,
- [ ] migration work is committed separately from unrelated dirty-tree changes.

## Commit / audit strategy

The working tree contains substantial pre-existing RS work. To keep migration history reviewable:

1. Commit this plan document by itself.
2. Prefer new migration modules/tests where possible.
3. For `Editor.jsx`, stage only the exact migration hunks; never stage the whole existing dirty file.
4. Run `git diff --cached --check` and inspect `git diff --cached --stat` before each migration commit.
5. Keep RS-72 and other unrelated dirty changes out of transaction-first commits.
6. Record each completed slice below with its commit hash and validation commands.

## Migration ledger

### 2026-08-25 — Phase 0 architecture boundary

Completed before this plan:

- architecture document added,
- plain-paragraph SourceRangeMap added,
- transaction-first coordinator added,
- focused unit test added,
- local commit: `42a0f8a refactor(editor): start transaction-first source sync`.

Validation at that checkpoint:

- `node scripts/test-editor-source-map.mjs`
- `npm run test:source-transaction-sync`
- `node scripts/test-transaction-first-source-sync.mjs`

### 2026-08-25 — Phase 0 shadow live wiring

Status: **in progress**

Planned files:

- `src/renderer/src/lib/transaction-first-source-sync.js`
- `scripts/test-transaction-first-source-sync.mjs`
- `src/renderer/src/components/Editor.jsx` — exact hunk staging only

Completion evidence and commit hash will be appended after validation.
