import {
  areSourceDocumentTransitionsEquivalent,
  areSourceDocumentsEquivalent
} from '../source-transaction-sync.js'
import {
  areMarkdownListSlotTransitionsEquivalent,
  areMarkdownListSlotsEquivalent
} from '../source-structure-fingerprint.js'
import { bindSourceSyncValidation } from './proof.js'

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

const localRange = (value, range) => {
  if (
    typeof value !== 'string' || !range ||
    !Number.isInteger(range.start) || !Number.isInteger(range.end) ||
    range.start < 0 || range.end <= range.start || range.end > value.length
  ) return null
  return value.slice(range.start, range.end)
}

const tableColumnWidthProofPaths = (preservationReason, preservationProof) => {
  if (preservationReason !== 'table-column-width-changed') {
    return preservationProof?.kind === 'transaction-table-column-width-proof'
      ? false
      : null
  }
  if (
    preservationProof?.kind !== 'transaction-table-column-width-proof' ||
    preservationProof?.family !== 'table-column-width' ||
    preservationProof?.sourceUnchanged !== true ||
    preservationProof?.canonicalUnchanged !== true ||
    !Array.isArray(preservationProof?.cellPaths) ||
    preservationProof.cellPaths.length === 0 ||
    preservationProof.cellPaths.length !== preservationProof.rowCount ||
    !preservationProof.cellPaths.every((path) =>
      Array.isArray(path) &&
      path.length === 3 &&
      path.every((index) => Number.isInteger(index) && index >= 0) &&
      path[0] === preservationProof.topLevelIndex &&
      path[2] === preservationProof.columnIndex
    )
  ) return false
  const rows = preservationProof.cellPaths.map((path) => path[1])
  if (new Set(rows).size !== rows.length) return false
  return preservationProof.cellPaths
}

const transactionListTransientEmptyPaths = (preservationReason, preservationProof) => {
  const listItemPath = preservationProof?.transientEmptyListItemPath
  const paragraphPath = preservationProof?.transientEmptyParagraphPath
  const validPathPair = Boolean(
    Array.isArray(listItemPath) &&
    listItemPath.length >= 2 &&
    listItemPath.every((index) => Number.isInteger(index) && index >= 0) &&
    listItemPath[0] === preservationProof?.topLevelIndex &&
    Array.isArray(paragraphPath) &&
    paragraphPath.length === listItemPath.length + 1 &&
    paragraphPath.every((index) => Number.isInteger(index) && index >= 0) &&
    listItemPath.every((index, pathIndex) => paragraphPath[pathIndex] === index) &&
    paragraphPath.at(-1) >= 1
  )

  if (preservationReason === 'list-empty-item-removed') {
    const removedPath = preservationProof?.removedPath
    const step = preservationProof?.step
    if (
      preservationProof?.kind !== 'transaction-list-empty-item-remove-proof' ||
      preservationProof?.family !== 'list-empty-item-remove' ||
      !['bullet_list', 'ordered_list'].includes(preservationProof?.listType) ||
      preservationProof?.transactionJournal?.snapshotMatched !== true ||
      preservationProof?.transactionJournal?.documentMatched !== true ||
      preservationProof?.chainLength !== 1 ||
      !Number.isInteger(preservationProof?.removedIndex) ||
      preservationProof.removedIndex < 1 ||
      !Array.isArray(removedPath) ||
      removedPath.length !== 2 ||
      removedPath[0] !== preservationProof.topLevelIndex ||
      removedPath[1] !== preservationProof.removedIndex ||
      listItemPath?.length !== 2 ||
      listItemPath?.[1] !== preservationProof.removedIndex - 1 ||
      !validPathPair ||
      step?.name !== 'ReplaceStep' ||
      step?.structure !== true ||
      step?.sliceSize !== 0 ||
      !Number.isFinite(step?.from) ||
      !Number.isFinite(step?.to) ||
      step.to <= step.from
    ) return false
    return [listItemPath]
  }

  if (preservationProof?.mapperReason !== 'diverged-empty-ordered-backspace-lift') return []
  if (
    preservationReason !== 'transaction-list-subtree' ||
    preservationProof?.kind !== 'transaction-list-subtree-proof' ||
    preservationProof?.family !== 'list-subtree-replace' ||
    preservationProof?.listType !== 'ordered_list' ||
    preservationProof?.transactionJournal?.snapshotMatched !== true ||
    preservationProof?.transactionJournal?.documentMatched !== true ||
    !validPathPair
  ) return false
  return [listItemPath]
}

