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
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const BLOCKQUOTE_EXIT_TRANSACTION_FAMILY = 'blockquote-paragraph-exit'
export const BLOCKQUOTE_EXIT_TRANSACTION_BOUNDARY = 'transaction-blockquote-paragraph-exit'

const rejected = (reason, {
  deferred = false,
  recognized = false,
  reset = false,
  proof = null
} = {}) => Object.freeze({
  ok: false,
  decision: 'rejected',
  deferred,
  recognized,
  reset,
  reason,
  proof
})

const recognizedRejection = (reason, options = {}) => rejected(reason, {
  ...options,
  recognized: true
})

const nodeAtPath = (doc, path) => {
  let node = doc
  for (const index of path || []) {
    if (!Number.isInteger(index) || index < 0 || index >= node?.childCount) return null
    node = node.child(index)
  }
  return node
}

const childEntries = (node) => {
  const entries = []
  node?.forEach?.((child, offset, index) => {
    entries.push(Object.freeze({ node: child, offset, index }))
  })
  return entries
}

const isSimpleParagraph = (node, { nonEmpty = true } = {}) => {
  if (node?.type?.name !== 'paragraph' || !node.isTextblock) return false
  if (nonEmpty && node.content?.size <= 0) return false
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

const withoutTrailingEmptyParagraph = (quote) => {
  if (
    quote?.type?.name !== 'blockquote' ||
    quote.childCount < 2 ||
    !isSimpleParagraph(quote.lastChild, { nonEmpty: false }) ||
    quote.lastChild.content.size !== 0
  ) return null
  const children = []
  for (let index = 0; index < quote.childCount - 1; index += 1) {
    children.push(quote.child(index))
  }
  try {
    return quote.type.create(quote.attrs, children, quote.marks)
  } catch {
    return null
  }
}

const withTrailingEmptyParagraph = (quote) => {
  if (
    quote?.type?.name !== 'blockquote' ||
    quote.childCount < 1 ||
    !isSimpleParagraph(quote.lastChild)
  ) return null
  let empty
  try {
    empty = quote.lastChild.type.create(quote.lastChild.attrs)
    return quote.type.create(quote.attrs, [...childEntries(quote).map((entry) => entry.node), empty], quote.marks)
  } catch {
    return null
  }
}

const parentInsertionMatches = ({
  beforeParent,
  afterParent,
  anchorIndex,
  sourceQuote,
  insertedParagraph,
  requireInsertedText = false
}) => {
  if (
    !beforeParent ||
    !afterParent ||
    !sourceSyncAttrsEqual(beforeParent.attrs, afterParent.attrs) ||
    afterParent.childCount !== beforeParent.childCount + 1 ||
    anchorIndex < 0 ||
    anchorIndex >= beforeParent.childCount ||
    afterParent.child(anchorIndex)?.eq?.(sourceQuote) !== true
  ) return false
  const inserted = afterParent.child(anchorIndex + 1)
  if (
    !isSimpleParagraph(inserted, { nonEmpty: requireInsertedText }) ||
    (insertedParagraph && inserted.eq?.(insertedParagraph) !== true)
  ) return false
  for (let index = 0; index < anchorIndex; index += 1) {
    if (beforeParent.child(index).eq?.(afterParent.child(index)) !== true) return false
  }
  for (let index = anchorIndex + 1; index < beforeParent.childCount; index += 1) {
    if (beforeParent.child(index).eq?.(afterParent.child(index + 1)) !== true) return false
  }
  return true
}

const collectExitCandidates = ({
  beforeParent,
  afterParent,
  parentPath,
  candidates
}) => {
  if (!beforeParent || !afterParent || beforeParent.type?.name !== afterParent.type?.name) return
  if (!sourceSyncAttrsEqual(beforeParent.attrs, afterParent.attrs)) return

  if (afterParent.childCount === beforeParent.childCount + 1) {
    for (let anchorIndex = 0; anchorIndex < beforeParent.childCount; anchorIndex += 1) {
      const beforeQuote = beforeParent.child(anchorIndex)
      if (beforeQuote?.type?.name !== 'blockquote') continue
      const finalQuote = afterParent.child(anchorIndex)
      if (finalQuote?.type?.name !== 'blockquote') continue
      let mode = null
      let sourceQuote = null
      if (beforeQuote.eq?.(finalQuote) === true) {
        mode = 'coalesced'
        sourceQuote = beforeQuote
      } else {
        const trimmed = withoutTrailingEmptyParagraph(beforeQuote)
        if (trimmed?.eq?.(finalQuote) === true) {
          mode = 'staged'
          sourceQuote = trimmed
        }
      }
      if (
        !mode ||
        !sourceQuote ||
        sourceQuote.childCount < 1 ||
        !isSimpleParagraph(sourceQuote.lastChild)
      ) continue
      const insertedParagraph = afterParent.child(anchorIndex + 1)
      if (!isSimpleParagraph(insertedParagraph)) continue
      if (!['doc', 'list_item'].includes(beforeParent.type?.name || '')) continue
      if (!parentInsertionMatches({
        beforeParent,
        afterParent,
        anchorIndex,
        sourceQuote,
        insertedParagraph,
        requireInsertedText: true
      })) continue
      const quotePath = Object.freeze([...parentPath, anchorIndex])
      const insertedPath = Object.freeze([...parentPath, anchorIndex + 1])
      candidates.push(Object.freeze({
        parentPath: Object.freeze([...parentPath]),
        parentType: beforeParent.type?.name || 'unknown',
        anchorIndex,
        insertionIndex: anchorIndex + 1,
        quotePath,
        insertedPath,
        mode,
        sourceQuote,
        initialQuote: beforeQuote,
        finalQuote,
        insertedParagraph,
        topLevelIndex: quotePath[0]
      }))
    }
  }

  if (beforeParent.childCount !== afterParent.childCount) return
  for (let index = 0; index < beforeParent.childCount; index += 1) {
    const beforeChild = beforeParent.child(index)
    const afterChild = afterParent.child(index)
    if (beforeChild?.eq?.(afterChild) === true) continue
    collectExitCandidates({
      beforeParent: beforeChild,
      afterParent: afterChild,
      parentPath: [...parentPath, index],
      candidates
    })
  }
}

const classifyBlockquoteExit = ({ oldDoc, expectedDoc }) => {
  if (!oldDoc || !expectedDoc) return rejected('blockquote-exit-document-missing')
  const candidates = []
  collectExitCandidates({
    beforeParent: oldDoc,
    afterParent: expectedDoc,
    parentPath: [],
    candidates
  })
  if (candidates.length !== 1) {
    return rejected('blockquote-exit-target-count', {
      proof: {
        candidateCount: candidates.length,
        candidatePaths: candidates.map((candidate) => candidate.quotePath)
      }
    })
  }
  return Object.freeze({ ok: true, ...candidates[0] })
}

const parentBeforeExitMatches = ({ doc, classification }) => {
  const parent = nodeAtPath(doc, classification.parentPath)
  const baselineParent = nodeAtPath(classification.initialDocument, classification.parentPath)
  const quoteWithEmpty = classification.quoteWithEmpty
  if (
    !parent ||
    !baselineParent ||
    parent.childCount !== baselineParent.childCount ||
    !sourceSyncAttrsEqual(parent.attrs, baselineParent.attrs) ||
    parent.child(classification.anchorIndex)?.eq?.(quoteWithEmpty) !== true
  ) return false
  for (let index = 0; index < baselineParent.childCount; index += 1) {
    if (index === classification.anchorIndex) continue
    if (parent.child(index).eq?.(baselineParent.child(index)) !== true) return false
  }
  return true
}

const parentBeforeSplitMatches = ({ doc, classification }) => {
  if (classification.mode !== 'coalesced') return false
  const parent = nodeAtPath(doc, classification.parentPath)
  const baselineParent = nodeAtPath(classification.initialDocument, classification.parentPath)
  return parent?.eq?.(baselineParent) === true
}

const parentAfterExitMatches = ({
  doc,
  classification,
  requireInsertedText = false
}) => {
  const parent = nodeAtPath(doc, classification.parentPath)
  const baselineParent = nodeAtPath(classification.initialDocument, classification.parentPath)
  return parentInsertionMatches({
    beforeParent: baselineParent,
    afterParent: parent,
    anchorIndex: classification.anchorIndex,
    sourceQuote: classification.sourceQuote,
    insertedParagraph: null,
    requireInsertedText
  })
}

const directParagraphIndexAt = ($position, nodePath) => {
  const quoteDepth = nodePath?.length || 0
  if (
    !$position ||
    quoteDepth <= 0 ||
    $position.depth !== quoteDepth + 1 ||
    $position.parent?.type?.name !== 'paragraph' ||
    $position.node(quoteDepth)?.type?.name !== 'blockquote' ||
    !sourceSyncResolvedPositionMatchesPath($position, nodePath)
  ) return null
  return $position.index(quoteDepth)
}

const classifyPendingBlockquoteExitJournal = ({ journal, expectedDoc }) => {
  const classification = classifySingleAnchoredSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'blockquote',
    reasonPrefix: 'blockquote-exit-pending'
  })
  if (!classification.ok) return classification
  const beforeQuote = classification.previousEntry.node
  const afterQuote = classification.nextEntry.node
  if (
    !sourceSyncAttrsEqual(beforeQuote.attrs, afterQuote.attrs) ||
    beforeQuote.childCount < 1 ||
    afterQuote.childCount !== beforeQuote.childCount + 1 ||
    !isSimpleParagraph(beforeQuote.lastChild) ||
    !isSimpleParagraph(afterQuote.lastChild, { nonEmpty: false }) ||
    afterQuote.lastChild.content.size !== 0
  ) return rejected('blockquote-exit-pending-shape')

  const paragraphIndex = beforeQuote.childCount - 1
  for (let index = 0; index < paragraphIndex; index += 1) {
    if (beforeQuote.child(index).eq?.(afterQuote.child(index)) !== true) {
      return rejected('blockquote-exit-pending-prefix-changed')
    }
  }
  const beforeParagraph = beforeQuote.lastChild
  const retainedParagraph = afterQuote.child(paragraphIndex)
  if (
    !isSimpleParagraph(retainedParagraph) ||
    !sourceSyncAttrsEqual(beforeParagraph.attrs, retainedParagraph.attrs) ||
    !retainedParagraph.textContent.startsWith(beforeParagraph.textContent)
  ) return rejected('blockquote-exit-pending-retained-paragraph-shape')
  const expectedInsertedSuffix = retainedParagraph.textContent.slice(beforeParagraph.textContent.length)
  if (expectedInsertedSuffix && expectedInsertedSuffix !== ' ') {
    return rejected('blockquote-exit-pending-pre-split-suffix-unowned')
  }
  const retainedQuote = withoutTrailingEmptyParagraph(afterQuote)
  if (!retainedQuote) return rejected('blockquote-exit-pending-retained-quote-missing')

  let currentDoc = journal.oldDoc
  let splitSeen = false
  let splitStepName = null
  let splitStructure = null
  let insertedSuffix = ''
  let preSplitTextStepCount = 0
  for (const entry of journal.entries || []) {
    if (!sameSourceSyncDocument(entry.beforeDoc, currentDoc)) {
      return rejected('blockquote-exit-pending-transaction-chain-mismatch')
    }
    if (!entry.steps?.length) return rejected('blockquote-exit-pending-step-count')
    let entryDoc = entry.beforeDoc
    for (let index = 0; index < entry.steps.length; index += 1) {
      if (splitSeen) return rejected('blockquote-exit-pending-extra-step')
      const step = entry.steps[index]
      const stepDoc = entry.stepDocs?.[index] || (index === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
        return rejected('blockquote-exit-pending-step-document-missing')
      }
      if (step?.constructor?.name !== 'ReplaceStep') {
        return rejected('blockquote-exit-pending-step-not-replace')
      }
      const beforeEntry = sourceSyncNodeEntryAtPath(stepDoc, classification.nodePath)
      const currentQuote = beforeEntry?.node
      if (
        currentQuote?.type?.name !== 'blockquote' ||
        !sourceSyncAttrsEqual(currentQuote.attrs, beforeQuote.attrs) ||
        currentQuote.childCount !== beforeQuote.childCount ||
        !isSimpleParagraph(currentQuote.lastChild)
      ) return rejected('blockquote-exit-pending-step-baseline-mismatch')
      for (let childIndex = 0; childIndex < paragraphIndex; childIndex += 1) {
        if (currentQuote.child(childIndex).eq?.(beforeQuote.child(childIndex)) !== true) {
          return rejected('blockquote-exit-pending-step-prefix-changed')
        }
      }

      const paragraphContentStart = beforeEntry.offset + 2 +
        childEntries(currentQuote)
          .slice(0, paragraphIndex)
          .reduce((total, child) => total + child.node.nodeSize, 0)
      const expectedPosition = paragraphContentStart + currentQuote.lastChild.textContent.length
      const slice = step.slice
      const splitContract = Boolean(
        currentQuote.eq?.(retainedQuote) === true &&
        step.from === expectedPosition &&
        step.to === expectedPosition &&
        slice &&
        slice.openStart === 1 &&
        slice.openEnd === 1 &&
        slice.content?.childCount === 2 &&
        slice.content.child(0)?.type?.name === 'paragraph' &&
        slice.content.child(1)?.type?.name === 'paragraph'
      )

      let applied
      try {
        applied = step.apply(stepDoc)
      } catch {
        return rejected('blockquote-exit-pending-step-apply-failed')
      }
      if (applied?.failed || !applied?.doc) {
        return rejected('blockquote-exit-pending-step-apply-failed')
      }
      if (!onlySourceSyncNodePathChanged(stepDoc, applied.doc, classification.nodePath)) {
        return rejected('blockquote-exit-pending-neighbour-changed')
      }

      if (splitContract) {
        const appliedQuote = sourceSyncNodeEntryAtPath(applied.doc, classification.nodePath)?.node
        if (appliedQuote?.eq?.(afterQuote) !== true) {
          return rejected('blockquote-exit-pending-result-mismatch')
        }
        splitSeen = true
        splitStepName = step.constructor.name
        splitStructure = step.structure === true
      } else {
        if (
          step.structure === true ||
          step.from !== expectedPosition ||
          step.to !== expectedPosition ||
          !slice ||
          slice.openStart !== 0 ||
          slice.openEnd !== 0 ||
          slice.content?.childCount !== 1
        ) return rejected('blockquote-exit-pending-pre-split-step-contract')
        const insertedNode = slice.content.child(0)
        const insertedText = insertedNode?.isText && (insertedNode.marks?.length || 0) === 0
          ? insertedNode.text
          : null
        if (typeof insertedText !== 'string' || insertedText.length === 0 || /[\r\n]/.test(insertedText)) {
          return rejected('blockquote-exit-pending-pre-split-text-unproven')
        }
        const appliedQuote = sourceSyncNodeEntryAtPath(applied.doc, classification.nodePath)?.node
        if (
          appliedQuote?.type?.name !== 'blockquote' ||
          appliedQuote.childCount !== currentQuote.childCount ||
          !sourceSyncAttrsEqual(appliedQuote.attrs, currentQuote.attrs)
        ) return rejected('blockquote-exit-pending-pre-split-result-shape')
        for (let childIndex = 0; childIndex < paragraphIndex; childIndex += 1) {
          if (appliedQuote.child(childIndex).eq?.(currentQuote.child(childIndex)) !== true) {
            return rejected('blockquote-exit-pending-pre-split-prefix-changed')
          }
        }
        const nextParagraph = appliedQuote.lastChild
        if (
          !isSimpleParagraph(nextParagraph) ||
          !sourceSyncAttrsEqual(nextParagraph.attrs, currentQuote.lastChild.attrs) ||
          nextParagraph.textContent !== `${currentQuote.lastChild.textContent}${insertedText}`
        ) return rejected('blockquote-exit-pending-pre-split-result-mismatch')
        insertedSuffix += insertedText
        preSplitTextStepCount += 1
        if (!expectedInsertedSuffix.startsWith(insertedSuffix)) {
          return rejected('blockquote-exit-pending-pre-split-suffix-mismatch')
        }
      }
      entryDoc = applied.doc
    }
    if (!sameSourceSyncDocument(entryDoc, entry.afterDoc)) {
      return rejected('blockquote-exit-pending-transaction-result-mismatch')
    }
    currentDoc = entry.afterDoc
  }
  if (!splitSeen) return rejected('blockquote-exit-pending-step-missing')
  if (insertedSuffix !== expectedInsertedSuffix) {
    return rejected('blockquote-exit-pending-inserted-suffix-mismatch')
  }
  if (!sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return rejected('blockquote-exit-pending-final-document-mismatch')
  }
  return Object.freeze({
    ...classification,
    beforeQuote,
    afterQuote,
    splitStepName,
    splitStructure,
    insertedSuffix,
    preSplitTextStepCount
  })
}
const supportedList = (node) =>
  node?.type?.name === 'bullet_list' || node?.type?.name === 'ordered_list'

