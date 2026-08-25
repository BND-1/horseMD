# Transaction-first source sync — Phase 1 shadow transaction chain plan

## Status

- Date: 2026-08-25
- Phase: 1 shadow qualification
- Scope: rapid consecutive plain-paragraph transactions before one deferred `markdownUpdated`
- Production publication: unchanged; legacy remains authoritative
- Parent plan: `docs/transaction-first-source-sync-phase1-plain-paragraph-plan.md`

## Why this plan exists

Phase 1 live qualification exposed a concrete version of the architecture problem that motivated transaction-first migration.

A single-character selection replacement works end-to-end in the live Electron shadow path:

```text
source S0 / PM D0
  -> one ReplaceStep
  -> transaction-first candidate S1 / PM D1
  -> markdownUpdated
  -> legacy S1
  -> byte-equal
```

The same selection replacement typed as two committed characters fails to produce byte-equal shadow evidence when both physical edits arrive before the deferred Markdown callback:

```text
S0 / D0
  -> tx A -> D1
  -> tx B -> D2
  -> markdownUpdated only after both
```

The current Editor wiring stores only one scalar checkpoint:

```text
let transactionFirstShadowPending = null
```

The second dispatch replaces the evidence from the first dispatch. This means the final callback is no longer compared against the complete transaction sequence that produced its PM document.

A controlled live test confirmed the distinction:

- two-character replacement (`ZZ`) failed shadow byte-equality,
- the same test changed to one-character replacement (`Z`) passed the complete live matrix,
- insertion, deletion, syntax rejection, paragraph split rejection, and list structural fallback remained correct.

This is not a classifier bug and must not be fixed by widening ownership.

## Architectural conclusion

A deferred serializer callback is a publication/checkpoint event, not the transaction boundary.

The shadow lane therefore needs its own transaction sequence state:

```text
authored baseline S0 / PM D0
  -> tx A -> shadow source S1 / PM D1
  -> tx B -> shadow source S2 / PM D2
  -> tx C -> shadow source S3 / PM D3
  -> markdownUpdated legacy candidate L3
  -> compare S3 with L3
```

Each transaction must be mapped against the source produced by the previous owned transaction, not repeatedly against `lastMarkdownRef.current` while that ref is waiting for `markdownUpdated`.

## Invariants

### 1. Baseline source is immutable for one pending chain

The chain remembers the authored source that was current before its first transaction:

```text
baselineSource = S0
baselineDoc = D0
```

These values are used to decide whether the eventual callback still belongs to this chain.

### 2. Shadow source evolves transaction by transaction

For the next transaction, mapping input is:

```text
workingSource = previous transaction candidate
workingDoc = previous newDoc
```

Never rebuild a SourceRangeMap for `D1` against stale `S0` if an owned candidate `S1` already exists.

### 3. PM document chain must be exact

A transaction may extend a pending chain only when:

```text
pending.newDoc.eq(oldState.doc)
```

Otherwise the chain is invalidated/rejected rather than guessed across an unknown transition.

### 4. One unsupported member rejects authority for the whole pending chain

For Phase 1, chain authority is atomic.

If any transaction is:

- structurally unowned,
- syntax-sensitive,
- stale,
- semantically invalid,
- not a `plain-paragraph-inline-replace`,

then the complete pending chain is not promotable.

Shadow telemetry can retain the reason, but it must not stitch owned bytes before and after an unsupported middle transaction into an apparently authoritative chain.

### 5. Reconcile compares the final chain candidate

When `markdownUpdated` arrives, compare:

```text
pending.baselineSource === currentSource
pending.newDoc === current PM doc
pending.transaction.markdown === final legacy candidate
```

The chain's working source may be `S2` or `S3`; the baseline source remains `S0` for callback ownership.

### 6. No source publication behavior changes in this slice

Even when a two- or three-transaction chain is fully owned and byte-equal, Phase 1 shadow still publishes legacy bytes.

The goal is to preserve transaction evidence across deferred callbacks, not to enable authority yet.

## Core API

Add a pure helper to `transaction-first-source-sync.js`, tentatively:

```text
advanceTransactionFirstSourceSync({
  checkpoint,
  mode,
  baselineSource,
  transactions,
  oldState,
  newState,
  buildSourceRangeMap,
  blockHints,
  validateMarkdown
})
```

### No existing checkpoint

Equivalent to capture:

