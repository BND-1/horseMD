import {
  areSourceDocumentsEquivalent,
  areSourceDocumentsEquivalentWithLiteralEmphasis
} from '../source-transaction-sync.js'
import { areMarkdownListSlotsEquivalent } from '../source-structure-fingerprint.js'
import { bindSourceSyncValidation } from './proof.js'
import { areDocumentsEquivalentByProjection, literalEmphasisOnly } from './projection.js'

export function createSourceSyncValidator({ validate }) {
  if (typeof validate !== 'function') {
    throw new TypeError('source-sync validator requires a validate function')
  }
  return (candidate, context = {}) => {
    if (!candidate?.ok) {
      return bindSourceSyncValidation(candidate, {
        ok: false,
        reason: candidate?.reason || 'source-sync-candidate-invalid'
      })
    }
    if (candidate.preserved === false) {
      return bindSourceSyncValidation(candidate, {
        ok: false,
        reason: candidate.reason || 'source-sync-candidate-not-preserved'
      })
    }
    try {
      const result = validate(candidate, context)
      return bindSourceSyncValidation(candidate, result)
    } catch (error) {
      return bindSourceSyncValidation(candidate, {
        ok: false,
        reason: `source-sync-validator-threw:${error?.name || 'Error'}`
      })
    }
  }
}

/**
 * The save check for every candidate source (the source reprint, a raw paste,
 * a select-all replacement, an undo back to a recorded document): does the
 * Markdown read back as the editor document? One definition decides — the
 * projection (projection.js): a block's meaning is parse(serialize(block))
 * without editor-only attributes. Besides it:
 *  - a trusted checkpoint whose source and canonical did not change passes
 *    (`committed-source-baseline`);
 *  - Option A (Typora parity, source reprint only): bold / italic Markdown
 *    cannot delimit there spelled as literal `*` / `_`, nothing else lost.
 * Without a registered projector (pure callers) the document comparison and
 * the list slots of the canonical decide.
 */
export function createSourceIntegrityValidator({
  getParser,
  getSerializer,
  getExpectedDoc,
  getAuthoredSource,
  getCanonicalBaseline,
  canonicalForSource,
  checkpointStore,
  getTrace = () => globalThis.__hmSourceIntegrityTrace
} = {}) {
  if (typeof getParser !== 'function') {
    throw new TypeError('source integrity validator requires getParser')
  }
  if (typeof getSerializer !== 'function') {
    throw new TypeError('source integrity validator requires getSerializer')
  }
  if (typeof canonicalForSource !== 'function') {
    throw new TypeError('source integrity validator requires canonicalForSource')
  }
  if (!checkpointStore?.has || !checkpointStore?.trust) {
    throw new TypeError('source integrity validator requires checkpointStore')
  }

  return (
    markdown,
    expectedDoc = getExpectedDoc?.(),
    canonical = null,
    authoredSource = getAuthoredSource?.(),
    preservationReason = '',
    validationSite = '',
    validationOptions = null
  ) => {
    if (typeof markdown !== 'string' || (!expectedDoc && typeof canonical !== 'string')) {
      return { ok: false, reason: 'source-integrity-missing-document' }
    }
    try {
      const parser = getParser()
      const parsed = parser(markdown)
      const expectedMarkdown = typeof canonical === 'string'
        ? canonical
        : canonicalForSource(getSerializer()(expectedDoc))
      const canonicalBaseline = getCanonicalBaseline?.()
      const checkpointTrusted = checkpointStore.has(authoredSource, canonicalBaseline)
      const committedCheckpointOk = Boolean(
        preservationReason === 'committed-source-baseline' &&
        checkpointTrusted &&
        markdown === authoredSource &&
        expectedMarkdown === canonicalBaseline
      )
      const projection = expectedDoc ? areDocumentsEquivalentByProjection(parsed, expectedDoc) : null
      const projectionDecides = Boolean(projection) && !/no-projector/.test(projection.reason || '')
      let semanticOk
      let listSlotsMatch
      if (projectionDecides) {
        // The projection compares lists as the parser reads them (nesting,
        // kind, start number, where one ends): it is the list proof too.
        listSlotsMatch = true
        semanticOk = projection.equal || (
          preservationReason === 'source-reprint' &&
          areSourceDocumentsEquivalentWithLiteralEmphasis(parsed, expectedDoc, { ignoreAllTableColumnWidths: true, ignoreEmptyContainerParagraphs: true }) &&
          literalEmphasisOnly(parsed, expectedDoc)
        )
      } else {
        const expected = expectedDoc || parser(expectedMarkdown)
        semanticOk = areSourceDocumentsEquivalent(parsed, expected, {
          ignoreAllTableColumnWidths: true,
          ignoreEmptyContainerParagraphs: preservationReason === 'source-reprint'
        })
        listSlotsMatch = areMarkdownListSlotsEquivalent(markdown, expectedMarkdown, {
          strictOrderedNumbers: preservationReason !== 'source-reprint',
          strictNesting: true,
          previousMarkdown: canonicalBaseline
        })
      }
      const ok = committedCheckpointOk || (semanticOk && listSlotsMatch)
      // Direct callers use validation as their checkpoint boundary; the
      // Coordinator disables this and trusts only after its commit succeeds.
      if (ok && validationOptions?.trustCheckpoint !== false) {
        checkpointStore.trust(markdown, expectedMarkdown, {
          reason: preservationReason || 'source-integrity-validated'
        })
      }
      const trace = getTrace?.()
      if (Array.isArray(trace)) {
        trace.push({
          ok,
          semanticOk,
          projectionDecides,
          projectionReason: projection?.reason || null,
          committedCheckpointOk,
          checkpointTrusted,
          listSlotsMatch,
          validationSite,
          preservationReason,
          candidate: markdown,
          canonical: typeof canonical === 'string' ? canonical : null
        })
        if (trace.length > 20) trace.shift()
      }
      const details = { semanticOk, committedCheckpointOk, checkpointTrusted, listSlotsMatch }
      return ok
        ? { ok: true, ...details }
        : {
            ok: false,
            reason: !listSlotsMatch ? 'source-list-structure-mismatch' : 'source-document-mismatch',
            ...details
          }
    } catch (error) {
      return { ok: false, reason: `source-integrity-parse-failed:${error?.name || 'Error'}` }
    }
  }
}