const plainEmptyListItem = (node) =>
  node?.type?.name === 'list_item' &&
  node.attrs?.checked == null &&
  node.childCount === 1 &&
  isSimpleParagraph(node.firstChild, { nonEmpty: false }) &&
  node.firstChild.content.size === 0

const classifyBlockquoteListExitPendingJournal = ({ journal, expectedDoc }) => {
  const classification = classifySingleAnchoredSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'blockquote',
    reasonPrefix: 'blockquote-list-exit-pending'
  })
  if (!classification.ok) return classification
  // This first repair owns the exact real failure: a top-level blockquote list
  // whose final empty item is lifted into one trailing empty quote paragraph.
  // Nested quote/list combinations remain separate until they are observed.
  if (classification.nodePath?.length !== 1) {
    return rejected('blockquote-list-exit-pending-not-top-level')
  }
  const beforeQuote = classification.previousEntry.node
  const afterQuote = classification.nextEntry.node
  if (
    !sourceSyncAttrsEqual(beforeQuote.attrs, afterQuote.attrs) ||
    beforeQuote.childCount < 1 ||
    afterQuote.childCount !== beforeQuote.childCount + 1 ||
    !isSimpleParagraph(afterQuote.lastChild, { nonEmpty: false }) ||
    afterQuote.lastChild.content.size !== 0
  ) return rejected('blockquote-list-exit-pending-shape')

  const listIndex = beforeQuote.childCount - 1
  const beforeList = beforeQuote.child(listIndex)
  const afterList = afterQuote.child(listIndex)
  if (
    !supportedList(beforeList) ||
    beforeList.type?.name !== afterList?.type?.name ||
    !sourceSyncAttrsEqual(beforeList.attrs, afterList.attrs) ||
    beforeList.childCount < 2 ||
    afterList.childCount !== beforeList.childCount - 1 ||
    !plainEmptyListItem(beforeList.lastChild)
  ) return rejected('blockquote-list-exit-pending-list-shape')
  for (let index = 0; index < listIndex; index += 1) {
    if (beforeQuote.child(index).eq?.(afterQuote.child(index)) !== true) {
      return rejected('blockquote-list-exit-pending-quote-prefix-changed')
    }
  }
  for (let index = 0; index < afterList.childCount; index += 1) {
    if (beforeList.child(index).eq?.(afterList.child(index)) !== true) {
      return rejected('blockquote-list-exit-pending-list-prefix-changed')
    }
  }

  const listPath = Object.freeze([...classification.nodePath, listIndex])
  const removedIndex = beforeList.childCount - 1
  const removedItemPath = Object.freeze([...listPath, removedIndex])
  const removedParagraphPath = Object.freeze([...removedItemPath, 0])
  const retainedParagraphPath = Object.freeze([...listPath, removedIndex - 1, 0])
  const transientParagraphPath = Object.freeze([...classification.nodePath, afterQuote.childCount - 1])
  const listEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, listPath)
  const removedEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, removedItemPath)
  const removedParagraphEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, removedParagraphPath)
  const retainedParagraphEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, retainedParagraphPath)
  if (
    !listEntry || !removedEntry || !removedParagraphEntry || !retainedParagraphEntry ||
    retainedParagraphEntry.type !== 'paragraph' ||
    !isSimpleParagraph(retainedParagraphEntry.node)
  ) return recognizedRejection('blockquote-list-exit-pending-path')

  const steps = []
  for (const entry of journal.entries || []) {
    for (let index = 0; index < (entry.steps?.length || 0); index += 1) {
      steps.push({
        step: entry.steps[index],
        stepDoc: entry.stepDocs?.[index] || (index === 0 ? entry.beforeDoc : null)
      })
    }
  }
  if (steps.length !== 1) {
    return recognizedRejection('blockquote-list-exit-pending-step-count')
  }
  const { step, stepDoc } = steps[0]
  if (!sameSourceSyncDocument(stepDoc, journal.oldDoc)) {
    return recognizedRejection('blockquote-list-exit-pending-step-document')
  }
  const slice = step?.slice
  if (
    step?.constructor?.name !== 'ReplaceAroundStep' ||
    step.structure !== true ||
    step.from !== removedEntry.beforePos ||
    step.to !== listEntry.beforePos + listEntry.node.nodeSize ||
    step.gapFrom !== removedEntry.contentStart ||
    step.gapTo !== removedEntry.contentStart + removedEntry.node.content.size ||
    step.insert !== 1 ||
    !slice ||
    slice.size !== 1 ||
    slice.openStart !== 1 ||
    slice.openEnd !== 0 ||
    slice.content?.childCount !== 1 ||
    slice.content.child(0)?.type?.name !== beforeList.type?.name ||
    !sourceSyncAttrsEqual(slice.content.child(0)?.attrs, beforeList.attrs) ||
    slice.content.child(0)?.childCount !== 0
  ) return recognizedRejection('blockquote-list-exit-pending-step-contract')
  let applied
  try { applied = step.apply(stepDoc) } catch { applied = null }
  if (applied?.failed || !applied?.doc || !sameSourceSyncDocument(applied.doc, expectedDoc)) {
    return recognizedRejection('blockquote-list-exit-pending-step-result')
  }

  return Object.freeze({
    ...classification,
    beforeQuote,
    afterQuote,
    beforeList,
    afterList,
    listType: beforeList.type.name,
    listIndex,
    listPath,
    removedIndex,
    removedItemPath,
    removedParagraphPath,
    retainedParagraphPath,
    retainedParagraphEntry,
    transientParagraphPath,
    step: Object.freeze({
      name: step.constructor.name,
      from: step.from,
      to: step.to,
      gapFrom: step.gapFrom,
      gapTo: step.gapTo,
      insert: step.insert,
      structure: true,
      sliceSize: slice.size,
      openStart: slice.openStart,
      openEnd: slice.openEnd
    })
  })
}

