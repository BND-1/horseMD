import { diff3Merge } from 'node-diff3'

// Line-based three-way merge of a Markdown file (docs/cloud-sync-review.md
// R1): `base` = what the editor loaded, `ours` = the editor's text, `theirs`
// = what is on disk now (another device's version synced in, another app).
// Changes in different places merge; changes to the same or ADJACENT lines
// are a conflict (diff3 keeps those apart — never a guess). A result that is
// empty, or much shorter than both sides, is refused as a conflict too (merge
// tools have wiped notes that way). Returns { ok: true, text } | { ok: false }.
export function mergeText(base, ours, theirs) {
  base = String(base ?? '')
  ours = String(ours ?? '')
  theirs = String(theirs ?? '')
  if (ours === theirs) return { ok: true, text: ours }
  if (ours === base) return { ok: true, text: theirs }
  if (theirs === base) return { ok: true, text: ours }
  // Lines keep their "\r" (CRLF files stay CRLF where they were).
  const lines = (text) => text.split('\n')
  let regions
  try {
    regions = diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true })
  } catch {
    return { ok: false }
  }
  if (regions.some((region) => region.conflict)) return { ok: false }
  const text = regions.flatMap((region) => region.ok || []).join('\n')
  const shortest = Math.min(ours.trim().length, theirs.trim().length)
  if (!text.trim() || text.trim().length < shortest * 0.5) return { ok: false }
  return { ok: true, text }
}
