import { listBlockAt } from '../markdown-preservation/lists.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const LIST_SUBTREE_TRANSACTION_FAMILY = 'list-subtree-replace'
export const LIST_SUBTREE_TRANSACTION_BOUNDARY = 'transaction-list-subtree'

const supportedListTypes = new Set(['bullet_list', 'ordered_list'])

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

const listHasMismatchedItemSemantics = (listNode) => {
  if (!supportedListTypes.has(listNode?.type?.name)) return false
  const expectedListType = listNode.type.name === 'ordered_list' ? 'ordered' : 'bullet'
  let mismatched = false
  listNode.forEach?.((item) => {
    if (mismatched || item?.type?.name !== 'list_item') return
    const explicitListType = item.attrs?.listType
    if (
      explicitListType != null &&
      explicitListType !== '' &&
      explicitListType !== expectedListType
    ) {
      mismatched = true
      return
    }
    item.forEach?.((child) => {
      if (!mismatched && supportedListTypes.has(child?.type?.name)) {
        mismatched = listHasMismatchedItemSemantics(child)
      }
    })
  })
  return mismatched
}

const nodeContainsTaskMetadata = (node) => {
  if (!node) return false
  let found = false
  const inspect = (candidate) => {
    if (
      candidate?.type?.name === 'list_item' &&
      candidate?.attrs &&
      candidate.attrs.checked != null
    ) found = true
  }
  inspect(node)
  node.descendants?.((child) => {
    inspect(child)
    return !found
  })
  return found
}

const stableAttrs = (attrs) => Object.fromEntries(
  Object.entries(attrs || {})
    .filter(([, value]) => value != null)
    .sort(([left], [right]) => left.localeCompare(right))
)

const stableAttrsEqual = (left, right) =>
  JSON.stringify(stableAttrs(left)) === JSON.stringify(stableAttrs(right))

const stableAttrsWithoutSpreadEqual = (left, right) => {
  const withoutSpread = (attrs) => Object.fromEntries(
    Object.entries(stableAttrs(attrs)).filter(([key]) => key !== 'spread')
  )
  return JSON.stringify(withoutSpread(left)) === JSON.stringify(withoutSpread(right))
}

const isPlainNonEmptyParagraph = (node) => {
  if (node?.type?.name !== 'paragraph' || !node.isTextblock || node.content?.size <= 0) return false
  let plain = true
  node.forEach?.((child) => {
    if (!child?.isText || (child.marks?.length || 0) !== 0) plain = false
  })
  return plain
}

const isPlainListItem = (node, listType) => {
  if (node?.type?.name !== 'list_item' || node.attrs?.checked != null) return false
  const expected = listType === 'ordered_list' ? 'ordered' : 'bullet'
  const explicit = node.attrs?.listType
  return explicit == null || explicit === '' || explicit === expected
}

