import { lineEndingNear, markdownLines } from '../markdown-preservation/core.js'
import { listBlockAt } from '../markdown-preservation/lists.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath,
  topLevelSourceSyncEntries
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const LIST_NESTED_EMPTY_BULLET_TAIL_INDENT_TRANSACTION_FAMILY =
  'list-nested-empty-bullet-tail-indent'
export const LIST_NESTED_EMPTY_BULLET_TAIL_INDENT_TRANSACTION_BOUNDARY =
  'transaction-list-nested-empty-bullet-tail-indent'

const rejected = (reason, { deferred = false, recognized = false, reset = false, proof = null } = {}) =>
  Object.freeze({ ok: false, decision: 'rejected', deferred, recognized, reset, reason, proof })

const recognizedRejection = (reason, options = {}) => rejected(reason, {
  ...options,
  recognized: true
})

const plainEmptyParagraph = (node) =>
  node?.type?.name === 'paragraph' && node.isTextblock && node.content?.size === 0

const plainNonEmptyParagraph = (node) =>
  node?.type?.name === 'paragraph' && node.isTextblock && node.content?.size > 0

const plainBulletItem = (node) => {
  if (node?.type?.name !== 'list_item' || node.attrs?.checked != null) return false
  const explicit = node.attrs?.listType
  return explicit == null || explicit === '' || explicit === 'bullet'
}

// Milkdown's parsed top-level list currently carries spread as the string
// "false", while ProseMirror's sinkListItem-created nested wrapper uses the
// schema boolean false. They encode the same list semantics; keep this
// normalization local to the wrapper proof and leave item attrs exact.
const falseSpread = (node) => node?.attrs?.spread === false || node?.attrs?.spread === 'false'