const semanticOptionsForReason = (
  preservationReason,
  preservationProof = null,
  tableColumnWidthPaths = tableColumnWidthProofPaths(preservationReason, preservationProof),
  transientEmptyListItemPaths = transactionListTransientEmptyPaths(
    preservationReason,
    preservationProof
  )
) => ({
  // Backspace on a newly-created empty bullet can briefly leave one
  // editor-owned empty paragraph at the end of the preceding/parent list item.
  // Keep the exact legacy allowlist while Phase A only extracts lifecycle.
  ignoreTrailingEmptyListItemParagraph:
    preservationReason === 'empty-list-item-removed' ||
    preservationReason === 'diverged-empty-ordered-backspace-lift' ||
    preservationReason === 'nested-empty-list-item-removed' ||
    preservationReason === 'trailing-list-item-paragraph-emptied' ||
    preservationReason === 'empty-task-item-merged-to-continuation' ||
    preservationReason === 'empty-list-item-merged-after-nested-list',
  ignoreTrailingEmptyListItemParagraphAfterNestedStructure:
    preservationReason === 'empty-list-item-merged-after-nested-list',
  ignoreEmptyListItemParagraphBeforeNestedStructure:
    preservationReason === 'empty-ordered-item-merged-before-nested-list',
  // Markdown cannot encode this single editor-owned empty paragraph without
  // leaking `<br />`; only the existing dedicated legacy reason may ignore it.
  ignoreTrailingEmptyBlockquoteParagraph:
    preservationReason === 'trailing-empty-blockquote-paragraph-created',
  ignoreTrailingEmptyListItemPaths:
    Array.isArray(transientEmptyListItemPaths) ? transientEmptyListItemPaths : [],
  ignoreTableColumnWidthPaths:
    Array.isArray(tableColumnWidthPaths) ? tableColumnWidthPaths : []
})

/**
 * Compatibility validator for the Phase-A migration. It preserves the exact
 * positional call contract used by Editor and editor-api while moving trusted
 * checkpoint state, semantic/list proofs and trace emission out of Editor.jsx.
 *
 * Later transaction families can call the generic candidate validator above;
 * during Phase A every legacy reason and proof keeps its existing semantics.
 */
