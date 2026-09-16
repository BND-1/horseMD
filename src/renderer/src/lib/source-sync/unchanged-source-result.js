import { areSourceDocumentsEquivalent } from '../source-transaction-sync.js'
import { areMarkdownListSlotsEquivalent } from '../source-structure-fingerprint.js'

export const UNCHANGED_SOURCE_REASON = 'unchanged-source-document-equivalent'

// Removing an editor-only empty paragraph may need NO Markdown byte edit.
// A failed mapper returning the current source is not sufficient evidence:
// prove both source and callback against the live PM document first. This
// only creates a candidate; the normal revision-bound publisher must still
// validate and commit it before clearing any pending journal/dirty state.
export function reconcileUnchangedSourceResult({
  result,
  source,
  canonical,
  expectedDoc,
  parseMarkdown
} = {}) {
  if (
    result?.preserved !== false ||
    typeof source !== 'string' || result.markdown !== source ||
    typeof canonical !== 'string' || !expectedDoc ||
    typeof parseMarkdown !== 'function'
  ) return result
  try {
    const options = { recordDifference: false }
    const sourceDoc = parseMarkdown(source)
    if (!areSourceDocumentsEquivalent(sourceDoc, expectedDoc, options)) return result
    const callbackDoc = canonical === source ? sourceDoc : parseMarkdown(canonical)
    if (!areSourceDocumentsEquivalent(callbackDoc, expectedDoc, options)) return result
    if (!areMarkdownListSlotsEquivalent(source, canonical, {
      strictOrderedNumbers: true,
      strictNesting: true
    })) return result
    return {
      markdown: source,
      preserved: true,
      reason: UNCHANGED_SOURCE_REASON,
      integrityProof: null
    }
  } catch {
    return result
  }
}