const classifyBlockquoteExitJournal = ({ journal, expectedDoc }) => {
  const base = classifyBlockquoteExit({ oldDoc: journal?.oldDoc, expectedDoc })
  if (!base.ok) return base
  const quoteWithEmpty = withTrailingEmptyParagraph(base.sourceQuote)
  if (!quoteWithEmpty) return rejected('blockquote-exit-empty-quote-unrepresentable')
  const classification = Object.freeze({
    ...base,
    initialDocument: journal.oldDoc,
    quoteWithEmpty
  })

  let currentDoc = journal.oldDoc
  let splitSeen = base.mode === 'staged'
  let exitSeen = false
  let splitStepName = null
  let splitStructure = null
  let exitStepName = null
  let exitStructure = null
  let exitFrom = null
  let exitTo = null
  for (const entry of journal.entries || []) {
    if (!sameSourceSyncDocument(entry.beforeDoc, currentDoc)) {
      return rejected('blockquote-exit-transaction-chain-mismatch')
    }
    if (!entry.steps?.length) return rejected('blockquote-exit-step-count')
    let entryDoc = entry.beforeDoc
    for (let index = 0; index < entry.steps.length; index += 1) {
      const step = entry.steps[index]
      const stepDoc = entry.stepDocs?.[index] || (index === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
        return rejected('blockquote-exit-step-document-missing')
      }
      let applied
      try {
        applied = step.apply(stepDoc)
      } catch {
        return rejected('blockquote-exit-step-apply-failed')
      }
      if (applied?.failed || !applied?.doc) {
        return rejected('blockquote-exit-step-apply-failed')
      }

      if (!splitSeen) {
        if (
          step?.constructor?.name !== 'ReplaceStep' ||
          !parentBeforeSplitMatches({ doc: stepDoc, classification }) ||
          !parentBeforeExitMatches({ doc: applied.doc, classification }) ||
          !onlySourceSyncNodePathChanged(
            stepDoc,
            applied.doc,
            classification.quotePath
          )
        ) return rejected('blockquote-exit-split-step-shape')
        const quoteEntry = sourceSyncNodeEntryAtPath(stepDoc, classification.quotePath)
        const paragraphIndex = classification.sourceQuote.childCount - 1
        const paragraph = classification.sourceQuote.child(paragraphIndex)
        const paragraphContentStart = quoteEntry.offset + 2 +
          childEntries(classification.sourceQuote)
            .slice(0, paragraphIndex)
            .reduce((total, child) => total + child.node.nodeSize, 0)
        const expectedPosition = paragraphContentStart + paragraph.textContent.length
        const slice = step.slice
        if (
          step.from !== expectedPosition ||
          step.to !== expectedPosition ||
          !slice ||
          slice.openStart !== 1 ||
          slice.openEnd !== 1 ||
          slice.content?.childCount !== 2 ||
          slice.content.child(0)?.type?.name !== 'paragraph' ||
          slice.content.child(1)?.type?.name !== 'paragraph'
        ) return rejected('blockquote-exit-split-step-contract')
        splitSeen = true
        splitStepName = step.constructor.name
        splitStructure = step.structure === true
      } else if (!exitSeen) {
        if (
          step?.constructor?.name !== 'ReplaceAroundStep' ||
          !parentBeforeExitMatches({ doc: stepDoc, classification }) ||
          !parentAfterExitMatches({
            doc: applied.doc,
            classification,
            requireInsertedText: false
          })
        ) return rejected('blockquote-exit-lift-step-shape')
        const quoteEntry = sourceSyncNodeEntryAtPath(stepDoc, classification.quotePath)
        const emptyBefore = quoteEntry.offset + 1 + classification.sourceQuote.content.size
        const slice = step.slice
        if (
          step.from !== emptyBefore ||
          step.to !== emptyBefore + 3 ||
          step.gapFrom !== emptyBefore ||
          step.gapTo !== emptyBefore + 2 ||
          step.insert !== 1 ||
          !slice ||
          slice.size !== 1 ||
          slice.openStart !== 1 ||
          slice.openEnd !== 0 ||
          slice.content?.childCount !== 1 ||
          slice.content.child(0)?.type?.name !== 'blockquote'
        ) return rejected('blockquote-exit-lift-step-contract')
        const inserted = sourceSyncNodeEntryAtPath(
          applied.doc,
          classification.insertedPath
        )?.node
        if (!isSimpleParagraph(inserted, { nonEmpty: false }) || inserted.content.size !== 0) {
          return rejected('blockquote-exit-lift-result')
        }
        exitSeen = true
        exitStepName = step.constructor.name
        exitStructure = step.structure === true
        exitFrom = step.from
        exitTo = step.to
      } else {
        if (
          step?.constructor?.name !== 'ReplaceStep' ||
          step.structure === true ||
          !isClosedPlainTextSlice(step.slice) ||
          !parentAfterExitMatches({
            doc: stepDoc,
            classification,
            requireInsertedText: false
          })
        ) return rejected('blockquote-exit-followup-step-shape')
        let $from
        let $to
        try {
          $from = stepDoc.resolve(step.from)
          $to = stepDoc.resolve(step.to)
        } catch {
          return rejected('blockquote-exit-followup-range-unresolvable')
        }
        const insertedEntry = sourceSyncNodeEntryAtPath(
          stepDoc,
          classification.insertedPath
        )
        if (
          !insertedEntry ||
          !isSimpleParagraph(insertedEntry.node, { nonEmpty: false }) ||
          !$from.sameParent?.($to) ||
          $from.parent !== insertedEntry.node ||
          $from.before(classification.insertedPath.length) !== insertedEntry.offset ||
          !sourceSyncResolvedPositionMatchesPath($from, classification.insertedPath) ||
          !sourceSyncResolvedPositionMatchesPath($to, classification.insertedPath) ||
          !onlySourceSyncNodePathChanged(
            stepDoc,
            applied.doc,
            classification.insertedPath
          ) ||
          !parentAfterExitMatches({
            doc: applied.doc,
            classification,
            requireInsertedText: false
          })
        ) return rejected('blockquote-exit-followup-outside-exited-paragraph')
      }
      entryDoc = applied.doc
    }
    if (!sameSourceSyncDocument(entryDoc, entry.afterDoc)) {
      return rejected('blockquote-exit-transaction-result-mismatch')
    }
    currentDoc = entry.afterDoc
  }
  if (!splitSeen) return rejected('blockquote-exit-split-step-missing')
  if (!exitSeen) return rejected('blockquote-exit-lift-step-missing')
  if (!sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return rejected('blockquote-exit-final-document-mismatch')
  }
  if (!parentAfterExitMatches({
    doc: expectedDoc,
    classification,
    requireInsertedText: true
  })) return rejected('blockquote-exit-final-paragraph-empty')

  return Object.freeze({
    ...classification,
    splitStepName,
    splitStructure,
    exitStepName,
    exitStructure,
    exitFrom,
    exitTo,
    finalInsertedParagraph: sourceSyncNodeEntryAtPath(
      expectedDoc,
      classification.insertedPath
    )?.node
  })
}

