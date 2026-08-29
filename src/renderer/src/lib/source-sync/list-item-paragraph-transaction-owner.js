import { mapPlainTextTransactionsToSource } from '../source-transaction-sync.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  classifySingleAnchoredSubtreeChange,
  onlySourceSyncNodePathChanged,
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath,
  sourceSyncResolvedPositionMatchesPath
} from './top-level-subtree.js'
import {
  transactionsFromSourceSyncTransactionJournal,
  verifySourceSyncTransactionJournalCheckpoint
} from './transaction-journal.js'

export const LIST_ITEM_PARAGRAPH_TRANSACTION_FAMILY =
  'list-item-paragraph-text-replace'
export const LIST_ITEM_PARAGRAPH_TRANSACTION_BOUNDARY =
  'transaction-list-item-paragraph-text'

const rejected = (reason, {
  deferred = false,
  reset = false,
  proof = null
} = {}) => Object.freeze({
  ok: false,
  decision: 'rejected',
  deferred,
  reset,
  reason,
  proof
})

const isSupportedList = (node) =>
  node?.type?.name === 'bullet_list' || node?.type?.name === 'ordered_list'

const isSimpleParagraph = (node, { nonEmpty = false } = {}) => {
  if (
    node?.type?.name !== 'paragraph' ||
    !node.isTextblock ||
    (nonEmpty && node.content?.size <= 0)
  ) return false
  let simple = true
  node.forEach?.((child) => {
    if (!child?.isText || (child.marks?.length || 0) > 0) simple = false
  })
  return simple
}

const isClosedPlainTextSlice = (slice) => {
  if (!slice || slice.size === 0 || slice.content?.size === 0) return true
  if (slice.openStart || slice.openEnd) return false
  let plain = true
  slice.content.forEach?.((node) => {
    if (!node?.isText || (node.marks?.length || 0) > 0) plain = false
  })
  return plain
}

const itemChildren = (item) => {
  const children = []
  item?.forEach?.((node, offset, index) => {
    children.push(Object.freeze({ node, offset, index, type: node?.type?.name || 'unknown' }))
  })
  return children
}

const onlyItemChildChanged = (beforeItem, afterItem, childIndex) => {
  const before = itemChildren(beforeItem)
  const after = itemChildren(afterItem)
  if (before.length !== after.length || !before[childIndex] || !after[childIndex]) return false
  return before.every((entry, index) =>
    index === childIndex || entry.node?.eq?.(after[index]?.node) === true
  )
}

