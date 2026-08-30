import { markdownLines } from '../markdown-preservation/core.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath,
  topLevelSourceSyncEntries
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const LIST_NESTED_LAST_CHILD_BULLET_OUTDENT_TRANSACTION_FAMILY =
  'list-nested-last-child-bullet-outdent'
export const LIST_NESTED_LAST_CHILD_BULLET_OUTDENT_TRANSACTION_BOUNDARY =
  'transaction-list-nested-last-child-bullet-outdent'

const rejected = (reason, { deferred = false, recognized = false, reset = false, proof = null } = {}) =>
  Object.freeze({ ok: false, decision: 'rejected', deferred, recognized, reset, reason, proof })
const recognizedRejection = (reason, options = {}) => rejected(reason, { ...options, recognized: true })

const plainTextParagraph = (node) => {
  if (node?.type?.name !== 'paragraph' || !node.isTextblock || node.content?.size <= 0) return false
  let plain = true
  node.forEach?.((child) => {
    if (!child?.isText || (child.marks?.length || 0) !== 0) plain = false
  })
  return plain
}
const plainBulletItem = (node) => {
  if (node?.type?.name !== 'list_item' || node.attrs?.checked != null) return false
  const explicit = node.attrs?.listType
  return explicit == null || explicit === '' || explicit === 'bullet'
}
const falseSpread = (node) => node?.attrs?.spread === false || node?.attrs?.spread === 'false'
const plainNestedBulletItems = (nested) => {
  if (nested?.type?.name !== 'bullet_list' || !falseSpread(nested) || nested.childCount < 2) return null
  const items = []
  for (let index = 0; index < nested.childCount; index += 1) {
    const item = nested.child(index)
    if (!plainBulletItem(item) || item.childCount !== 1 || !plainTextParagraph(item.firstChild)) return null
    items.push(item)
  }
  return items
}

