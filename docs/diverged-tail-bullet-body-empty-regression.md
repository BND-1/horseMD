# RS-78: globally-diverged tail bullet body could not become empty

## Status

Fixed in the 0.13.123 working candidate. This was the final `feedback.md + plain` cell remaining after the 0.13.122 family matrix reached 19/20.

## Real first divergence

The `plain` family operation starts from the rich editor's current tail. In `feedback.md`, that tail is already inside a bullet list, so Enter creates a new bullet item even though the operation itself types no explicit list marker. After append/save/reopen, the relevant final item was:

```text
authored:  - 而为
canonical: * 而为
```

Deleting the marker text emptied the body while preserving the same ProseMirror list item:

```text
canonical next: * <br />
```

The document already has substantial legitimate source/canonical divergence: empty blockquote placeholders, authored bullet rows that canonical expands into empty bullets plus nested ordered lists, marker spelling differences, loose-list spacing, and continuation indentation. The generic visible-stream mapper therefore returned `visible-stream-mismatch` before it could map this otherwise local final-row edit. Source stayed at `- 而为`, the rich/source integrity warning appeared, and the later Backspaces in the family operation could not proceed from a committed checkpoint.

A reduced document with only one ordinary source/canonical text divergence did **not** reproduce the failure; it was successfully handled by `visible-mismatch-line-change`. RS-78 therefore uses the complete captured `feedback.md` source/canonical triple as its permanent regression instead of widening a generic line mapper based on an oversimplified fixture.

## Fix contract

`preserveDivergedTailBulletBodyEmptied()` owns only one final-row transition:

- previous and next canonical bytes before the final content row are identical;
- previous and next final rows are both bullet rows with exactly the same indent, bullet token, and marker spacing;
- previous body is non-empty while next body is the normalized empty-list spelling;
- authored source itself ends in a non-empty bullet row at the same indent;
- the authored final body and previous canonical final body have exactly the same visible text.

When all proofs hold, the patch removes only the authored final-row body. The authored bullet token (`-`, `*`, or `+`), indentation, marker spacing, line ending, and every earlier source byte are retained. Any batched earlier canonical change or mismatched authored tail fails closed.

The RS-76 sentinel-specific tail owner remains earlier in dispatcher order, so a leading-space sentinel transition still follows its stricter whitespace-preservation contract rather than being absorbed by RS-78.

## Regression evidence

Permanent core regression: `scripts/test-rs78-diverged-tail-bullet-body-empty.mjs`.

Before the formal 0.13.123 version bump, the implementation passed:

- the complete captured `feedback.md` core red-to-green regression plus two fail-closed negatives;
- full `test:markdown-preservation`;
- `npm run build`;
- the original `feedback.md + plain` append/save/delete/reopen full cycle under the unchanged semantic/list-slot integrity gate.

The formal 0.13.123 post-bump gate is complete: RS-76/77/78 core, full markdown preservation, source structure fingerprint, 35/35 source-fidelity probes, source-transaction-sync, and build all pass. The complete four-file × five-operation family matrix also passes **20/20** with append/save/delete/reopen coverage and exit code 0. The legacy family baseline is therefore green; the next migration gate is a clean-baseline checkpoint followed by transaction-first live-authority isolation.