const classifyListItemParagraphJournal = ({ journal, expectedDoc }) => {
  const classification = classifySingleAnchoredSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'list_item',
    reasonPrefix: 'list-item-paragraph'
  })
  if (!classification.ok) return classification

  const itemPath = classification.nodePath
  // Initial migration intentionally owns only items directly under one
  // top-level list. Nested item text remains fail-closed until its ancestor
  // ownership/marker contract is migrated as a separate family.
  if (itemPath.length !== 2) {
    return rejected('list-item-paragraph-path-not-top-level-item', {
      proof: { itemPath }
    })
  }
  const listPath = itemPath.slice(0, -1)
  const previousList = sourceSyncNodeEntryAtPath(journal.oldDoc, listPath)?.node
  const nextList = sourceSyncNodeEntryAtPath(expectedDoc, listPath)?.node
  const previousItem = classification.previousEntry.node
  const nextItem = classification.nextEntry.node
  if (
    !isSupportedList(previousList) ||
    previousList.type?.name !== nextList?.type?.name ||
    !sourceSyncAttrsEqual(previousList.attrs, nextList.attrs) ||
    previousList.childCount !== nextList.childCount ||
    previousItem?.type?.name !== 'list_item' ||
    nextItem?.type?.name !== 'list_item' ||
    previousItem.attrs?.checked != null ||
    nextItem.attrs?.checked != null ||
    !sourceSyncAttrsEqual(previousItem.attrs, nextItem.attrs)
  ) return rejected('list-item-paragraph-list-or-item-contract')

  const beforeChildren = itemChildren(previousItem)
  const afterChildren = itemChildren(nextItem)
  if (beforeChildren.length !== afterChildren.length) {
    return rejected('list-item-paragraph-child-count-changed')
  }
  const changed = beforeChildren.filter((entry, index) =>
    entry.node?.eq?.(afterChildren[index]?.node) !== true
  )
  if (changed.length !== 1) {
    return rejected('list-item-paragraph-change-count')
  }
  const paragraphIndex = changed[0].index
  const previousParagraph = beforeChildren[paragraphIndex]?.node
  const nextParagraph = afterChildren[paragraphIndex]?.node
  if (
    !isSimpleParagraph(previousParagraph, { nonEmpty: true }) ||
    !isSimpleParagraph(nextParagraph) ||
    !sourceSyncAttrsEqual(previousParagraph.attrs, nextParagraph.attrs)
  ) return rejected('list-item-paragraph-not-simple')
  if (previousParagraph.textContent === nextParagraph.textContent) {
    return rejected('list-item-paragraph-text-unchanged')
  }

  let currentDoc = journal.oldDoc
  for (const entry of journal.entries || []) {
    if (!sameSourceSyncDocument(entry.beforeDoc, currentDoc)) {
      return rejected('list-item-paragraph-transaction-chain-mismatch')
    }
    if (!entry.steps?.length) return rejected('list-item-paragraph-step-count')
    let entryDoc = entry.beforeDoc
    for (let index = 0; index < entry.steps.length; index += 1) {
      const step = entry.steps[index]
      if (
        step?.constructor?.name !== 'ReplaceStep' ||
        step.structure === true ||
        !Number.isFinite(step.from) ||
        !Number.isFinite(step.to) ||
        !isClosedPlainTextSlice(step.slice)
      ) return rejected('list-item-paragraph-step-shape')

      const stepDoc = entry.stepDocs?.[index] || (index === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
        return rejected('list-item-paragraph-step-document-missing')
      }
      let $from
      let $to
      try {
        $from = stepDoc.resolve(step.from)
        $to = stepDoc.resolve(step.to)
      } catch {
        return rejected('list-item-paragraph-step-range-unresolvable')
      }
      if (!$from?.sameParent?.($to)) {
        return rejected('list-item-paragraph-cross-parent-range')
      }
      const beforeEntry = sourceSyncNodeEntryAtPath(stepDoc, itemPath)
      const itemDepth = itemPath.length
      if (
        !beforeEntry ||
        beforeEntry.type !== 'list_item' ||
        $from.depth !== itemDepth + 1 ||
        $from.parent?.type?.name !== 'paragraph' ||
        $from.node(itemDepth)?.type?.name !== 'list_item' ||
        $from.before(itemDepth) !== beforeEntry.offset ||
        !sourceSyncResolvedPositionMatchesPath($from, itemPath) ||
        !sourceSyncResolvedPositionMatchesPath($to, itemPath) ||
        $from.index(itemDepth) !== paragraphIndex ||
        $to.index(itemDepth) !== paragraphIndex
      ) return rejected('list-item-paragraph-step-outside-owned-paragraph')
      const beforeItem = beforeEntry.node
      const beforeParagraph = itemChildren(beforeItem)[paragraphIndex]?.node
      if (
        beforeItem.attrs?.checked != null ||
        !sourceSyncAttrsEqual(beforeItem.attrs, previousItem.attrs) ||
        !isSimpleParagraph(beforeParagraph, { nonEmpty: true }) ||
        !sourceSyncAttrsEqual(beforeParagraph.attrs, previousParagraph.attrs)
      ) return rejected('list-item-paragraph-step-baseline-mismatch')

      let applied
      try {
        applied = step.apply(stepDoc)
      } catch {
        return rejected('list-item-paragraph-step-apply-failed')
      }
      if (applied?.failed || !applied?.doc) {
        return rejected('list-item-paragraph-step-apply-failed')
      }
      if (!onlySourceSyncNodePathChanged(stepDoc, applied.doc, itemPath)) {
        return rejected('list-item-paragraph-neighbour-changed')
      }
      const afterItem = sourceSyncNodeEntryAtPath(applied.doc, itemPath)?.node
      if (
        afterItem?.type?.name !== 'list_item' ||
        afterItem.attrs?.checked != null ||
        !sourceSyncAttrsEqual(afterItem.attrs, previousItem.attrs) ||
        !onlyItemChildChanged(beforeItem, afterItem, paragraphIndex)
      ) return rejected('list-item-paragraph-item-structure-changed')
      const afterParagraph = itemChildren(afterItem)[paragraphIndex]?.node
      if (
        !isSimpleParagraph(afterParagraph) ||
        !sourceSyncAttrsEqual(afterParagraph.attrs, previousParagraph.attrs) ||
        beforeParagraph.eq?.(afterParagraph) === true
      ) return rejected('list-item-paragraph-result-not-simple')
      entryDoc = applied.doc
    }
    if (!sameSourceSyncDocument(entryDoc, entry.afterDoc)) {
      return rejected('list-item-paragraph-transaction-result-mismatch')
    }
    currentDoc = entry.afterDoc
  }
  if (!sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return rejected('list-item-paragraph-final-document-mismatch')
  }

  return Object.freeze({
    ...classification,
    itemPath,
    listPath,
    itemIndex: itemPath[1],
    paragraphIndex,
    previousList,
    nextList,
    previousItem,
    nextItem,
    previousParagraph,
    nextParagraph
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'list-item-paragraph-text-change',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_ITEM_PARAGRAPH_TRANSACTION_FAMILY,
    boundary,
    reason: result.reason,
    baseRevision: proof.transactionJournal.baseRevision,
    baseSourceDigest: proof.transactionJournal.baseSourceDigest,
    baseCanonicalDigest: proof.transactionJournal.baseCanonicalDigest,
    proof,
    result,
    canonical,
    expectedDoc,
    publication: Object.freeze({
      result,
      canonical,
      expectedDoc,
      validationSite: boundary,
      boundary,
      notifyChange: true
    })
  })
}