const proveBulletSiblingParagraphJoin = ({
  previousList,
  nextList,
  topLevelIndex,
  journal,
  expectedDoc
}) => {
  if (
    previousList?.type?.name !== 'bullet_list' ||
    nextList?.type?.name !== 'bullet_list' ||
    !stableAttrsEqual(previousList.attrs, nextList.attrs) ||
    previousList.childCount !== 2 ||
    nextList.childCount !== 1 ||
    journal?.transactionCount !== 1 ||
    journal?.stepCount !== 1 ||
    journal?.entries?.length !== 1 ||
    journal.entries[0]?.stepCount !== 1
  ) return null

  const previousFirst = previousList.child(0)
  const previousSecond = previousList.child(1)
  const nextFirst = nextList.child(0)
  if (
    !isPlainListItem(previousFirst, 'bullet_list') ||
    !isPlainListItem(previousSecond, 'bullet_list') ||
    !isPlainListItem(nextFirst, 'bullet_list') ||
    previousFirst.childCount !== 1 ||
    previousSecond.childCount !== 1 ||
    nextFirst.childCount !== 2 ||
    !isPlainNonEmptyParagraph(previousFirst.firstChild) ||
    !isPlainNonEmptyParagraph(previousSecond.firstChild) ||
    nextFirst.child(0)?.eq?.(previousFirst.firstChild) !== true ||
    nextFirst.child(1)?.eq?.(previousSecond.firstChild) !== true ||
    !stableAttrsWithoutSpreadEqual(previousFirst.attrs, nextFirst.attrs) ||
    !stableAttrsWithoutSpreadEqual(previousFirst.attrs, previousSecond.attrs)
  ) return null

  const entry = journal.entries[0]
  const step = entry.steps?.[0]
  const stepDoc = entry.stepDocs?.[0] || entry.beforeDoc
  if (
    entry.beforeDoc?.eq?.(journal.oldDoc) !== true ||
    entry.afterDoc?.eq?.(expectedDoc) !== true ||
    stepDoc?.eq?.(journal.oldDoc) !== true ||
    step?.constructor?.name !== 'ReplaceStep' ||
    step.structure !== true ||
    step.slice?.size !== 0 ||
    !Number.isFinite(step.from) ||
    !Number.isFinite(step.to) ||
    step.to <= step.from
  ) return null
  if (typeof step.apply === 'function') {
    let applied = null
    try { applied = step.apply(stepDoc) } catch { applied = null }
    if (applied?.failed || !applied?.doc || applied.doc.eq?.(expectedDoc) !== true) return null
  }

  return Object.freeze({
    kind: 'transaction-list-sibling-item-paragraph-join-proof',
    listType: 'bullet_list',
    topLevelIndex,
    retainedItemPath: Object.freeze([topLevelIndex, 0]),
    removedItemPath: Object.freeze([topLevelIndex, 1]),
    retainedParagraphPath: Object.freeze([topLevelIndex, 0, 0]),
    movedParagraphPath: Object.freeze([topLevelIndex, 0, 1]),
    step: Object.freeze({
      name: step.constructor.name,
      from: step.from,
      to: step.to,
      structure: true,
      sliceSize: step.slice.size
    })
  })
}

const isEditorEmptyParagraph = (node) => {
  if (node?.type?.name !== 'paragraph' || !node.isTextblock) return false
  if (node.content?.size === 0) return true
  let empty = true
  node.forEach?.((child) => {
    const type = child?.type?.name || ''
    if (type !== 'hardbreak' && type !== 'hard_break') empty = false
  })
  return empty
}

const collectInsertedTrailingEmptyParagraphs = ({
  beforeNode,
  afterNode,
  path,
  candidates
}) => {
  if (
    !beforeNode || !afterNode ||
    beforeNode.type?.name !== afterNode.type?.name
  ) return

  if (
    beforeNode.type?.name === 'list_item' &&
    stableAttrsEqual(beforeNode.attrs, afterNode.attrs) &&
    afterNode.childCount === beforeNode.childCount + 1 &&
    beforeNode.childCount >= 1 &&
    isEditorEmptyParagraph(afterNode.child(afterNode.childCount - 1))
  ) {
    let unchangedPrefix = true
    for (let index = 0; index < beforeNode.childCount; index += 1) {
      if (beforeNode.child(index).eq?.(afterNode.child(index)) !== true) {
        unchangedPrefix = false
        break
      }
    }
    if (unchangedPrefix) {
      candidates.push(Object.freeze({
        listItemPath: Object.freeze([...path]),
        paragraphPath: Object.freeze([...path, afterNode.childCount - 1])
      }))
    }
  }

  const sharedChildren = Math.min(beforeNode.childCount || 0, afterNode.childCount || 0)
  for (let index = 0; index < sharedChildren; index += 1) {
    collectInsertedTrailingEmptyParagraphs({
      beforeNode: beforeNode.child(index),
      afterNode: afterNode.child(index),
      path: [...path, index],
      candidates
    })
  }
}

