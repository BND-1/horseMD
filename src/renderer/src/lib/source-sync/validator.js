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

  if (preservationReason === 'list-empty-item-tail-removed') {
    const removedPath = preservationProof?.removedPath
    const step = preservationProof?.step
    const containerType = preservationProof?.containerType || 'doc'
    const listPath = Array.isArray(preservationProof?.listPath)
      ? preservationProof.listPath
      : [preservationProof?.topLevelIndex]
    const validListPath = Boolean(
      listPath.every((index) => Number.isInteger(index) && index >= 0) &&
      listPath[0] === preservationProof?.topLevelIndex &&
      (
        (containerType === 'doc' && listPath.length === 1) ||
        (
          containerType === 'blockquote' &&
          listPath.length === 2 &&
          Number.isInteger(preservationProof?.quoteChildIndex) &&
          preservationProof.quoteChildIndex >= 0 &&
          listPath[1] === preservationProof.quoteChildIndex
        )
      )
    )
    const pathExtendsList = (path, tailIndex) => Boolean(
      Array.isArray(path) &&
      path.length === listPath.length + 1 &&
      listPath.every((index, pathIndex) => path[pathIndex] === index) &&
      path.at(-1) === tailIndex
    )
    if (
      preservationProof?.kind !== 'transaction-list-empty-item-tail-remove-proof' ||
      preservationProof?.family !== 'list-empty-item-tail-remove' ||
      !['bullet_list', 'ordered_list'].includes(preservationProof?.listType) ||
      preservationProof?.transactionJournal?.snapshotMatched !== true ||
      preservationProof?.transactionJournal?.documentMatched !== true ||
      preservationProof?.chainLength !== 1 ||
      !Number.isInteger(preservationProof?.removedIndex) ||
      preservationProof.removedIndex < 1 ||
      !validListPath ||
      !pathExtendsList(removedPath, preservationProof.removedIndex) ||
      !pathExtendsList(listItemPath, preservationProof.removedIndex - 1) ||
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

  if (preservationReason === 'list-ordered-empty-successor-chain-lifted') {
    const removedPath = preservationProof?.removedPath
    const firstStep = preservationProof?.firstStep
    const relabelSteps = preservationProof?.relabelSteps
    const successorCount = preservationProof?.successorCount
    const stepNames = preservationProof?.transactionJournal?.stepNames
    const validRelabelSteps = Boolean(
      Number.isInteger(successorCount) && successorCount >= 2 &&
      Array.isArray(relabelSteps) && relabelSteps.length === successorCount &&
      Array.isArray(stepNames) && stepNames.length === successorCount + 1 &&
      stepNames[0] === 'ReplaceStep' &&
      stepNames.slice(1).every((name) => name === 'ReplaceAroundStep') &&
      relabelSteps.every((entry, index) => {
        const step = entry?.step
        return entry?.index === index &&
          typeof entry?.oldLabel === 'string' && typeof entry?.finalLabel === 'string' &&
          step?.name === 'ReplaceAroundStep' && step?.structure === true &&
          step?.sliceSize === 2 && step?.insert === 1 && step?.openStart === 0 && step?.openEnd === 0 &&
          Number.isFinite(step?.from) && Number.isFinite(step?.to) && step.to > step.from &&
          Number.isFinite(step?.gapFrom) && Number.isFinite(step?.gapTo) && step.gapTo > step.gapFrom
      })
    )
    if (
      preservationProof?.kind !== 'transaction-list-ordered-empty-successor-chain-proof' ||
      preservationProof?.family !== 'list-ordered-empty-successor-chain-lift' ||
      preservationProof?.listType !== 'ordered_list' ||
      preservationProof?.transactionJournal?.snapshotMatched !== true ||
      preservationProof?.transactionJournal?.documentMatched !== true ||
      preservationProof?.transactionJournal?.transactionCount !== 2 ||
      preservationProof?.transactionJournal?.stepCount !== successorCount + 1 ||
      preservationProof?.chainLength !== 2 ||
      !Number.isInteger(preservationProof?.removedIndex) || preservationProof.removedIndex < 1 ||
      !Array.isArray(removedPath) || removedPath.length !== 2 ||
      removedPath[0] !== preservationProof.topLevelIndex || removedPath[1] !== preservationProof.removedIndex ||
      listItemPath?.length !== 2 || listItemPath[1] !== preservationProof.removedIndex - 1 ||
      paragraphPath?.length !== 3 || paragraphPath[2] !== 1 ||
      !validPathPair ||
      firstStep?.name !== 'ReplaceStep' || firstStep?.structure !== true || firstStep?.sliceSize !== 0 ||
      !Number.isFinite(firstStep?.from) || !Number.isFinite(firstStep?.to) || firstStep.to <= firstStep.from ||
      !Array.isArray(preservationProof?.successorOldLabels) ||
      preservationProof.successorOldLabels.length !== successorCount ||
      !Array.isArray(preservationProof?.successorFinalLabels) ||
      preservationProof.successorFinalLabels.length !== successorCount ||
      !validRelabelSteps
    ) return false
    return [listItemPath]
  }

  if (preservationReason === 'list-ordered-empty-successor-lifted') {
    const removedPath = preservationProof?.removedPath
    const firstStep = preservationProof?.firstStep
    const secondStep = preservationProof?.secondStep
    if (
      preservationProof?.kind !== 'transaction-list-ordered-empty-successor-lift-proof' ||
      preservationProof?.family !== 'list-ordered-empty-successor-lift' ||
      preservationProof?.listType !== 'ordered_list' ||
      preservationProof?.transactionJournal?.snapshotMatched !== true ||
      preservationProof?.transactionJournal?.documentMatched !== true ||
      preservationProof?.chainLength !== 2 ||
      preservationProof?.removedIndex !== 1 ||
      !Array.isArray(removedPath) || removedPath.length !== 2 ||
      removedPath[0] !== preservationProof.topLevelIndex || removedPath[1] !== 1 ||
      listItemPath?.length !== 2 || listItemPath[1] !== 0 ||
      paragraphPath?.length !== 3 || paragraphPath[2] !== 1 ||
      !validPathPair ||
      firstStep?.name !== 'ReplaceStep' || firstStep?.structure !== true || firstStep?.sliceSize !== 0 ||
      !Number.isFinite(firstStep?.from) || !Number.isFinite(firstStep?.to) || firstStep.to <= firstStep.from ||
      secondStep?.name !== 'ReplaceAroundStep' || secondStep?.structure !== true ||
      secondStep?.sliceSize !== 2 || secondStep?.insert !== 1 ||
      !Number.isFinite(secondStep?.from) || !Number.isFinite(secondStep?.to) ||
      !Number.isFinite(secondStep?.gapFrom) || !Number.isFinite(secondStep?.gapTo) ||
      secondStep.gapTo <= secondStep.gapFrom || secondStep.to <= secondStep.from
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

const jsonNodeAtPath = (doc, path) => {
  if (!Array.isArray(path)) return null
  let node = doc?.toJSON?.() || null
  for (const index of path) {
    if (!node || !Array.isArray(node.content) || !node.content[index]) return null
    node = node.content[index]
  }
  return node
}

const activeTrailingEmptyBlockquotePaths = (expectedDoc, paths) => {
  const active = []
  const seen = new Set()
  for (const path of Array.isArray(paths) ? paths : []) {
    if (
      !Array.isArray(path) || path.length < 1 ||
      !path.every((index) => Number.isInteger(index) && index >= 0)
    ) continue
    const key = path.join('.')
    if (seen.has(key)) continue
    const node = jsonNodeAtPath(expectedDoc, path)
    const content = node?.type === 'blockquote' && Array.isArray(node.content)
      ? node.content
      : null
    if (!content || content.length < 2) continue
    let trailingEmptyParagraphs = 0
    for (let index = content.length - 1; index >= 0; index -= 1) {
      const child = content[index]
      if (child?.type !== 'paragraph' || (child.content?.length || 0) !== 0) break
      trailingEmptyParagraphs += 1
    }
    const previous = content.at(-2)
    if (
      trailingEmptyParagraphs === 1 &&
      (previous?.type === 'bullet_list' || previous?.type === 'ordered_list')
    ) {
      seen.add(key)
      active.push(Object.freeze([...path]))
    }
  }
  return Object.freeze(active)
}

export const sourceSyncSemanticOptionsFromContext = (semanticContext, expectedDoc) => {
  const activePaths = activeTrailingEmptyBlockquotePaths(
    expectedDoc,
    semanticContext?.trailingEmptyBlockquoteParagraphPaths
  )
  return Object.freeze({
    ignoreTrailingEmptyBlockquoteParagraphPaths: activePaths
  })
}

const transactionBlockquoteListExitTransientPaths = (preservationReason, preservationProof) => {
  if (preservationReason !== 'trailing-empty-blockquote-paragraph-after-list-exit') {
    return preservationProof?.kind === 'transaction-blockquote-list-exit-pending-proof'
      ? false
      : []
  }
  const nodePath = preservationProof?.nodePath
  const listPath = preservationProof?.listPath
  const removedItemPath = preservationProof?.removedItemPath
  const transientParagraphPath = preservationProof?.transientParagraphPath
  const step = preservationProof?.step
  if (
    preservationProof?.kind !== 'transaction-blockquote-list-exit-pending-proof' ||
    preservationProof?.family !== 'blockquote-paragraph-exit' ||
    preservationProof?.mode !== 'list-exit-pending' ||
    !['bullet_list', 'ordered_list'].includes(preservationProof?.listType) ||
    preservationProof?.transactionJournal?.snapshotMatched !== true ||
    preservationProof?.transactionJournal?.documentMatched !== true ||
    !Array.isArray(nodePath) || nodePath.length !== 1 ||
    !nodePath.every((index) => Number.isInteger(index) && index >= 0) ||
    nodePath[0] !== preservationProof?.topLevelIndex ||
    !Array.isArray(listPath) || listPath.length !== nodePath.length + 1 ||
    !nodePath.every((index, pathIndex) => listPath[pathIndex] === index) ||
    !Number.isInteger(preservationProof?.removedIndex) || preservationProof.removedIndex < 1 ||
    !Array.isArray(removedItemPath) || removedItemPath.length !== listPath.length + 1 ||
    !listPath.every((index, pathIndex) => removedItemPath[pathIndex] === index) ||
    removedItemPath.at(-1) !== preservationProof.removedIndex ||
    !Array.isArray(transientParagraphPath) || transientParagraphPath.length !== nodePath.length + 1 ||
    !nodePath.every((index, pathIndex) => transientParagraphPath[pathIndex] === index) ||
    step?.name !== 'ReplaceAroundStep' || step?.structure !== true ||
    step?.sliceSize !== 1 || step?.openStart !== 1 || step?.openEnd !== 0 ||
    step?.insert !== 1 ||
    !Number.isFinite(step?.from) || !Number.isFinite(step?.to) || step.to <= step.from ||
    !Number.isFinite(step?.gapFrom) || !Number.isFinite(step?.gapTo) || step.gapTo <= step.gapFrom
  ) return false
  return [nodePath]
}

const semanticOptionsForReason = (
  preservationReason,
  preservationProof = null,
  tableColumnWidthPaths = tableColumnWidthProofPaths(preservationReason, preservationProof),
  transientEmptyListItemPaths = transactionListTransientEmptyPaths(
    preservationReason,
    preservationProof
  ),
  transientEmptyBlockquotePaths = transactionBlockquoteListExitTransientPaths(
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
  ignoreTrailingEmptyBlockquoteParagraphPaths:
    Array.isArray(transientEmptyBlockquotePaths) ? transientEmptyBlockquotePaths : [],
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
      const transientEmptyBlockquotePaths = transactionBlockquoteListExitTransientPaths(
        preservationReason,
        preservationProof
      )
      const transactionBlockquoteTransientProofInvalid = transientEmptyBlockquotePaths === false
      const inheritedBlockquotePaths = sourceSyncSemanticOptionsFromContext(
        validationOptions?.inheritedSemanticContext,
        expectedDoc
      ).ignoreTrailingEmptyBlockquoteParagraphPaths
      const proofBlockquotePaths = Array.isArray(transientEmptyBlockquotePaths)
        ? activeTrailingEmptyBlockquotePaths(expectedDoc, transientEmptyBlockquotePaths)
        : []
      const combinedBlockquotePaths = activeTrailingEmptyBlockquotePaths(
        expectedDoc,
        [...inheritedBlockquotePaths, ...proofBlockquotePaths]
      )
      const nextSemanticContext = Object.freeze({
        trailingEmptyBlockquoteParagraphPaths: combinedBlockquotePaths
      })
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
        transientEmptyListItemPaths,
        combinedBlockquotePaths
      )
      const semanticOk = !tableColumnWidthProofInvalid &&
        !transactionListTransientProofInvalid &&
        !transactionBlockquoteTransientProofInvalid &&
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
        !transactionBlockquoteTransientProofInvalid &&
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
          transactionBlockquoteTransientProofInvalid,
          inheritedBlockquoteTransientPaths: inheritedBlockquotePaths,
          activeBlockquoteTransientPaths: combinedBlockquotePaths,
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
        transactionListTransientProofInvalid,
        transactionBlockquoteTransientProofInvalid,
        semanticContext: nextSemanticContext
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