const classify = ({ journal, expectedDoc }) => {
  if (!journal?.oldDoc || !expectedDoc || !Array.isArray(journal.entries)) {
    return rejected('nested-last-child-outdent-document-missing')
  }
  const before = topLevelSourceSyncEntries(journal.oldDoc)
  const after = topLevelSourceSyncEntries(expectedDoc)
  if (before.length !== after.length) return rejected('nested-last-child-outdent-top-level-count')
  const changed = before
    .map((entry, index) => entry.node?.eq?.(after[index]?.node) === true ? null : index)
    .filter((index) => index != null)
  if (changed.length !== 1) return rejected('nested-last-child-outdent-top-level-change-count')

  const topLevelIndex = changed[0]
  const previousList = before[topLevelIndex].node
  const nextList = after[topLevelIndex].node
  if (
    previousList?.type?.name !== 'bullet_list' || nextList?.type?.name !== 'bullet_list' ||
    !sourceSyncAttrsEqual(previousList.attrs, nextList.attrs) ||
    nextList.childCount !== previousList.childCount + 1
  ) return rejected('nested-last-child-outdent-list-shape')

  const candidates = []
  for (let parentIndex = 0; parentIndex < previousList.childCount; parentIndex += 1) {
    const previousParent = previousList.child(parentIndex)
    if (
      !plainBulletItem(previousParent) || previousParent.childCount !== 2 ||
      !plainTextParagraph(previousParent.firstChild)
    ) continue
    const nested = previousParent.child(1)
    const nestedItems = plainNestedBulletItems(nested)
    if (!nestedItems) continue
    const targetIndex = nestedItems.length - 1
    const target = nestedItems[targetIndex]

    const nextParent = nextList.child(parentIndex)
    const nextTarget = nextList.child(parentIndex + 1)
    if (
      !plainBulletItem(nextParent) || nextParent.childCount !== 2 ||
      !sourceSyncAttrsEqual(previousParent.attrs, nextParent.attrs) ||
      nextParent.firstChild?.eq?.(previousParent.firstChild) !== true ||
      nextTarget?.eq?.(target) !== true
    ) continue
    const nextNested = nextParent.child(1)
    if (
      nextNested?.type?.name !== 'bullet_list' ||
      !sourceSyncAttrsEqual(nested.attrs, nextNested.attrs) ||
      nextNested.childCount !== nested.childCount - 1
    ) continue
    let nestedPrefixMatches = true
    for (let nestedIndex = 0; nestedIndex < targetIndex; nestedIndex += 1) {
      if (nested.child(nestedIndex)?.eq?.(nextNested.child(nestedIndex)) !== true) {
        nestedPrefixMatches = false
        break
      }
    }
    if (!nestedPrefixMatches) continue

    let siblingsMatch = true
    for (let oldIndex = 0; oldIndex < previousList.childCount; oldIndex += 1) {
      if (oldIndex === parentIndex) continue
      const nextIndex = oldIndex > parentIndex ? oldIndex + 1 : oldIndex
      if (previousList.child(oldIndex)?.eq?.(nextList.child(nextIndex)) !== true) {
        siblingsMatch = false
        break
      }
    }
    if (siblingsMatch) {
      candidates.push({ parentIndex, previousParent, nextParent, nested, nextNested, nestedItems, targetIndex, target })
    }
  }
  if (candidates.length !== 1) {
    return rejected('nested-last-child-outdent-target-count', { proof: { candidateCount: candidates.length } })
  }
  const match = candidates[0]

  if (journal.transactionCount !== 1 || journal.stepCount !== 1 || journal.entries.length !== 1) {
    return recognizedRejection('nested-last-child-outdent-transaction-count')
  }
  const entry = journal.entries[0]
  const step = entry.steps?.[0]
  const stepDoc = entry.stepDocs?.[0] || entry.beforeDoc
  if (
    !sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(stepDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(entry.afterDoc, expectedDoc)
  ) return recognizedRejection('nested-last-child-outdent-step-document')

  if (
    step?.constructor?.name !== 'ReplaceAroundStep' || step.structure !== true ||
    !Number.isFinite(step.from) || !Number.isFinite(step.to) ||
    !Number.isFinite(step.gapFrom) || !Number.isFinite(step.gapTo) ||
    step.insert !== 2 || Number(step.slice?.size || 0) !== 2 ||
    step.slice?.openStart !== 2 || step.slice?.openEnd !== 0
  ) return recognizedRejection('nested-last-child-outdent-step-shape')

  const parentPath = [topLevelIndex, match.parentIndex]
  const nestedListPath = [topLevelIndex, match.parentIndex, 1]
  const nestedItemPath = [topLevelIndex, match.parentIndex, 1, match.targetIndex]
  const parentEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, parentPath)
  const nestedEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, nestedListPath)
  const targetEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, nestedItemPath)
  const sliceItem = step.slice?.content?.firstChild
  const sliceNested = sliceItem?.firstChild
  if (
    !parentEntry || parentEntry.type !== 'list_item' ||
    !nestedEntry || nestedEntry.type !== 'bullet_list' ||
    !targetEntry || targetEntry.type !== 'list_item' ||
    sliceItem?.type?.name !== 'list_item' || sliceItem.childCount !== 1 ||
    !sourceSyncAttrsEqual(sliceItem.attrs, match.target.attrs) ||
    sliceNested?.type?.name !== 'bullet_list' || sliceNested.childCount !== 0 ||
    !sourceSyncAttrsEqual(sliceNested.attrs, match.nested.attrs)
  ) return recognizedRejection('nested-last-child-outdent-step-slice')

  const parentEnd = parentEntry.beforePos + parentEntry.node.nodeSize
  const targetEnd = targetEntry.beforePos + targetEntry.node.nodeSize
  if (
    step.from !== targetEntry.beforePos ||
    step.gapFrom !== targetEntry.beforePos ||
    step.gapTo !== targetEnd ||
    step.to !== parentEnd
  ) return recognizedRejection('nested-last-child-outdent-step-range')

  let applied
  try { applied = step.apply(stepDoc) } catch { applied = null }
  if (applied?.failed || !applied?.doc || !sameSourceSyncDocument(applied.doc, expectedDoc)) {
    return recognizedRejection('nested-last-child-outdent-step-result')
  }

  return Object.freeze({
    ok: true,
    recognized: true,
    topLevelIndex,
    parentIndex: match.parentIndex,
    targetIndex: match.targetIndex,
    nestedCount: match.nested.childCount,
    previousList,
    nextList,
    parentPath: Object.freeze(parentPath),
    nestedListPath: Object.freeze(nestedListPath),
    nestedItemPath: Object.freeze(nestedItemPath),
    targetNewPath: Object.freeze([topLevelIndex, match.parentIndex + 1]),
    parentText: match.previousParent.firstChild.textContent,
    nestedTexts: Object.freeze(match.nestedItems.map((item) => item.firstChild.textContent)),
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

const lineAtRawOffset = (markdown, rawOffset) => markdownLines(markdown)
  .find((line) => rawOffset >= line.start && rawOffset <= line.end) || null
const bulletRow = (line) => {
  if (!line) return null
  const text = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
  const match = text.match(/^([ \t]*)([-+*])([ \t]+)(.*)$/)
  if (!match) return null
  return Object.freeze({
    line,
    indent: match[1],
    token: match[2],
    spacing: match[3],
    body: match[4],
    start: line.start,
    end: line.end
  })
}
const physicalEnd = (source, row) => row.end < source.length && source[row.end] === '\n' ? row.end + 1 : row.end

const resolveRows = ({ markdown, doc, classification, resolveMarkdownOffset }) => {
  const parentParagraph = sourceSyncNodeEntryAtPath(doc, [classification.topLevelIndex, classification.parentIndex, 0])
  if (!parentParagraph) return null
  const paragraphEntries = []
  for (let index = 0; index < classification.nestedCount; index += 1) {
    const entry = sourceSyncNodeEntryAtPath(doc, [classification.topLevelIndex, classification.parentIndex, 1, index, 0])
    if (!entry) return null
    paragraphEntries.push(entry)
  }
  const offsets = []
  try {
    offsets.push(resolveMarkdownOffset({
      markdown,
      pmPos: parentParagraph.contentStart,
      doc,
      topLevelIndex: classification.topLevelIndex,
      role: 'parent'
    }))
    for (let index = 0; index < paragraphEntries.length; index += 1) {
      offsets.push(resolveMarkdownOffset({
        markdown,
        pmPos: paragraphEntries[index].contentStart,
        doc,
        topLevelIndex: classification.topLevelIndex,
        role: 'nested-child',
        nestedIndex: index
      }))
    }
  } catch {
    return null
  }
  if (offsets.some((offset) => !Number.isFinite(offset))) return null
  const rows = offsets.map((offset) => bulletRow(lineAtRawOffset(markdown, offset)))
  if (rows.some((row) => !row)) return null
  return Object.freeze({ parent: rows[0], nested: Object.freeze(rows.slice(1)) })
}

const patchAuthoredOutdent = ({ source, rows, classification }) => {
  const { parent, nested } = rows
  if (
    parent.indent !== '' || parent.spacing !== ' ' || parent.body !== classification.parentText ||
    nested.length !== classification.nestedCount
  ) return null
  for (let index = 0; index < nested.length; index += 1) {
    const row = nested[index]
    if (
      row.indent !== '  ' || row.token !== parent.token || row.spacing !== ' ' ||
      row.body !== classification.nestedTexts[index]
    ) return null
    const previous = index === 0 ? parent : nested[index - 1]
    if (physicalEnd(source, previous) !== row.start) return null
  }
  const target = nested[nested.length - 1]
  return Object.freeze({
    markdown: source.slice(0, target.start) + source.slice(target.start + 2),
    range: Object.freeze({ start: target.start, end: target.start + 2, removed: '  ' }),
    parentRow: Object.freeze({ indent: parent.indent, token: parent.token, spacing: parent.spacing, body: parent.body }),
    nestedRows: Object.freeze(nested.map((row) => Object.freeze({
      indent: row.indent,
      token: row.token,
      spacing: row.spacing,
      body: row.body
    }))),
    movedSourceRow: Object.freeze({
      indent: target.indent,
      token: target.token,
      spacing: target.spacing,
      body: target.body
    })
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'list-nested-last-child-bullet-outdented',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_NESTED_LAST_CHILD_BULLET_OUTDENT_TRANSACTION_FAMILY,
    boundary,
    reason: result.reason,
    baseRevision: proof.transactionJournal.baseRevision,
    baseSourceDigest: proof.transactionJournal.baseSourceDigest,
    baseCanonicalDigest: proof.transactionJournal.baseCanonicalDigest,
    proof,
    result,
    canonical,
    expectedDoc,
    publication: Object.freeze({ result, canonical, expectedDoc, validationSite: boundary, boundary, notifyChange: true })
  })
}

export function createListNestedLastChildBulletOutdentTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('nested last child bullet outdent owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('nested last child bullet outdent owner requires validateMarkdown')
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
    boundary = LIST_NESTED_LAST_CHILD_BULLET_OUTDENT_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) return rejected('nested-last-child-outdent-journal-stale', { reset: true })
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('nested-last-child-outdent-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('nested-last-child-outdent-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('nested-last-child-outdent-callback-document-mismatch', { deferred: true })
    }

    const classification = classify({ journal, expectedDoc })
    if (!classification.ok) return classification
    const rows = resolveRows({ markdown: journal.source, doc: journal.oldDoc, classification, resolveMarkdownOffset })
    if (!rows) return recognizedRejection('nested-last-child-outdent-range-unmapped')
    const patched = patchAuthoredOutdent({ source: journal.source, rows, classification })
    if (!patched) return recognizedRejection('nested-last-child-outdent-source-row-unproven')

    let valid = false
    try { valid = validateMarkdown({ markdown: patched.markdown, expectedDoc }) === true } catch { valid = false }
    if (!valid) return recognizedRejection('nested-last-child-outdent-source-invalid')

    const proof = Object.freeze({
      kind: 'transaction-list-nested-last-child-bullet-outdent-proof',
      journalId: journal.journalId,
      family: LIST_NESTED_LAST_CHILD_BULLET_OUTDENT_TRANSACTION_FAMILY,
      listType: 'bullet_list',
      topLevelIndex: classification.topLevelIndex,
      parentIndex: classification.parentIndex,
      targetIndex: classification.targetIndex,
      nestedCount: classification.nestedCount,
      parentPath: classification.parentPath,
      nestedListPath: classification.nestedListPath,
      nestedItemPath: classification.nestedItemPath,
      targetNewPath: classification.targetNewPath,
      step: classification.step,
      stepDetails: journal.stepDetails,
      chainLength: journal.transactionCount,
      transactionJournal: verified.proof,
      parentSourceRow: patched.parentRow,
      nestedSourceRows: patched.nestedRows,
      movedSourceRow: patched.movedSourceRow,
      rawRemoval: patched.range,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(patched.markdown),
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({ boundary, markdown: patched.markdown, canonical, expectedDoc, proof })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_NESTED_LAST_CHILD_BULLET_OUTDENT_TRANSACTION_FAMILY,
    boundary: LIST_NESTED_LAST_CHILD_BULLET_OUTDENT_TRANSACTION_BOUNDARY,
    plan
  })
}