export function createListItemParagraphTransactionSourceSyncOwner({
  mapTransactions = mapPlainTextTransactionsToSource,
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof mapTransactions !== 'function') {
    throw new TypeError('list item paragraph owner requires mapTransactions')
  }
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('list item paragraph owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('list item paragraph owner requires validateMarkdown')
  }

  const plan = ({
    journal,
    activeJournal,
    snapshot,
    currentSource,
    currentCanonical,
    canonical,
    expectedDoc,
    callbackDocumentEquivalent = false,
    boundary = LIST_ITEM_PARAGRAPH_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('list-item-paragraph-journal-stale', { reset: true })
    }
    const verified = verifySourceSyncTransactionJournalCheckpoint({
      checkpoint: journal,
      snapshot,
      expectedDoc
    })
    if (!verified.ok) {
      return rejected(verified.reason, {
        reset: verified.reset,
        proof: verified.proof
      })
    }
    if (
      typeof currentSource !== 'string' ||
      typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' ||
      !expectedDoc
    ) return rejected('list-item-paragraph-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('list-item-paragraph-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('list-item-paragraph-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyListItemParagraphJournal({ journal, expectedDoc })
    if (!classification.ok) return classification
    const transactions = transactionsFromSourceSyncTransactionJournal(journal)
    if (!transactions.length) return rejected('list-item-paragraph-step-count')

    let mapped
    try {
      mapped = mapTransactions({
        source: journal.source,
        transactions,
        oldState: { doc: journal.oldDoc },
        newState: { doc: expectedDoc },
        blockHints: [],
        allowEmptyTextblock: true,
        mapPosition: (markdown, pmPos, doc) => resolveMarkdownOffset({
          markdown,
          pmPos,
          doc,
          topLevelIndex: classification.topLevelIndex,
          itemIndex: classification.itemIndex,
          paragraphIndex: classification.paragraphIndex,
          nodePath: classification.itemPath
        }),
        validateMarkdown: (markdown, mappedExpectedDoc) => validateMarkdown({
          markdown,
          expectedDoc: mappedExpectedDoc
        })
      })
    } catch (error) {
      return rejected(`list-item-paragraph-mapper-threw:${error?.name || 'Error'}`)
    }
    if (!mapped?.ok || typeof mapped.markdown !== 'string') {
      return rejected(mapped?.reason || 'list-item-paragraph-mapper-rejected')
    }

    const proof = Object.freeze({
      kind: 'transaction-list-item-paragraph-proof',
      journalId: journal.journalId,
      family: LIST_ITEM_PARAGRAPH_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      nodePath: classification.itemPath,
      listPath: classification.listPath,
      itemIndex: classification.itemIndex,
      paragraphIndex: classification.paragraphIndex,
      listType: classification.previousList.type?.name || null,
      previousText: classification.previousParagraph.textContent,
      nextText: classification.nextParagraph.textContent,
      emptied: classification.nextParagraph.content.size === 0,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(mapped.markdown),
      mapperReason: mapped.reason || null,
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({ boundary, markdown: mapped.markdown, canonical, expectedDoc, proof })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_ITEM_PARAGRAPH_TRANSACTION_FAMILY,
    boundary: LIST_ITEM_PARAGRAPH_TRANSACTION_BOUNDARY,
    plan
  })
}