const paragraphContentStart = (entry, paragraphIndex) => {
  let childOffset = 0
  for (let index = 0; index < paragraphIndex; index += 1) {
    childOffset += entry.node.child(index).nodeSize
  }
  return entry.offset + 2 + childOffset
}

const lineAtOffset = (source, offset) => {
  if (!Number.isFinite(offset) || offset < 0 || offset > source.length) return null
  let start = offset
  while (start > 0 && source[start - 1] !== '\n' && source[start - 1] !== '\r') start -= 1
  let end = offset
  while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end += 1
  let eol = ''
  if (source.startsWith('\r\n', end)) eol = '\r\n'
  else if (source[end] === '\r') eol = '\r'
  else if (source[end] === '\n') eol = '\n'
  if (!eol) eol = source.match(/\r\n|\r|\n/)?.[0] || '\n'
  return Object.freeze({ start, end, eol })
}

const quotePrefix = (value) => {
  const match = String(value || '').match(/^( {0,3})>([ \t]*)$/)
  return match
    ? Object.freeze({ indent: match[1], spacing: match[2] })
    : null
}

const quoteListRow = ({ source, line, listType }) => {
  if (!line) return null
  const raw = source.slice(line.start, line.end)
  const match = raw.match(/^( {0,3}>[ \t]+)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/)
  if (!match) return null
  const ordered = /^\d/.test(match[2])
  if ((listType === 'ordered_list') !== ordered) return null
  return Object.freeze({
    line,
    prefix: match[1],
    token: match[2],
    spacing: match[3],
    body: match[4],
    bodyStart: line.start + match[1].length + match[2].length + match[3].length
  })
}