```text
baselineSource = provided/current authored source
workingSource = baselineSource
chainLength = 1 on success/rejection capture
```

### Existing compatible checkpoint

If:

```text
checkpoint.baselineSource === current authored baseline
checkpoint.newDoc.eq(oldState.doc)
checkpoint.transaction.ok === true
```

then:

1. use `checkpoint.transaction.markdown` as the working source,
2. build a fresh SourceRangeMap for `oldState.doc` against that working source,
3. classify/map the new transaction,
4. carry the original baseline source/doc forward,
5. replace the final candidate with the new candidate,
6. increment `chainLength`,
7. append bounded family/reason/step metadata.

### Existing incompatible/rejected checkpoint

Do not silently restart from stale authored source while the callback is still pending.

Return a rejected chain classification such as:

- `shadow-chain-document-gap`
- `shadow-chain-prior-rejected`
- `shadow-chain-baseline-changed`
- `shadow-chain-source-map-failed`

The eventual callback remains legacy-owned.

## Checkpoint shape

A pending chain should expose only bounded metadata plus the exact candidate needed for comparison:

```text
{
  mode,
  baselineSource,
  baselineDoc,
  newDoc,
  transaction,
  ownership,
  family,
  chainLength,
  stepNames,
  sourceMapEntries,
  chainReasons
}
```

Telemetry must not log full document/source strings.

## Editor integration

Replace the Phase 0 scalar overwrite behavior conceptually from:

```text
transactionFirstShadowPending = capture(...lastMarkdownRef.current...)
```

to:

```text
transactionFirstShadowPending = advance({
  checkpoint: transactionFirstShadowPending,
  baselineSource: lastMarkdownRef.current,
  ...current transaction...
})
```

The helper chooses the correct working source from the pending chain.

`markdownUpdated` still calls one reconcile and then clears the chain.

Do not touch the historical transaction-primary behavior in this change.

## Tests

### Core chain tests

Add focused tests proving:

1. one owned inline transaction behaves exactly like current capture,
2. two consecutive owned insertions accumulate from S0 -> S1 -> S2,
3. selection replacement followed immediately by another inserted character accumulates correctly,
4. chain baseline remains S0 while working source becomes S2,
5. final reconcile with legacy S2 is byte-equal,
6. an unsupported second transaction rejects the complete chain,
7. a PM document gap rejects the chain,
8. a changed authored baseline rejects the chain,
9. stale callback source/doc still fails closed,
10. telemetry exposes `chainLength` and reasons but not full Markdown bytes.

### Live Electron qualification

Restore the two-character selection replacement (`ZZ`) case.

Expected live evidence:

```text
transactionFamily = plain-paragraph-inline-replace
chainLength >= 2
comparison = byte-equal
publicationOwner = legacy
promotionEligible = true
```

Also retain:

- one ordinary insertion,
- deletion,
- syntax-sensitive rejection,
- paragraph Enter/split rejection,
- list Backspace rejection,
- zero source-sync warning toasts.

## Promotion consequences

Phase 1 authoritative publication must not be enabled until rapid transaction chains are handled.

A one-transaction-only authority gate would pass isolated tests but regress normal human typing because keyboard input naturally produces multiple PM transactions before a deferred serializer callback.

Therefore chain support is a **promotion prerequisite**, not an optional optimization.

## Audit / commit strategy

1. Commit this discovery/plan independently.
2. Implement the pure chain accumulator and core tests in a clean commit.
3. Wire it into the existing shadow-only Editor path; do not publish transaction bytes.
4. Restore and pass the two-character live replacement regression.
5. Update the Phase 1 ledger with observed chain telemetry.
6. Only then continue authoritative coordinator work.

Because `Editor.jsx` has a large pre-existing dirty diff, its live chain wiring remains subject to the same isolation rule as Phase 0: do not stage unrelated RS work merely to make a migration commit convenient.

## Exit criteria

This slice is complete when:

- [ ] consecutive owned transactions use the prior shadow candidate as their source baseline,
- [ ] the original authored baseline remains available for callback ownership,
- [ ] two-character selection replacement is byte-equal in live Electron shadow mode,
- [ ] unsupported middle transactions reject the complete chain,
- [ ] stale/gapped chains fail closed without a warning toast,
- [ ] legacy remains the only live publisher,
- [ ] source map, transaction mapper, fidelity probes, build, and shadow UI regressions remain green,
- [ ] implementation and evidence are committed separately from unrelated dirty-tree work.