const proveSingleInsertedTrailingEmptyParagraph = ({
  previousList,
  nextList,
  topLevelIndex
}) => {
  const candidates = []
  collectInsertedTrailingEmptyParagraphs({
    beforeNode: previousList,
    afterNode: nextList,
    path: [topLevelIndex],
    candidates
  })
  return candidates.length === 1 ? candidates[0] : null
}

// Authority is limited to LIST TOPOLOGY, not arbitrary content inside a list.
// Text, marks, escapes, images and paragraph bytes keep their mature legacy
// mappers. The signature records only list/list_item hierarchy, item counts and
// list-level attrs (for example ordered starts). A nested item add/remove,
// lift/sink or list split/join changes this signature; a character edit does not.
const listTopologySignature = (listNode) => {
  const topology = (node) => {
    if (!node) return null
    const type = node.type?.name || 'unknown'
    if (supportedListTypes.has(type)) {
      const items = []
      node.forEach?.((child) => {
        if (child.type?.name === 'list_item') items.push(topology(child))
      })
      return { type, attrs: stableAttrs(node.attrs), items }
    }
    if (type === 'list_item') {
      const nested = []
      node.forEach?.((child) => {
        if (supportedListTypes.has(child.type?.name)) nested.push(topology(child))
      })
      return { type, nested }
    }
    return null
  }
  return JSON.stringify(topology(listNode))
}

const topLevelEntries = (doc) => {
  const entries = []
  doc?.forEach?.((node, offset, index) => {
    entries.push({ node, offset, index, type: node?.type?.name || 'unknown' })
  })
  return entries
}

const classifySingleListSubtreeChange = (oldDoc, newDoc) => {
  if (!oldDoc || !newDoc) return rejected('list-subtree-document-missing')
  const before = topLevelEntries(oldDoc)
  const after = topLevelEntries(newDoc)
  let prefix = 0
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix].node?.eq?.(after[prefix].node) === true
  ) prefix += 1

  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix].node?.eq?.(
      after[after.length - 1 - suffix].node
    ) === true
  ) suffix += 1

  const beforeChanged = before.length - prefix - suffix
  const afterChanged = after.length - prefix - suffix
  if (beforeChanged !== 1 || afterChanged !== 1) {
    return rejected('list-subtree-top-level-change-count', {
      proof: { prefix, suffix, beforeChanged, afterChanged }
    })
  }

  const previousEntry = before[prefix]
  const nextEntry = after[prefix]
  if (
    !supportedListTypes.has(previousEntry.type) ||
    !supportedListTypes.has(nextEntry.type)
  ) return rejected('list-subtree-top-level-node-not-list')
  if (previousEntry.type !== nextEntry.type) {
    return rejected('list-subtree-list-type-changed')
  }
  // Task items have an additional source representation contract: a truly
  // empty body needs the existing U+200B sentinel so GFM reparses checked state.
  // The generic list-subtree mapper intentionally owns only plain list items;
  // task metadata stays with the dedicated input-rule/sentinel lifecycle.
  if (
    nodeContainsTaskMetadata(previousEntry.node) ||
    nodeContainsTaskMetadata(nextEntry.node)
  ) return rejected('list-subtree-task-metadata')
  if (
    listHasMismatchedItemSemantics(previousEntry.node) ||
    listHasMismatchedItemSemantics(nextEntry.node)
  ) return rejected('list-subtree-item-list-type-mismatch')
  if (
    listTopologySignature(previousEntry.node) ===
    listTopologySignature(nextEntry.node)
  ) return rejected('list-subtree-topology-unchanged')
  if (previousEntry.node?.eq?.(nextEntry.node) === true) {
    return rejected('list-subtree-document-unchanged')
  }

  return Object.freeze({
    ok: true,
    topLevelIndex: prefix,
    listType: previousEntry.type,
    previousEntry,
    nextEntry,
    unchangedPrefix: prefix,
    unchangedSuffix: suffix
  })
}

