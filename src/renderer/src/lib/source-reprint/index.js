// Source reprint engine entry (docs/source-reprint-architecture.md).
import { reprintSource } from './reprint.js'

export { reprintSource, sameNode } from './reprint.js'
export { buildInlineMap, pmInlineUnits } from './inline-map.js'

/**
 * Reprint and verify against the editor document. `equivalent(markdown, doc)`
 * must compare parse(markdown) with `doc` directly (never via canonical).
 * Minimal escaping first (writes exactly what was typed), then full escaping.
 */
export function reprintVerified({ source, editorDoc, previousDoc = null, parse, remark, serialize, equivalent }) {
  let last = null
  for (const escape of ['minimal', 'full', 'segment']) {
    let result
    try {
      result = reprintSource({ source, editorDoc, previousDoc, parse, remark, serialize, escape })
    } catch (error) {
      return { ok: false, reason: 'reprint-threw', error: String(error?.stack || error) }
    }
    if (!result.ok) return result
    last = result
    let verified = false
    try {
      verified = equivalent(result.markdown, editorDoc) === true
    } catch {
      verified = false
    }
    if (verified) return { ...result, verified: true, escape }
  }
  return { ...last, ok: false, verified: false, reason: 'reprint-verify-failed' }
}
