# Transaction Journal ownership for empty code blocks and list paragraphs

> HorseMD 0.13.147 current-stage contract; empty code block unpack originated in 0.13.146, while list-item text and RS-72 exact-path ownership close in 0.13.147.

This note documents three focused source-sync boundaries added after the table and general list-subtree migrations. They all reuse the revision-bound `SourceSyncTransactionJournal`, publish through `SourceSyncCoordinator`, and keep the legacy canonical preservation layer as a fail-closed fallback rather than a competing publisher.

## Empty fenced code block Backspace

An empty fenced `code_block` can be unwrapped by CodeMirror/Crepe before the delayed `markdownUpdated` callback. A fast next keystroke must not publish the empty paragraph and the following prose as two unrelated source edits.

`empty-code-block-backspace-unpack` owns the complete journal only when:

- the initial and final top-level node are one `code_block` and one plain paragraph at the same stable position;
- the source range is one complete authored fence, including its language and original fence character;
- every transaction step is part of the same verified journal and all neighbours are unchanged;
- a coalesced text result is plain unmarked text, or forced flush proves the final paragraph is empty;
- full semantic, list-slot, revision and source-digest validation succeeds.

The raw mapper replaces the complete authored fence with either the coalesced text plus the document line ending or one empty line. It never writes Crepe's `<br />` placeholder. The old zero-delay DOM reconcile shortcut is intentionally absent: source mode, save and explicit flush all use the same focused owner.

## Direct top-level list item paragraph text

`list-item-paragraph-text-replace` owns only plain text replacement inside one direct paragraph of one non-task item in one top-level bullet or ordered list. It preserves authored marker spelling, ordered delimiters, BOM and line endings while replacing only the paragraph body bytes.

The classifier rejects nested items, task metadata, marks, syntax-sensitive inserts, child-count changes, multiple changed items, structural steps, stale journals and semantic mismatches. Emptying the paragraph is allowed only after the stable item and paragraph path, all `ReplaceStep` documents and unchanged siblings have been proven. The shared plain-text mapper remains strict by default; this owner is the only caller that enables the empty-textblock completion for this family.

## Removed empty list item remnant (RS-72)

Backspace on one middle empty ordered item can remove that item while the live editor temporarily leaves one direct empty paragraph in the previous item. Serializing that paragraph produces an indented standalone `<br />` line, which must not enter authored source.

This remains part of `list-subtree-replace`; it is not a global placeholder scrubber. The owner derives an exact PM path only when all of the following are true:

- the old and new nodes are the same top-level list type with identical list attrs;
- the old list has exactly one additional middle item;
- that removed item is a standalone non-task empty paragraph;
- the new predecessor equals the old predecessor except for exactly one added direct empty paragraph after a non-empty paragraph;
- every other item and child is byte-for-byte structurally equal;
- exactly one candidate path exists.

The bounded list mapper then requires zero standalone `<br />` lines in authored source, exactly one in the final canonical list range and at most one in its mapped result. Only the internal paragraph block paired with the proven PM path may be compressed. Multiple paths, multiple placeholders, a source-authored standalone HTML break, a non-empty continuation or any ambiguity rejects the focused plan.

The proof records both `transientEmptyParagraphPaths` and `suppressedTransientEmptyParagraphPaths`. The validator accepts the semantic relaxation only when these arrays are identical, contain at most one three-segment path rooted at the proven top-level index, and belong to a verified `batched-list-block-changes` transaction proof. A wrong or stale path changes no semantic node and therefore stays strict.

## Permanent gates

The focused contracts are covered by:

- `test:empty-code-block-unpack-transaction-owner`
- `test:empty-code-block-unpack-transaction-ui`
- `test:list-item-paragraph-transaction-owner`
- `test:mixed-rich-source-transaction-ui`
- `test:list-subtree-transaction-owner`
- `test:list-subtree-transaction-ui`
- `test:single-empty-ordered-backspace-successor-ui`
- `test:source-transaction-sync`

The Electron gates inspect source mode, save, disk bytes and a fresh-profile cold reopen. They also require the expected Coordinator owner/family/boundary, a verified journal, no legacy intermediate publication, no source warning, exact marker/BOM/line-ending preservation and no leaked standalone `<br />`.