const resolveQuoteListTailRows = ({
  markdown,
  doc,
  classification,
  resolveMarkdownOffset
}) => {
  let rawAnchor
  try {
    rawAnchor = resolveMarkdownOffset({
      markdown,
      pmPos: classification.retainedParagraphEntry.contentStart,
      doc,
      topLevelIndex: classification.topLevelIndex,
      paragraphIndex: 0
    })
  } catch {
    return null
  }
  if (!Number.isFinite(rawAnchor)) return null
  const retainedLine = lineAtOffset(markdown, rawAnchor)
  const retained = quoteListRow({
    source: markdown,
    line: retainedLine,
    listType: classification.listType
  })
  if (
    !retained ||
    rawAnchor < retained.bodyStart ||
    rawAnchor > retained.line.end ||
    !retained.line.eol
  ) return null
  const targetStart = retained.line.end + retained.line.eol.length
  if (targetStart >= markdown.length) return null
  const targetLine = lineAtOffset(markdown, targetStart)
  if (!targetLine || targetLine.start !== targetStart) return null
  const target = quoteListRow({
    source: markdown,
    line: targetLine,
    listType: classification.listType
  })
  if (!target || target.prefix !== retained.prefix) return null
  return Object.freeze({ retained, target })
}

const removeProvenQuoteListTailRow = ({ source, rows }) => {
  const target = rows?.target
  if (!target || !/^<br\s*\/?>$/i.test(target.body.trim())) return null
  const end = target.line.end + target.line.eol.length
  return Object.freeze({
    markdown: source.slice(0, target.line.start) + source.slice(end),
    range: Object.freeze({ start: target.line.start, end }),
    row: Object.freeze({
      prefix: target.prefix,
      token: target.token,
      spacing: target.spacing,
      body: target.body,
      eol: target.line.eol
    })
  })
}

