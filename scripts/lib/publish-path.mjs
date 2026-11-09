// Which path published the latest rich → source sync (scripts written for the
// established owners / legacy path, before the source reprint became the
// primary publication path in R3).
//
// Their assertions about an owner's reason / proof / preserve-log entry hold
// only when that path published. When the source reprint published instead,
// the right check is that it did publish (verified against the editor
// document) — the outcome assertions (no warning, no failed check, source,
// save, reopen) stay as they are.
export async function reprintPublished(evaluate, { since = 0 } = {}) {
  return Boolean(await evaluate(`(() => {
    const trace = globalThis.__hmSourceSyncCoordinatorTrace || []
    return trace.slice(${Number(since) || 0}).some((entry) => entry?.phase === 'published' && entry?.family === 'source-reprint')
  })()`))
}

// Where the coordinator trace ends now: pass it as `since` to look only at
// what a later step published.
export async function publishMark(evaluate) {
  return Number(await evaluate('(globalThis.__hmSourceSyncCoordinatorTrace || []).length')) || 0
}

// `legacyCheck` runs only when the legacy path published; otherwise the
// reprint must have published.
// Nothing published (or only `unchanged`: the source already read back as the document —
// a blank typed at a line end has no Markdown): neither check applies; the
// outcome assertions decide.
export async function assertPublishedBy(evaluate, legacyCheck, label, options = {}) {
  if (await reprintPublished(evaluate, options)) return 'reprint'
  const since = Number(options.since) || 0
  const anyPublished = Boolean(await evaluate(`(() => (globalThis.__hmSourceSyncCoordinatorTrace || []).slice(${since}).some((entry) => entry?.phase === 'published' && entry?.reason !== 'unchanged'))()`))
  if (!anyPublished && Number.isInteger(options.since)) return 'none'
  await legacyCheck()
  return 'legacy'
}