const classify = ({ journal, expectedDoc }) => {
  if (!journal?.oldDoc || !expectedDoc || !Array.isArray(journal.entries)) {
    return rejected('nested-empty-bullet-indent-document-missing')
  }
  const before = topLevelSourceSyncEntries(journal.oldDoc)
  const after = topLevelSourceSyncEntries(expectedDoc)
  if (before.length !== after.length) return rejected('nested-empty-bullet-indent-top-level-count')
  const changed = before
    .map((entry, index) => entry.node?.eq?.(after[index]?.node) === true ? null : index)
    .filter((index) => index != null)
  if (changed.length !== 1) return rejected('nested-empty-bullet-indent-top-level-change-count')

  const topLevelIndex = changed[0]
  const previousList = before[topLevelIndex].node
  const nextList = after[topLevelIndex].node
  if (
    previousList?.type?.name !== 'bullet_list' ||
    nextList?.type?.name !== 'bullet_list' ||
    !sourceSyncAttrsEqual(previousList.attrs, nextList.attrs) ||
    previousList.childCount < 2 ||
    nextList.childCount !== previousList.childCount - 1
  ) return rejected('nested-empty-bullet-indent-list-shape')

  const targetIndex = previousList.childCount - 1
  const parentIndex = targetIndex - 1
  const target = previousList.child(targetIndex)
  const previousParent = previousList.child(parentIndex)
  const nextParent = nextList.child(parentIndex)
  if (
    !plainBulletItem(target) || target.childCount !== 1 || !plainEmptyParagraph(target.firstChild) ||
    !plainBulletItem(previousParent) || previousParent.childCount !== 1 ||
    !plainNonEmptyParagraph(previousParent.firstChild) ||
    !plainBulletItem(nextParent) || nextParent.childCount !== 2 ||
    !sourceSyncAttrsEqual(previousParent.attrs, nextParent.attrs) ||
    previousParent.firstChild?.eq?.(nextParent.firstChild) !== true
  ) return rejected('nested-empty-bullet-indent-target-shape')

  const nested = nextParent.child(1)
  if (
    nested?.type?.name !== 'bullet_list' ||
    !falseSpread(previousList) || !falseSpread(nested) ||
    nested.childCount !== 1 ||
    nested.firstChild?.eq?.(target) !== true
  ) return rejected('nested-empty-bullet-indent-nested-shape')

  for (let index = 0; index < parentIndex; index += 1) {
    if (previousList.child(index)?.eq?.(nextList.child(index)) !== true) {
      return rejected('nested-empty-bullet-indent-sibling-change')
    }
  }

  if (journal.transactionCount !== 1 || journal.stepCount !== 1 || journal.entries.length !== 1) {
    return recognizedRejection('nested-empty-bullet-indent-transaction-count')
  }
  const entry = journal.entries[0]
  const step = entry.steps?.[0]
  const stepDoc = entry.stepDocs?.[0] || entry.beforeDoc
  if (
    !sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(stepDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(entry.afterDoc, expectedDoc)
  ) return recognizedRejection('nested-empty-bullet-indent-step-document')

  if (
    step?.constructor?.name !== 'ReplaceAroundStep' ||
    step.structure !== true ||
    !Number.isFinite(step.from) || !Number.isFinite(step.to) ||
    !Number.isFinite(step.gapFrom) || !Number.isFinite(step.gapTo) ||
    step.insert !== 1 ||
    Number(step.slice?.size || 0) !== 3 ||
    step.slice?.openStart !== 1 || step.slice?.openEnd !== 0
  ) return recognizedRejection('nested-empty-bullet-indent-step-shape')

  const parentPath = [topLevelIndex, parentIndex]
  const targetPath = [topLevelIndex, targetIndex]
  const parentEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, parentPath)
  const targetEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, targetPath)
  const sliceItem = step.slice?.content?.firstChild
  const sliceNested = sliceItem?.childCount === 1 ? sliceItem.firstChild : null
  if (
    !parentEntry || parentEntry.type !== 'list_item' ||
    !targetEntry || targetEntry.type !== 'list_item' ||
    sliceItem?.type?.name !== 'list_item' ||
    sliceNested?.type?.name !== 'bullet_list' ||
    sliceNested.childCount !== 0 ||
    !falseSpread(previousList) || !falseSpread(sliceNested)
  ) return recognizedRejection('nested-empty-bullet-indent-step-slice')

  const parentEnd = parentEntry.beforePos + parentEntry.node.nodeSize
  const targetEnd = targetEntry.beforePos + targetEntry.node.nodeSize
  if (
    targetEntry.beforePos !== parentEnd ||
    step.from !== targetEntry.beforePos - 1 ||
    step.to !== targetEnd ||
    step.gapFrom !== targetEntry.beforePos ||
    step.gapTo !== targetEnd
  ) return recognizedRejection('nested-empty-bullet-indent-step-range')

  let applied
  try { applied = step.apply(stepDoc) } catch { applied = null }
  if (applied?.failed || !applied?.doc || !sameSourceSyncDocument(applied.doc, expectedDoc)) {
    return recognizedRejection('nested-empty-bullet-indent-step-result')
  }

  return Object.freeze({
    ok: true,
    recognized: true,
    topLevelIndex,
    targetIndex,
    parentIndex,
    previousList,
    nextList,
    parentPath: Object.freeze(parentPath),
    targetPath: Object.freeze(targetPath),
    parentNewPath: Object.freeze([topLevelIndex, parentIndex]),
    nestedListPath: Object.freeze([topLevelIndex, parentIndex, 1]),
    nestedItemPath: Object.freeze([topLevelIndex, parentIndex, 1, 0]),
    parentText: previousParent.firstChild.textContent,
    step: Object.freeze({
      name: step.constructor.name,
      from: step.from,
      to: step.to,
      gapFrom: step.gapFrom,
      gapTo: step.gapTo,
      insert: step.insert,
      structure: true,
      sliceSize: Number(step.slice?.size || 0),
      openStart: step.slice?.openStart,
      openEnd: step.slice?.openEnd
    })
  })
}

const markerRows = (markdown, block) => markdownLines(markdown)
  .map((line) => {
    if (line.start < block.start || line.start > block.end) return null
    const text = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
    const match = text.match(/^([ \t]*)([-+*])([ \t]+)(.*)$/)
    if (!match || match[1].length !== block.indent) return null
    return Object.freeze({
      line,
      indent: match[1],
      token: match[2],
      spacing: match[3],
      body: match[4],
      start: line.start,
      end: line.end
    })
  })
  .filter(Boolean)

const resolveSourceList = ({ markdown, doc, topLevelIndex, parentIndex, resolveMarkdownOffset }) => {
  const paragraph = sourceSyncNodeEntryAtPath(doc, [topLevelIndex, parentIndex, 0])
  if (!paragraph) return null
  let rawOffset
  try {
    rawOffset = resolveMarkdownOffset({
      markdown,
      pmPos: paragraph.contentStart,
      doc,
      topLevelIndex
    })
  } catch {
    return null
  }
  if (!Number.isFinite(rawOffset)) return null
  const block = listBlockAt(markdown, rawOffset)
  if (!block || block.indent !== 0) return null
  return Object.freeze({ block, rows: markerRows(markdown, block), rawOffset })
}