const patchPendingBlockquoteSuffix = ({
  source,
  doc,
  classification,
  resolveMarkdownOffset
}) => {
  const suffix = classification?.insertedSuffix || ''
  const beforeText = classification?.beforeQuote?.lastChild?.textContent || ''
  const baselineSingleTrailingSpace = Boolean(
    !suffix && beforeText.endsWith(' ') && !beforeText.endsWith('  ')
  )
  if (!suffix && !baselineSingleTrailingSpace) {
    return Object.freeze({
      markdown: source,
      sourceUnchanged: true,
      range: null,
      quotePrefix: null,
      baselineSingleTrailingSpace: false
    })
  }
  if (suffix && suffix !== ' ') return null
  const quoteEntry = sourceSyncNodeEntryAtPath(doc, classification.nodePath)
  const paragraphIndex = classification.beforeQuote.childCount - 1
  if (!quoteEntry || paragraphIndex < 0) return null
  const textStart = paragraphContentStart(quoteEntry, paragraphIndex)
  let rawStart
  try {
    rawStart = resolveMarkdownOffset({
      markdown: source,
      pmPos: textStart,
      doc,
      topLevelIndex: classification.topLevelIndex,
      paragraphIndex
    })
  } catch {
    return null
  }
  if (!Number.isFinite(rawStart)) return null
  const line = lineAtOffset(source, rawStart)
  if (!line || rawStart < line.start || rawStart > line.end) return null
  const prefix = quotePrefix(source.slice(line.start, rawStart))
  if (!prefix) return null
  const authoredText = source.slice(rawStart, line.end)
  if (authoredText !== beforeText) return null
  if (baselineSingleTrailingSpace) {
    return Object.freeze({
      markdown: source,
      sourceUnchanged: true,
      range: null,
      quotePrefix: source.slice(line.start, rawStart),
      baselineSingleTrailingSpace: true
    })
  }
  const rawEnd = line.end
  return Object.freeze({
    markdown: source.slice(0, rawEnd) + suffix + source.slice(rawEnd),
    sourceUnchanged: false,
    range: Object.freeze({ start: rawEnd, end: rawEnd, replacement: suffix }),
    quotePrefix: source.slice(line.start, rawStart),
    baselineSingleTrailingSpace: false
  })
}

