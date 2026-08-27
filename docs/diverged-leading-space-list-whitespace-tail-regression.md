# RS-76: sentinel-backed list tail could not delete down to spaces-only

## Status

Fixed in the 0.13.121 working candidate. This was the remaining `HorseMD-0.13.33-引用后输入手测.md + list-spaces` legacy-baseline failure blocking transaction-first Phase 1 qualification.

## Real first divergence

The family operation creates a bullet item, types four leading spaces before a marker string, saves/reopens, then deletes the marker plus three of those spaces. The final rich-editor list item intentionally keeps only whitespace.

Immediately before the failing delete, the relevant tail spellings were:

```text
authored:  * U+200B    家族验证<PID>
canonical: * &#x20;   家族验证<PID>
```

After the delete, ProseMirror/serializer produced a spaces-only bullet row:

```text
*   
```

The document already contains many legitimate authored/canonical structural spelling differences, so every generic diverged visible mapper failed closed with `visible-stream-mismatch`. The source stayed at the old sentinel-backed row and the UI reported `source-locked-after-delete`.

## Why the sentinel must disappear

HorseMD uses U+200B as source-owned syntax when remark-stringify needs `&#x20;` to preserve a leading literal space in non-empty text. It is not authored content.

Once the list row has no non-whitespace body, leaving U+200B is wrong. Parsing `* U+200B  ` with the current remark/GFM rules creates paragraph text containing U+200B, while plain `*   ` parses as an empty list item. The old post-process `reconcileLeadingSpaceSentinelTransition()` cannot rescue this case because it only runs after the core mapper has already returned `preserved: true`; RS-76 failed earlier with `visible-stream-mismatch`.

## Fix contract

`preserveDivergedLeadingSpaceListWhitespaceTail()` owns only the exact final-row transition:

- previous and next canonical prefixes before the final content row are byte-identical;
- previous final row is a bullet row whose body starts with `&#x20;`, followed by optional spaces and non-whitespace text;
- next final row keeps the same canonical bullet marker/indent and contains only horizontal whitespace;
- authored source ends in a bullet row with the same indent, a source-owned U+200B sentinel, and non-whitespace text;
- after decoding `&#x20;` to one literal space and removing the sentinel, authored and canonical bodies are byte-identical.

When all proofs hold, only the authored final row is replaced. The authored bullet token is retained, the exact canonical spaces-only suffix is copied, U+200B is removed, and every earlier source byte remains untouched. Non-whitespace replacements, missing sentinel lifecycle, or any canonical prefix change fail closed.

The owner runs only inside the already-diverged source/canonical branch, before generic visible mappers. Semantic and list-slot integrity checks are unchanged and remain the publication gate.

## Regression evidence

Permanent core coverage: `scripts/test-rs76-leading-space-list-whitespace-tail.mjs`.

Before the formal 0.13.121 version bump, the implementation passed:

- synthetic positive ownership and three fail-closed negatives;
- `npm run build`;
- the original `HorseMD-0.13.33-引用后输入手测.md + list-spaces` append/save/delete/reopen full cycle, with the existing strict integrity gate accepting the candidate.

The fixture's other four cells had already been closed by RS-74/75. A consolidated post-bump family run is still required before treating the fixture as a 5/5 baseline checkpoint.
