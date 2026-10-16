# RS-77: localized list body deletion left a stale leading-space sentinel

## Status

Fixed in the 0.13.122 working candidate. This is the `11111.md + list-spaces` failure that remained after RS-76.

## Real first divergence

The authored row before deletion was sentinel-backed because it represented a leading literal space:

```text
* U+200B    家族验证<PID>
```

Crepe canonical represented the same text with `&#x20;`:

```text
- &#x20;   家族验证<PID>
```

After deleting the visible body and three leading spaces, canonical correctly kept the list slot as a spaces-only row:

```text
-   
```

Unlike RS-76, this document was still mappable by the ordinary `localized-change` path. That mapper correctly patched the body, but its result still contained `* U+200B  `. The facade then called `reconcileLeadingSpaceSentinelTransition()`, yet the helper searched the result by the **previous visible body**. Because the body had just become empty, the result line no longer matched that lookup and the stale sentinel survived. Strict integrity correctly rejected the candidate: `semanticOk=false`, `listSlotsMatch=false`, and the parsed list item contained U+200B as real paragraph text.

## Fix contract

RS-77 does not add a new mapper. It extends the existing sentinel post-process with one narrow fallback for the zero-visible-body case:

- previous→next must already be a single-line edit with no newline in the changed span;
- the source sentinel row identified by the previous visible body must remain unique;
- the normal result lookup by previous visible body must find no row;
- `nextVisible` must be empty;
- source and result line counts must be unchanged;
- the result line at the exact same source line ordinal must still contain the sentinel;
- after removing the sentinel from that row, its visible text must equal `nextVisible` exactly.

Only then is the sentinel removed. All existing ambiguity and semantic/integrity gates remain unchanged.

## Regression evidence

Permanent core regression: `scripts/test-rs77-localized-leading-space-sentinel-empty.mjs`.

Before the formal 0.13.122 bump, the fix passed:

- the dedicated RS-77 regression;
- full `test:markdown-preservation`;
- `npm run build`;
- the original `11111.md + list-spaces` append/save/delete/reopen full cycle under the unchanged integrity gate.

The complete 4×5 matrix immediately before RS-77 was 18/20: `反馈.md + plain` and `11111.md + list-spaces` were the only failures. The formal 0.13.122 post-bump rerun is now **19/20**: `11111.md + list-spaces` passes, all other `11111.md` cells remain green, and the only remaining matrix failure is the independent `反馈.md + plain` delete-stage `visible-stream-mismatch`.
