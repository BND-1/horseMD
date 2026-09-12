// Offline reproducer for the ime-loose-item-split incident (trace-38723,
// 2026-09-12 10:16:37, reason=source-list-structure-mismatch).
//
// The triple below is byte-exact from the user's live trigger. Running this
// reproduces the mapper side: preserveRichMarkdownSource publishes a
// locally-aligned TEXT candidate (md length 333602) — but the structural
// paragraph split from the IME journal (ReplaceStep from=15508 structure:true
// sliceSize=4) is never encoded, so PM keeps +N top-level blocks vs the
// source and the next validation fail-closes with a list-slots mismatch.
//
// The owner this fixture accepts must make the structural step publish a
// representable source shape (blank line + indent-2 continuation under the
// loose item) instead of leaving the debt for the validator.
import { readFile } from 'node:fs/promises'
import { preserveRichMarkdownSource } from '../../../src/renderer/src/markdown-source-preservation.js'

const dir = new URL('.', import.meta.url)
const [source, previousCanonical, canonical] = await Promise.all([
  readFile(new URL('source.md', dir), 'utf8'),
  readFile(new URL('previous-canonical.md', dir), 'utf8'),
  readFile(new URL('canonical.md', dir), 'utf8')
])

const t0 = performance.now()
const result = preserveRichMarkdownSource(source, previousCanonical, canonical)
console.log(JSON.stringify({
  elapsedMs: Math.round(performance.now() - t0),
  preserved: result.preserved,
  reason: result.reason,
  markdownLength: result.markdown?.length ?? null,
  note: 'legacy-mapper baseline (drifted placement, correctly rejected by the strict gate). The fix lives in the transaction registry: the list-empty-item-text-filled owner preempts this call for the fill journal — see test:list-empty-item-text-fill-transaction-owner + test:ime-loose-item-split-ui'
}, null, 1))