const createOwnedPlan = ({
  boundary,
  markdown,
  canonical,
  expectedDoc,
  proof,
  reason = 'blockquote-paragraph-exit'
}) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason,
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: BLOCKQUOTE_EXIT_TRANSACTION_FAMILY,
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

export function createBlockquoteExitTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('blockquote exit owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('blockquote exit owner requires validateMarkdown')
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
    boundary = BLOCKQUOTE_EXIT_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('blockquote-exit-journal-stale', { reset: true })
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
    ) return rejected('blockquote-exit-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('blockquote-exit-live-snapshot-stale', { reset: true })
    }
    const listExitPending = classifyBlockquoteListExitPendingJournal({ journal, expectedDoc })
    if (listExitPending.ok) {
      const sourceRows = resolveQuoteListTailRows({
        markdown: journal.source,
        doc: journal.oldDoc,
        classification: listExitPending,
        resolveMarkdownOffset
      })
      const previousRows = resolveQuoteListTailRows({
        markdown: journal.canonical,
        doc: journal.oldDoc,
        classification: listExitPending,
        resolveMarkdownOffset
      })
      if (!sourceRows || !previousRows) {
        return recognizedRejection('blockquote-list-exit-pending-range-unmapped')
      }
      if (
        !/^<br\s*\/?>$/i.test(previousRows.target.body.trim()) ||
        sourceRows.target.token !== previousRows.target.token ||
        sourceRows.target.prefix !== previousRows.target.prefix
      ) return recognizedRejection('blockquote-list-exit-pending-previous-row-unproven')
      const removed = removeProvenQuoteListTailRow({ source: journal.source, rows: sourceRows })
      if (!removed) {
        return recognizedRejection('blockquote-list-exit-pending-authored-row-unproven')
      }
      let semanticOk = false
      try {
        semanticOk = validateMarkdown({
          markdown: removed.markdown,
          expectedDoc,
          semanticOptions: {
            ignoreTrailingEmptyBlockquoteParagraphPaths: [listExitPending.nodePath]
          }
        }) === true
      } catch {
        return recognizedRejection('blockquote-list-exit-pending-semantic-validator-threw')
      }
      if (!semanticOk) {
        return recognizedRejection('blockquote-list-exit-pending-semantic-document-mismatch')
      }
      const proof = Object.freeze({
        kind: 'transaction-blockquote-list-exit-pending-proof',
        journalId: journal.journalId,
        family: BLOCKQUOTE_EXIT_TRANSACTION_FAMILY,
        mode: 'list-exit-pending',
        topLevelIndex: listExitPending.topLevelIndex,
        nodePath: listExitPending.nodePath,
        listPath: listExitPending.listPath,
        listType: listExitPending.listType,
        removedIndex: listExitPending.removedIndex,
        removedItemPath: listExitPending.removedItemPath,
        removedParagraphPath: listExitPending.removedParagraphPath,
        retainedParagraphPath: listExitPending.retainedParagraphPath,
        transientParagraphPath: listExitPending.transientParagraphPath,
        step: listExitPending.step,
        rawReplacement: removed.range,
        removedSourceRow: removed.row,
        chainLength: journal.transactionCount,
        stepDetails: journal.stepDetails,
        transactionJournal: verified.proof,
        sourceDigest: sourceSyncDigest(journal.source),
        previousCanonicalDigest: sourceSyncDigest(journal.canonical),
        canonicalDigest: sourceSyncDigest(canonical),
        markdownDigest: sourceSyncDigest(removed.markdown),
        callbackDocumentEquivalent: callbackDocumentEquivalent === true,
        transactionProvenTransientEquivalent: true,
        snapshotMatched: true,
        documentMatched: true
      })
      return createOwnedPlan({
        boundary,
        markdown: removed.markdown,
        canonical,
        expectedDoc,
        proof,
        reason: 'trailing-empty-blockquote-paragraph-after-list-exit'
      })
    }
    if (listExitPending.recognized === true) return listExitPending

    const pending = classifyPendingBlockquoteExitJournal({ journal, expectedDoc })
    if (pending.ok) {
      const patched = patchPendingBlockquoteSuffix({
        source: journal.source,
        doc: journal.oldDoc,
        classification: pending,
        resolveMarkdownOffset
      })
      if (!patched) {
        return recognizedRejection('blockquote-exit-pending-authored-suffix-unmapped')
      }
      let semanticOk = false
      try {
        semanticOk = validateMarkdown({
          markdown: patched.markdown,
          expectedDoc,
          semanticOptions: {
            ignoreTrailingEmptyBlockquoteParagraphPaths: [pending.nodePath],
            ignoreSingleTrailingSpaceBeforeEmptyBlockquoteParagraphPaths:
              (pending.insertedSuffix === ' ' || patched.baselineSingleTrailingSpace)
                ? [pending.nodePath]
                : []
          }
        }) === true
      } catch {
        return recognizedRejection('blockquote-exit-pending-semantic-validator-threw')
      }
      if (!semanticOk) {
        return recognizedRejection('blockquote-exit-pending-semantic-document-mismatch')
      }
      const proof = Object.freeze({
        kind: 'transaction-blockquote-exit-pending-proof',
        journalId: journal.journalId,
        family: BLOCKQUOTE_EXIT_TRANSACTION_FAMILY,
        mode: 'pending',
        topLevelIndex: pending.topLevelIndex,
        nodePath: pending.nodePath,
        splitStepName: pending.splitStepName,
        splitStructure: pending.splitStructure,
        insertedSuffix: pending.insertedSuffix,
        preSplitTextStepCount: pending.preSplitTextStepCount,
        sourceUnchanged: patched.sourceUnchanged,
        rawReplacement: patched.range,
        quotePrefix: patched.quotePrefix,
        baselineSingleTrailingSpace: patched.baselineSingleTrailingSpace === true,
        chainLength: journal.transactionCount,
        stepDetails: journal.stepDetails,
        transactionJournal: verified.proof,
        sourceDigest: sourceSyncDigest(journal.source),
        previousCanonicalDigest: sourceSyncDigest(journal.canonical),
        canonicalDigest: sourceSyncDigest(canonical),
        markdownDigest: sourceSyncDigest(patched.markdown),
        callbackDocumentEquivalent: callbackDocumentEquivalent === true,
        transactionProvenTransientEquivalent: true,
        snapshotMatched: true,
        documentMatched: true
      })
      return createOwnedPlan({
        boundary,
        markdown: patched.markdown,
        canonical,
        expectedDoc,
        proof,
        reason: 'trailing-empty-blockquote-paragraph-created'
      })
    }

    if (callbackDocumentEquivalent !== true) {
      return rejected('blockquote-exit-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyBlockquoteExitJournal({ journal, expectedDoc })
    if (!classification.ok) return classification
    const paragraphIndex = classification.sourceQuote.childCount - 1
    const quoteEntry = sourceSyncNodeEntryAtPath(
      journal.oldDoc,
      classification.quotePath
    )
    const textStart = paragraphContentStart(quoteEntry, paragraphIndex)
    const textValue = classification.sourceQuote.child(paragraphIndex).textContent
    let rawStart
    let rawEnd
    try {
      rawStart = resolveMarkdownOffset({
        markdown: journal.source,
        pmPos: textStart,
        doc: journal.oldDoc,
        topLevelIndex: classification.topLevelIndex,
        paragraphIndex
      })
      rawEnd = resolveMarkdownOffset({
        markdown: journal.source,
        pmPos: textStart + textValue.length,
        doc: journal.oldDoc,
        topLevelIndex: classification.topLevelIndex,
        paragraphIndex
      })
    } catch {
      return recognizedRejection('blockquote-exit-range-mapper-threw')
    }
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd < rawStart) {
      return recognizedRejection('blockquote-exit-range-unmapped')
    }
    if (journal.source.slice(rawStart, rawEnd) !== textValue) {
      return recognizedRejection('blockquote-exit-raw-text-mismatch')
    }
    const line = lineAtOffset(journal.source, rawStart)
    if (!line || rawEnd !== line.end) {
      return recognizedRejection('blockquote-exit-not-single-line')
    }
    const prefixRaw = journal.source.slice(line.start, rawStart)
    const prefix = quotePrefix(prefixRaw)
    if (!prefix) return recognizedRejection('blockquote-exit-prefix-unowned')
    if (classification.parentType === 'doc' && prefix.indent) {
      return recognizedRejection('blockquote-exit-top-level-indent')
    }
    const exitedPrefix = classification.parentType === 'list_item'
      ? prefix.indent
      : ''
    const insertionOffset = line.end + (line.end < journal.source.length ? line.eol.length : 0)
    const insertion = line.eol +
      exitedPrefix +
      classification.finalInsertedParagraph.textContent +
      line.eol
    const markdown = journal.source.slice(0, insertionOffset) +
      insertion +
      journal.source.slice(insertionOffset)

    let semanticOk = false
    try {
      semanticOk = validateMarkdown({ markdown, expectedDoc }) === true
    } catch {
      return recognizedRejection('blockquote-exit-semantic-validator-threw')
    }
    if (!semanticOk) {
      return recognizedRejection('blockquote-exit-semantic-document-mismatch')
    }

    const proof = Object.freeze({
      kind: 'transaction-blockquote-exit-proof',
      journalId: journal.journalId,
      family: BLOCKQUOTE_EXIT_TRANSACTION_FAMILY,
      mode: classification.mode,
      topLevelIndex: classification.topLevelIndex,
      parentPath: classification.parentPath,
      parentType: classification.parentType,
      nodePath: classification.quotePath,
      insertedPath: classification.insertedPath,
      splitStepName: classification.splitStepName,
      splitStructure: classification.splitStructure,
      exitStepName: classification.exitStepName,
      exitStructure: classification.exitStructure,
      exitFrom: classification.exitFrom,
      exitTo: classification.exitTo,
      sourceParagraphIndex: paragraphIndex,
      sourceText: textValue,
      exitedText: classification.finalInsertedParagraph.textContent,
      quotePrefix: prefixRaw,
      exitedPrefix,
      eol: line.eol,
      insertionOffset,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(markdown),
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({ boundary, markdown, canonical, expectedDoc, proof })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: BLOCKQUOTE_EXIT_TRANSACTION_FAMILY,
    boundary: BLOCKQUOTE_EXIT_TRANSACTION_BOUNDARY,
    plan
  })
}