const patchAuthoredTailIndent = ({ source, sourceList, classification }) => {
  if (sourceList.rows.length !== classification.previousList.childCount) return null
  const target = sourceList.rows[classification.targetIndex]
  const parent = sourceList.rows[classification.parentIndex]
  if (!target || !parent) return null
  if (target.body.replace(/\u200B/g, '').trim() !== '') return null
  if (parent.body !== classification.parentText) return null
  if (target.token !== parent.token || target.spacing !== ' ' || parent.spacing !== ' ') return null
  if (!sourceList.rows.every((row) => row.indent === '' && row.token === parent.token && row.spacing === ' ')) {
    return null
  }
  const previousBreakEnd = parent.end < source.length && source[parent.end] === '\n'
    ? parent.end + 1
    : parent.end
  if (previousBreakEnd !== target.start) return null

  const physicalBlockEnd =
    sourceList.block.end < source.length && source[sourceList.block.end] === '\n'
      ? sourceList.block.end + 1
      : sourceList.block.end
  const fragment = source.slice(sourceList.block.start, physicalBlockEnd)
  const endings = new Set(fragment.match(/\r\n|\r|\n/g) || [])
  if (endings.size > 1) return null
  const eol = lineEndingNear(source, target.start)
  const insertion = `${eol}  `
  return Object.freeze({
    markdown: source.slice(0, target.start) + insertion + source.slice(target.start),
    range: Object.freeze({ start: target.start, end: target.start, insertion }),
    row: Object.freeze({
      token: target.token,
      spacing: target.spacing,
      body: target.body,
      indent: target.indent
    }),
    parentRow: Object.freeze({
      token: parent.token,
      spacing: parent.spacing,
      body: parent.body,
      indent: parent.indent
    }),
    eol
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'list-nested-empty-bullet-tail-indented',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_NESTED_EMPTY_BULLET_TAIL_INDENT_TRANSACTION_FAMILY,
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

export function createListNestedEmptyBulletTailIndentTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('nested empty bullet tail indent owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('nested empty bullet tail indent owner requires validateMarkdown')
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
    boundary = LIST_NESTED_EMPTY_BULLET_TAIL_INDENT_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('nested-empty-bullet-indent-journal-stale', { reset: true })
    }
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) {
      return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    }
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('nested-empty-bullet-indent-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('nested-empty-bullet-indent-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('nested-empty-bullet-indent-callback-document-mismatch', { deferred: true })
    }

    const classification = classify({ journal, expectedDoc })
    if (!classification.ok) return classification
    const sourceList = resolveSourceList({
      markdown: journal.source,
      doc: journal.oldDoc,
      topLevelIndex: classification.topLevelIndex,
      parentIndex: classification.parentIndex,
      resolveMarkdownOffset
    })
    if (!sourceList) return recognizedRejection('nested-empty-bullet-indent-range-unmapped')

    const patched = patchAuthoredTailIndent({
      source: journal.source,
      sourceList,
      classification
    })
    if (!patched) return recognizedRejection('nested-empty-bullet-indent-source-row-unproven')

    let valid = false
    try {
      valid = validateMarkdown({ markdown: patched.markdown, expectedDoc }) === true
    } catch {
      valid = false
    }
    if (!valid) return recognizedRejection('nested-empty-bullet-indent-source-invalid')

    const proof = Object.freeze({
      kind: 'transaction-list-nested-empty-bullet-tail-indent-proof',
      journalId: journal.journalId,
      family: LIST_NESTED_EMPTY_BULLET_TAIL_INDENT_TRANSACTION_FAMILY,
      listType: 'bullet_list',
      topLevelIndex: classification.topLevelIndex,
      targetIndex: classification.targetIndex,
      parentIndex: classification.parentIndex,
      parentPath: classification.parentPath,
      targetPath: classification.targetPath,
      parentNewPath: classification.parentNewPath,
      nestedListPath: classification.nestedListPath,
      nestedItemPath: classification.nestedItemPath,
      step: classification.step,
      stepDetails: journal.stepDetails,
      chainLength: journal.transactionCount,
      transactionJournal: verified.proof,
      sourceRange: Object.freeze({
        start: sourceList.block.start,
        end: sourceList.block.end,
        rowCount: sourceList.rows.length
      }),
      movedSourceRow: patched.row,
      parentSourceRow: patched.parentRow,
      rawInsertion: patched.range,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(patched.markdown),
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({
      boundary,
      markdown: patched.markdown,
      canonical,
      expectedDoc,
      proof
    })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_NESTED_EMPTY_BULLET_TAIL_INDENT_TRANSACTION_FAMILY,
    boundary: LIST_NESTED_EMPTY_BULLET_TAIL_INDENT_TRANSACTION_BOUNDARY,
    plan
  })
}