export function createLegacySourceIntegrityValidator({
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
    throw new TypeError('legacy source integrity validator requires getParser')
  }
  if (typeof getSerializer !== 'function') {
    throw new TypeError('legacy source integrity validator requires getSerializer')
  }
  if (typeof canonicalForSource !== 'function') {
    throw new TypeError('legacy source integrity validator requires canonicalForSource')
  }
  if (!checkpointStore?.has || !checkpointStore?.trust) {
    throw new TypeError('legacy source integrity validator requires checkpointStore')
  }

  return (
    markdown,
    expectedDoc = getExpectedDoc?.(),
    canonical = null,
    authoredSource = getAuthoredSource?.(),
    preservationReason = '',
    preservationProof = null,
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
      const tableColumnWidthPaths = tableColumnWidthProofPaths(
        preservationReason,
        preservationProof
      )
      const tableColumnWidthProofInvalid = tableColumnWidthPaths === false
      const transientEmptyListItemPaths = transactionListTransientEmptyPaths(
        preservationReason,
        preservationProof
      )
      const transactionListTransientProofInvalid = transientEmptyListItemPaths === false
      const expected = Array.isArray(tableColumnWidthPaths)
        ? expectedDoc
        : typeof canonical === 'string'
          ? parser(canonical)
          : expectedDoc
      const canonicalBaseline = getCanonicalBaseline?.()
      const semanticOptions = semanticOptionsForReason(
        preservationReason,
        preservationProof,
        tableColumnWidthPaths,
        transientEmptyListItemPaths
      )
      const semanticOk = !tableColumnWidthProofInvalid &&
        !transactionListTransientProofInvalid &&
        areSourceDocumentsEquivalent(parsed, expected, semanticOptions)
      const checkpointTrusted = checkpointStore.has(authoredSource, canonicalBaseline)
      const committedCheckpointOk = Boolean(
        preservationReason === 'committed-source-baseline' &&
        checkpointTrusted &&
        markdown === authoredSource &&
        expectedMarkdown === canonicalBaseline
      )

      let transitionOk = false
      if (
        !semanticOk &&
        !committedCheckpointOk &&
        checkpointTrusted &&
        typeof authoredSource === 'string' &&
        typeof canonical === 'string' &&
        typeof canonicalBaseline === 'string' &&
        preservationReason &&
        preservationReason !== 'committed-source-baseline'
      ) {
        const beforeSource = parser(authoredSource)
        const beforeExpected = parser(canonicalBaseline)
        transitionOk = areSourceDocumentTransitionsEquivalent(
          beforeSource,
          parsed,
          beforeExpected,
          expected,
          semanticOptions
        )
      }

      const listSlotsMatch = areMarkdownListSlotsEquivalent(markdown, expectedMarkdown, {
        strictOrderedNumbers: true,
        strictNesting: true,
        previousMarkdown: canonicalBaseline
      })

      let localizedListProofOk = false
      let localizedListProofTrace = null
      if (
        !listSlotsMatch &&
        preservationReason === 'rapid-nested-ordered-parent-backspace-lift' &&
        preservationProof?.kind === 'localized-list-slots' &&
        checkpointTrusted &&
        typeof authoredSource === 'string' &&
        typeof canonicalBaseline === 'string' &&
        typeof expectedMarkdown === 'string'
      ) {
        const beforeSourceFragment = localRange(authoredSource, preservationProof.beforeSource)
        const afterSourceFragment = localRange(markdown, preservationProof.afterSource)
        const beforeCanonicalFragment = localRange(canonicalBaseline, preservationProof.beforeCanonical)
        const afterCanonicalFragment = localRange(expectedMarkdown, preservationProof.afterCanonical)
        const beforeLocalSlotsMatch = Boolean(
          beforeSourceFragment && beforeCanonicalFragment &&
          areMarkdownListSlotsEquivalent(beforeSourceFragment, beforeCanonicalFragment, {
            strictOrderedNumbers: true,
            strictNesting: true
          })
        )
        const afterLocalSlotsMatch = Boolean(
          afterSourceFragment && afterCanonicalFragment &&
          areMarkdownListSlotsEquivalent(afterSourceFragment, afterCanonicalFragment, {
            strictOrderedNumbers: true,
            strictNesting: true
          })
        )
        localizedListProofOk = beforeLocalSlotsMatch && afterLocalSlotsMatch
        localizedListProofTrace = {
          proof: preservationProof,
          beforeSourceFragment,
          beforeCanonicalFragment,
          afterSourceFragment,
          afterCanonicalFragment,
          beforeLocalSlotsMatch,
          afterLocalSlotsMatch
        }
      }

      let listTransitionOk = false
      if (
        !listSlotsMatch &&
        !committedCheckpointOk &&
        checkpointTrusted &&
        typeof authoredSource === 'string' &&
        typeof canonicalBaseline === 'string' &&
        typeof canonical === 'string' &&
        preservationReason &&
        preservationReason !== 'committed-source-baseline'
      ) {
        listTransitionOk = areMarkdownListSlotTransitionsEquivalent(
          authoredSource,
          markdown,
          canonicalBaseline,
          expectedMarkdown,
          { strictOrderedNumbers: true, strictNesting: true }
        )
      }

      const semanticProofOk = !tableColumnWidthProofInvalid &&
        !transactionListTransientProofInvalid &&
        (semanticOk || committedCheckpointOk || transitionOk)
      const listProofOk = listSlotsMatch || committedCheckpointOk || listTransitionOk || localizedListProofOk
      const ok = semanticProofOk && listProofOk
      // Legacy direct callers historically use validation as their checkpoint
      // boundary, so trust remains the default. Coordinator candidates disable
      // this side effect and establish trust only after host commit succeeds.
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
          transitionOk,
          committedCheckpointOk,
          checkpointTrusted,
          listSlotsMatch,
          listTransitionOk,
          localizedListProofOk,
          localizedListProofTrace,
          transactionListTransientProofInvalid,
          preservationProof: preservationProof || null,
          validationSite,
          preservationReason,
          candidate: markdown,
          canonical: typeof canonical === 'string' ? canonical : null,
          parsed: parsed?.toJSON?.() || null,
          expected: expected?.toJSON?.() || null
        })
        if (trace.length > 20) trace.shift()
      }

      const details = {
        semanticOk,
        transitionOk,
        committedCheckpointOk,
        checkpointTrusted,
        listSlotsMatch,
        listTransitionOk,
        localizedListProofOk,
        localizedListProofTrace,
        transactionListTransientProofInvalid
      }
      return ok
        ? { ok: true, ...details }
        : {
            ok: false,
            reason: !listSlotsMatch
              ? 'source-list-structure-mismatch'
              : 'source-document-mismatch',
            ...details
          }
    } catch (error) {
      return { ok: false, reason: `source-integrity-parse-failed:${error?.name || 'Error'}` }
    }
  }
}
