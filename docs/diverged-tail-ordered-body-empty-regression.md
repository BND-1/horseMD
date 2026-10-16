# RS-75: adjacent empty ordered slots confused body-empty with row deletion

## Status

Fixed in the 0.13.120 working candidate. This issue was found while cleaning the legacy baseline before transaction-first Phase 1 live authority.

## Real first divergence

Fixture: `HorseMD-0.13.33-引用后输入手测.md`, family operation `plain`.

Immediately before the failing delete, the authored/canonical tail represented two ordered rows:

```text
1. <empty>
1) 测试
```

After the test deleted the final body text, ProseMirror correctly kept both list items and serialized:

```text
1. <br />
1) <br />
```

The preservation candidate instead deleted the entire authored `1) 测试` row. Strict integrity then reported a `list-slot-count` mismatch: the candidate had one empty ordered slot while the PM/canonical structure had two.

## Root cause

`preserveDivergedTailBlockAppend()` contains a broad `deleteCase` for genuine final-row deletion. It verifies that the new final visible line is equivalent to the previous predecessor. That is normally a strong tail-deletion proof.

For adjacent empty list slots, however, visible-line comparison deliberately removes list marker syntax. Both `1. <br />` and `1) <br />` therefore have no visible body and can compare equivalent even though they are distinct structural slots. The mapper concluded that the final row disappeared and returned `diverged-tail-line-delete`.

## Fix contract

Whole-row deletion is vetoed when raw tail identity proves the final list row still exists:

- previous and next raw tail prefixes are identical;
- final row indentation is identical;
- exact list marker token is identical, including ordered delimiter;
- marker spacing is identical;
- previous body is non-empty;
- next body is either blank or the editor-owned `<br />` placeholder.

This is an in-place body-empty transition, not a row deletion. After the veto, the existing `diverged-nested-list-change` mapper produces the correct authored candidate and preserves the original `1)` marker spelling.

A genuine final-row deletion does not retain the same raw tail prefix/slot, so `diverged-tail-line-delete` remains available. No semantic or list-slot integrity rule was weakened.

## Regression evidence

`scripts/test-rs75-tail-ordered-body-empty.mjs` contains two permanent proofs:

1. adjacent empty ordered slots + final body empty: both authored rows remain and reason is `diverged-nested-list-change`;
2. genuine final ordered-row deletion: the row is removed and reason remains `diverged-tail-line-delete`.

Verified before the 0.13.120 version bump:

- `npm run test:markdown-preservation` — PASS;
- `npm run build` — PASS;
- real `HorseMD-0.13.33-引用后输入手测.md + plain` — append/save/delete/reopen full cycle PASS.

The same fixture still has an independent `list-spaces` delete-stage `visible-stream-mismatch`; RS-75 does not claim that path.