const findAnchorPosition = (entry) => {
  if (!entry?.node) return null
  let fallback = null
  let preferred = null
  entry.node.descendants?.((node, relativePos) => {
    if (preferred != null) return false
    if (!node?.isTextblock) return true
    const contentPosition = entry.offset + relativePos + 2
    if (fallback == null) fallback = contentPosition
    if ((node.textContent || '').trim()) preferred = contentPosition
    return false
  })
  return preferred ?? fallback
}

const normalizeBlockRange = (markdown, block) => {
  if (!block || !Number.isInteger(block.start) || !Number.isInteger(block.end)) return null
  let end = block.end
  // markdownLines includes the CR in a CRLF row's line range. Keep the complete
  // authored EOL outside the replaceable subtree so the local mapper cannot
  // split or normalize it.
  if (end > block.start && markdown[end - 1] === '\r' && markdown[end] === '\n') {
    end -= 1
  }
  if (block.start < 0 || end <= block.start || end > markdown.length) return null
  return Object.freeze({ start: block.start, end, indent: block.indent })
}

const trimOwnedFragmentEnd = (value) => String(value || '').replace(/(?:\r\n|\r|\n)+$/, '')

const createOwnedPlan = ({
  boundary,
  markdown,
  canonical,
  expectedDoc,
  proof
}) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: LIST_SUBTREE_TRANSACTION_BOUNDARY,
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_SUBTREE_TRANSACTION_FAMILY,
    boundary,
    reason: LIST_SUBTREE_TRANSACTION_BOUNDARY,
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

/**
 * Transaction-owned list subtree planner.
 *
 * The generic SourceSyncTransactionJournal owns dispatch-time lifecycle,
 * revision binding and StepMap composition. This owner receives one verified
 * journal at callback/forced-flush time, proves that exactly one top-level list
 * topology changed, resolves only that list's three Markdown ranges, and reuses
 * the mature bounded list delta mapper. It cannot capture or publish by itself.
 */
