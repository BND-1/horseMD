// Milkdown publishes some structural input-rule updates after the visible
// ProseMirror transaction. A durability boundary (save/source switch) can run
// in that short window and see an intentionally fail-closed source mapping.
// Retry only after yielding to the pending callbacks; never replace the
// authored source with canonical Markdown just to make a retry succeed.
export async function settleEditorMarkdown(flush, {
  force = false,
  delays = [0, 40, 120, 260]
} = {}) {
  if (typeof flush !== 'function') return null

  // Structural input rules can enqueue markdownUpdated after the visible
  // ProseMirror transaction but before the next macrotask. Calling flush
  // immediately accepts an intermediate, semantically valid snapshot (for
  // example a newly-created list item before the following paragraph text is
  // published) and makes a later callback look like an unrelated edit. Yield
  // once before the first durability read so one user gesture is observed as
  // a complete callback batch.
  await new Promise((resolve) => setTimeout(resolve, 0))
  let markdown = flush({ force })
  let settledMarkdown = typeof markdown === 'string' ? markdown : null

  // A successful first flush is not necessarily the end of the structural
  // batch: it can prove the intermediate list node while the following
  // paragraph transaction is still queued. Continue observing the same live
  // document and retain the newest successful snapshot. This makes the
  // durability boundary wait for the callback queue instead of mounting a
  // source textarea from an older, semantically-valid prefix.
  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)))
    markdown = flush({ force })
    if (typeof markdown === 'string') settledMarkdown = markdown
  }

  return settledMarkdown
}