export function createListSubtreeTransactionSourceSyncOwner({
  mapListSubtree,
  resolveMarkdownOffset
} = {}) {
  if (typeof mapListSubtree !== 'function') {
    throw new TypeError('list subtree transaction owner requires mapListSubtree')
  }
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('list subtree transaction owner requires resolveMarkdownOffset')
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
    boundary = LIST_SUBTREE_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('list-subtree-journal-stale', { reset: true })
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
    ) return rejected('list-subtree-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('list-subtree-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('list-subtree-callback-document-mismatch')
    }

    const classification = classifySingleListSubtreeChange(journal.oldDoc, expectedDoc)
    if (!classification.ok) return classification
    const insertedTrailingEmptyParagraph = proveSingleInsertedTrailingEmptyParagraph({
      previousList: classification.previousEntry.node,
      nextList: classification.nextEntry.node,
      topLevelIndex: classification.topLevelIndex
    })
    const siblingParagraphJoin = proveBulletSiblingParagraphJoin({
      previousList: classification.previousEntry.node,
      nextList: classification.nextEntry.node,
      topLevelIndex: classification.topLevelIndex,
      journal,
      expectedDoc
    })

    const resolveRange = ({ markdown, doc, entry, side }) => {
      const pmPos = findAnchorPosition(entry)
      if (!Number.isFinite(pmPos)) return null
      let rawOffset
      try {
        rawOffset = resolveMarkdownOffset({
          markdown,
          pmPos,
          doc,
          topLevelIndex: classification.topLevelIndex,
          side
        })
      } catch {
        return null
      }
      if (!Number.isFinite(rawOffset)) return null
      const block = normalizeBlockRange(markdown, listBlockAt(markdown, rawOffset))
      if (!block || block.indent !== 0) return null
      return Object.freeze({ ...block, pmPos, rawOffset })
    }

    const sourceRange = resolveRange({
      markdown: journal.source,
      doc: journal.oldDoc,
      entry: classification.previousEntry,
      side: 'source'
    })
    const previousRange = resolveRange({
      markdown: journal.canonical,
      doc: journal.oldDoc,
      entry: classification.previousEntry,
      side: 'previous-canonical'
    })
    const nextRange = resolveRange({
      markdown: canonical,
      doc: expectedDoc,
      entry: classification.nextEntry,
      side: 'next-canonical'
    })
    if (!sourceRange || !previousRange || !nextRange) {
      return rejected('list-subtree-range-unmapped')
    }

    const sourceFragment = journal.source.slice(sourceRange.start, sourceRange.end)
    const previousFragment = journal.canonical.slice(previousRange.start, previousRange.end)
    const nextFragment = canonical.slice(nextRange.start, nextRange.end)
    let mapped
    try {
      mapped = mapListSubtree({
        source: sourceFragment,
        previous: previousFragment,
        next: nextFragment,
        siblingParagraphJoin
      })
    } catch (error) {
      return rejected(`list-subtree-mapper-threw:${error?.name || 'Error'}`)
    }
    if (!mapped || mapped.preserved === false || typeof mapped.markdown !== 'string') {
      return rejected(mapped?.reason || 'list-subtree-mapper-rejected')
    }
    if (
      mapped.reason === 'diverged-empty-ordered-backspace-lift' &&
      !insertedTrailingEmptyParagraph
    ) {
      return rejected('list-subtree-transient-empty-path-unproven')
    }
    if (
      mapped.reason === 'diverged-sibling-list-item-paragraph-join' &&
      !siblingParagraphJoin
    ) {
      return rejected('list-subtree-sibling-paragraph-join-unproven')
    }
    if (
      typeof mapped.nextBaseline === 'string' &&
      trimOwnedFragmentEnd(mapped.nextBaseline) !== trimOwnedFragmentEnd(nextFragment)
    ) return rejected('list-subtree-mapper-partial-baseline')

    const trailingEol = String(mapped.markdown || '').match(/(\r\n|\r|\n)$/)?.[1] || ''
    const sourceSuffix = journal.source.slice(sourceRange.end)
    const suffixOwnsRowTerminator = /^(?:\r\n|\r|\n)/.test(sourceSuffix)
    const boundaryEolGrowth =
      mapped.trailingBoundaryNewlineGrowth === 1 &&
      trailingEol &&
      !suffixOwnsRowTerminator
        ? trailingEol
        : ''
    const replacement = trimOwnedFragmentEnd(mapped.markdown) + boundaryEolGrowth
    const markdown = journal.source.slice(0, sourceRange.start) +
      replacement +
      sourceSuffix
    const proof = Object.freeze({
      kind: 'transaction-list-subtree-proof',
      journalId: journal.journalId,
      family: LIST_SUBTREE_TRANSACTION_FAMILY,
      listType: classification.listType,
      topLevelIndex: classification.topLevelIndex,
      unchangedPrefix: classification.unchangedPrefix,
      unchangedSuffix: classification.unchangedSuffix,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceRange,
      previousRange,
      nextRange,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(markdown),
      mapperReason: mapped.reason || null,
      siblingParagraphJoin:
        mapped.reason === 'diverged-sibling-list-item-paragraph-join'
          ? siblingParagraphJoin
          : null,
      transientEmptyListItemPath:
        mapped.reason === 'diverged-empty-ordered-backspace-lift'
          ? insertedTrailingEmptyParagraph.listItemPath
          : null,
      transientEmptyParagraphPath:
        mapped.reason === 'diverged-empty-ordered-backspace-lift'
          ? insertedTrailingEmptyParagraph.paragraphPath
          : null,
      trailingBoundaryNewlineGrowth: boundaryEolGrowth ? 1 : 0,
      suffixOwnedRowTerminator: suffixOwnsRowTerminator,
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({
      boundary,
      markdown,
      canonical,
      expectedDoc,
      proof
    })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_SUBTREE_TRANSACTION_FAMILY,
    boundary: LIST_SUBTREE_TRANSACTION_BOUNDARY,
    plan
  })
}
