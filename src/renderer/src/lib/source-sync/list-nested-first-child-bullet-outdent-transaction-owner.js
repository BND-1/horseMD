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

export const LIST_NESTED_FIRST_CHILD_BULLET_OUTDENT_TRANSACTION_FAMILY =
  'list-nested-first-child-bullet-outdent'
export const LIST_NESTED_FIRST_CHILD_BULLET_OUTDENT_TRANSACTION_BOUNDARY =
  'transaction-list-nested-first-child-bullet-outdent'

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

const classifyTopology = ({ journal, expectedDoc }) => {
  if (!journal?.oldDoc || !expectedDoc || !Array.isArray(journal.entries)) {
    return rejected('nested-first-child-outdent-document-missing')
  }
  const before = topLevelSourceSyncEntries(journal.oldDoc)
  const after = topLevelSourceSyncEntries(expectedDoc)
  if (before.length !== after.length) return rejected('nested-first-child-outdent-top-level-count')
  const changed = before
    .map((entry, index) => entry.node?.eq?.(after[index]?.node) === true ? null : index)
    .filter((index) => index != null)
  if (changed.length !== 1) return rejected('nested-first-child-outdent-top-level-change-count')

  const topLevelIndex = changed[0]
  const previousList = before[topLevelIndex].node
  const nextList = after[topLevelIndex].node
  if (
    previousList?.type?.name !== 'bullet_list' || nextList?.type?.name !== 'bullet_list' ||
    !sourceSyncAttrsEqual(previousList.attrs, nextList.attrs) ||
    nextList.childCount !== previousList.childCount + 1
  ) return rejected('nested-first-child-outdent-list-shape')

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
    const target = nestedItems[0]
    const successors = nestedItems.slice(1)

    const nextParent = nextList.child(parentIndex)
    const nextTarget = nextList.child(parentIndex + 1)
    if (
      !plainBulletItem(nextParent) || nextParent.childCount !== 1 ||
      !sourceSyncAttrsEqual(previousParent.attrs, nextParent.attrs) ||
      nextParent.firstChild?.eq?.(previousParent.firstChild) !== true ||
      !plainBulletItem(nextTarget) || nextTarget.childCount !== 2 ||
      !sourceSyncAttrsEqual(target.attrs, nextTarget.attrs) ||
      nextTarget.firstChild?.eq?.(target.firstChild) !== true
    ) continue
    const targetNested = nextTarget.child(1)
    if (
      targetNested?.type?.name !== 'bullet_list' ||
      !sourceSyncAttrsEqual(nested.attrs, targetNested.attrs) ||
      targetNested.childCount !== successors.length
    ) continue
    let movedMatch = true
    for (let index = 0; index < successors.length; index += 1) {
      if (successors[index]?.eq?.(targetNested.child(index)) !== true) {
        movedMatch = false
        break
      }
    }
    if (!movedMatch) continue

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
      candidates.push({ parentIndex, previousParent, nested, nestedItems, target, successors, nextParent, nextTarget, targetNested })
    }
  }
  if (candidates.length !== 1) {
    return rejected('nested-first-child-outdent-target-count', { proof: { candidateCount: candidates.length } })
  }
  const match = candidates[0]
  return Object.freeze({
    ok: true,
    topLevelIndex,
    parentIndex: match.parentIndex,
    previousList,
    nextList,
    previousParent: match.previousParent,
    nested: match.nested,
    nestedItems: Object.freeze(match.nestedItems),
    target: match.target,
    successors: Object.freeze(match.successors),
    nextParent: match.nextParent,
    nextTarget: match.nextTarget,
    targetNested: match.targetNested,
    nestedCount: match.nested.childCount,
    parentText: match.previousParent.firstChild.textContent,
    nestedTexts: Object.freeze(match.nestedItems.map((item) => item.firstChild.textContent))
  })
}

const classifyJournal = ({ journal, expectedDoc, topology }) => {
  if (
    journal.transactionCount !== 1 || journal.stepCount !== 2 || journal.entries?.length !== 1 ||
    journal.entries[0]?.stepCount !== 2
  ) return recognizedRejection('nested-first-child-outdent-transaction-count')

  const entry = journal.entries[0]
  const firstStep = entry.steps?.[0]
  const secondStep = entry.steps?.[1]
  const firstStepDoc = entry.stepDocs?.[0] || entry.beforeDoc
  const secondStepDoc = entry.stepDocs?.[1]
  if (
    !secondStepDoc ||
    !sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(firstStepDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(entry.afterDoc, expectedDoc)
  ) return recognizedRejection('nested-first-child-outdent-step-document')

  const top = topology.topLevelIndex
  const parentPath = [top, topology.parentIndex]
  const nestedListPath = [top, topology.parentIndex, 1]
  const nestedItemPath = [top, topology.parentIndex, 1, 0]
  const firstSuccessorPath = [top, topology.parentIndex, 1, 1]
  const parentEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, parentPath)
  const nestedEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, nestedListPath)
  const targetEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, nestedItemPath)
  const successorEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, firstSuccessorPath)
  if (!parentEntry || !nestedEntry || !targetEntry || !successorEntry) {
    return recognizedRejection('nested-first-child-outdent-old-path')
  }

  if (
    firstStep?.constructor?.name !== 'ReplaceAroundStep' || firstStep.structure !== true ||
    firstStep.insert !== 1 || Number(firstStep.slice?.size || 0) !== 3 ||
    firstStep.slice?.openStart !== 1 || firstStep.slice?.openEnd !== 0 ||
    !Number.isFinite(firstStep.from) || !Number.isFinite(firstStep.to) ||
    !Number.isFinite(firstStep.gapFrom) || !Number.isFinite(firstStep.gapTo)
  ) return recognizedRejection('nested-first-child-outdent-first-step-shape')

  const firstSliceItem = firstStep.slice?.content?.firstChild
  const firstSliceNested = firstSliceItem?.firstChild
  const targetEnd = targetEntry.beforePos + targetEntry.node.nodeSize
  const nestedEnd = nestedEntry.beforePos + nestedEntry.node.nodeSize
  if (
    firstSliceItem?.type?.name !== 'list_item' || firstSliceItem.childCount !== 1 ||
    firstSliceNested?.type?.name !== 'bullet_list' || firstSliceNested.childCount !== 0 ||
    !falseSpread(firstSliceNested) ||
    firstStep.from !== targetEnd - 1 ||
    firstStep.to !== nestedEnd - 1 ||
    firstStep.gapFrom !== successorEntry.beforePos ||
    firstStep.gapTo !== nestedEnd - 1
  ) return recognizedRejection('nested-first-child-outdent-first-step-range')

  let firstApplied
  try { firstApplied = firstStep.apply(firstStepDoc) } catch { firstApplied = null }
  if (firstApplied?.failed || !firstApplied?.doc || !sameSourceSyncDocument(firstApplied.doc, secondStepDoc)) {
    return recognizedRejection('nested-first-child-outdent-first-step-result')
  }
  const intermediateDoc = secondStepDoc
  const intermediateList = sourceSyncNodeEntryAtPath(intermediateDoc, [top])?.node
  const intermediateParent = sourceSyncNodeEntryAtPath(intermediateDoc, parentPath)?.node
  const intermediateNested = sourceSyncNodeEntryAtPath(intermediateDoc, nestedListPath)?.node
  const intermediateTarget = sourceSyncNodeEntryAtPath(intermediateDoc, nestedItemPath)?.node
  const intermediateTargetNested = sourceSyncNodeEntryAtPath(intermediateDoc, [top, topology.parentIndex, 1, 0, 1])?.node
  if (
    intermediateList?.type?.name !== 'bullet_list' ||
    intermediateList.childCount !== topology.previousList.childCount ||
    !sourceSyncAttrsEqual(intermediateList.attrs, topology.previousList.attrs) ||
    !plainBulletItem(intermediateParent) || intermediateParent.childCount !== 2 ||
    !sourceSyncAttrsEqual(intermediateParent.attrs, topology.previousParent.attrs) ||
    intermediateParent.firstChild?.eq?.(topology.previousParent.firstChild) !== true ||
    intermediateNested?.type?.name !== 'bullet_list' || intermediateNested.childCount !== 1 ||
    !sourceSyncAttrsEqual(intermediateNested.attrs, topology.nested.attrs) ||
    !plainBulletItem(intermediateTarget) || intermediateTarget.childCount !== 2 ||
    !sourceSyncAttrsEqual(intermediateTarget.attrs, topology.target.attrs) ||
    intermediateTarget.firstChild?.eq?.(topology.target.firstChild) !== true ||
    intermediateTargetNested?.type?.name !== 'bullet_list' ||
    intermediateTargetNested.childCount !== topology.successors.length ||
    !sourceSyncAttrsEqual(intermediateTargetNested.attrs, topology.nested.attrs)
  ) return recognizedRejection('nested-first-child-outdent-intermediate-shape')
  for (let index = 0; index < topology.successors.length; index += 1) {
    if (intermediateTargetNested.child(index)?.eq?.(topology.successors[index]) !== true) {
      return recognizedRejection('nested-first-child-outdent-intermediate-successor')
    }
  }
  for (let index = 0; index < topology.previousList.childCount; index += 1) {
    if (index === topology.parentIndex) continue
    if (intermediateList.child(index)?.eq?.(topology.previousList.child(index)) !== true) {
      return recognizedRejection('nested-first-child-outdent-intermediate-outer-sibling')
    }
  }

  if (
    secondStep?.constructor?.name !== 'ReplaceAroundStep' || secondStep.structure !== true ||
    secondStep.insert !== 1 || Number(secondStep.slice?.size || 0) !== 1 ||
    secondStep.slice?.openStart !== 1 || secondStep.slice?.openEnd !== 0 ||
    !Number.isFinite(secondStep.from) || !Number.isFinite(secondStep.to) ||
    !Number.isFinite(secondStep.gapFrom) || !Number.isFinite(secondStep.gapTo)
  ) return recognizedRejection('nested-first-child-outdent-second-step-shape')

  const intermediateParentEntry = sourceSyncNodeEntryAtPath(intermediateDoc, parentPath)
  const intermediateNestedEntry = sourceSyncNodeEntryAtPath(intermediateDoc, nestedListPath)
  const intermediateTargetEntry = sourceSyncNodeEntryAtPath(intermediateDoc, nestedItemPath)
  const secondSliceItem = secondStep.slice?.content?.firstChild
  if (
    !intermediateParentEntry || !intermediateNestedEntry || !intermediateTargetEntry ||
    secondSliceItem?.type?.name !== 'list_item' || secondSliceItem.childCount !== 0 ||
    !sourceSyncAttrsEqual(secondSliceItem.attrs, topology.target.attrs) ||
    secondStep.from !== intermediateNestedEntry.beforePos ||
    secondStep.to !== intermediateParentEntry.beforePos + intermediateParentEntry.node.nodeSize ||
    secondStep.gapFrom !== intermediateTargetEntry.beforePos ||
    secondStep.gapTo !== intermediateTargetEntry.beforePos + intermediateTargetEntry.node.nodeSize ||
    intermediateTargetEntry.beforePos !== intermediateNestedEntry.contentStart
  ) return recognizedRejection('nested-first-child-outdent-second-step-range')

  let secondApplied
  try { secondApplied = secondStep.apply(secondStepDoc) } catch { secondApplied = null }
  if (secondApplied?.failed || !secondApplied?.doc || !sameSourceSyncDocument(secondApplied.doc, expectedDoc)) {
    return recognizedRejection('nested-first-child-outdent-second-step-result')
  }

  return Object.freeze({
    ok: true,
    intermediateDoc,
    parentPath: Object.freeze(parentPath),
    nestedListPath: Object.freeze(nestedListPath),
    nestedItemPath: Object.freeze(nestedItemPath),
    targetNewPath: Object.freeze([top, topology.parentIndex + 1]),
    firstStep: Object.freeze({
      name: firstStep.constructor.name,
      from: firstStep.from,
      to: firstStep.to,
      gapFrom: firstStep.gapFrom,
      gapTo: firstStep.gapTo,
      insert: firstStep.insert,
      structure: true,
      sliceSize: Number(firstStep.slice?.size || 0),
      openStart: firstStep.slice?.openStart,
      openEnd: firstStep.slice?.openEnd
    }),
    secondStep: Object.freeze({
      name: secondStep.constructor.name,
      from: secondStep.from,
      to: secondStep.to,
      gapFrom: secondStep.gapFrom,
      gapTo: secondStep.gapTo,
      insert: secondStep.insert,
      structure: true,
      sliceSize: Number(secondStep.slice?.size || 0),
      openStart: secondStep.slice?.openStart,
      openEnd: secondStep.slice?.openEnd
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
  return Object.freeze({ line, indent: match[1], token: match[2], spacing: match[3], body: match[4], start: line.start, end: line.end })
}
const physicalEnd = (source, row) => row.end < source.length && source[row.end] === '\n' ? row.end + 1 : row.end

const resolveRows = ({ markdown, doc, topology, resolveMarkdownOffset }) => {
  const parentParagraph = sourceSyncNodeEntryAtPath(doc, [topology.topLevelIndex, topology.parentIndex, 0])
  if (!parentParagraph) return null
  const nestedParagraphs = []
  for (let index = 0; index < topology.nestedCount; index += 1) {
    const entry = sourceSyncNodeEntryAtPath(doc, [topology.topLevelIndex, topology.parentIndex, 1, index, 0])
    if (!entry) return null
    nestedParagraphs.push(entry)
  }
  const offsets = []
  try {
    offsets.push(resolveMarkdownOffset({
      markdown,
      pmPos: parentParagraph.contentStart,
      doc,
      topLevelIndex: topology.topLevelIndex,
      role: 'parent'
    }))
    for (let index = 0; index < nestedParagraphs.length; index += 1) {
      offsets.push(resolveMarkdownOffset({
        markdown,
        pmPos: nestedParagraphs[index].contentStart,
        doc,
        topLevelIndex: topology.topLevelIndex,
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

const patchAuthoredOutdent = ({ source, rows, topology }) => {
  const { parent, nested } = rows
  if (
    parent.indent !== '' || parent.spacing !== ' ' || parent.body !== topology.parentText ||
    nested.length !== topology.nestedCount
  ) return null
  for (let index = 0; index < nested.length; index += 1) {
    const row = nested[index]
    if (
      row.indent !== '  ' || row.token !== parent.token || row.spacing !== ' ' ||
      row.body !== topology.nestedTexts[index]
    ) return null
    const previous = index === 0 ? parent : nested[index - 1]
    if (physicalEnd(source, previous) !== row.start) return null
  }
  const target = nested[0]
  return Object.freeze({
    markdown: source.slice(0, target.start) + source.slice(target.start + 2),
    range: Object.freeze({ start: target.start, end: target.start + 2, removed: '  ' }),
    parentRow: Object.freeze({ indent: parent.indent, token: parent.token, spacing: parent.spacing, body: parent.body }),
    nestedRows: Object.freeze(nested.map((row) => Object.freeze({ indent: row.indent, token: row.token, spacing: row.spacing, body: row.body }))),
    movedSourceRow: Object.freeze({ indent: target.indent, token: target.token, spacing: target.spacing, body: target.body })
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({ markdown, preserved: true, reason: 'list-nested-first-child-bullet-outdented', integrityProof: proof })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_NESTED_FIRST_CHILD_BULLET_OUTDENT_TRANSACTION_FAMILY,
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

export function createListNestedFirstChildBulletOutdentTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') throw new TypeError('nested first child bullet outdent owner requires resolveMarkdownOffset')
  if (typeof validateMarkdown !== 'function') throw new TypeError('nested first child bullet outdent owner requires validateMarkdown')

  const plan = ({
    journal,
    activeJournal,
    snapshot,
    currentSource,
    currentCanonical,
    canonical,
    expectedDoc,
    callbackDocumentEquivalent = false,
    boundary = LIST_NESTED_FIRST_CHILD_BULLET_OUTDENT_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) return rejected('nested-first-child-outdent-journal-stale', { reset: true })
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('nested-first-child-outdent-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('nested-first-child-outdent-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) return rejected('nested-first-child-outdent-callback-document-mismatch', { deferred: true })

    const topology = classifyTopology({ journal, expectedDoc })
    if (!topology.ok) return topology
    const journalProof = classifyJournal({ journal, expectedDoc, topology })
    if (!journalProof.ok) return journalProof
    const rows = resolveRows({ markdown: journal.source, doc: journal.oldDoc, topology, resolveMarkdownOffset })
    if (!rows) return recognizedRejection('nested-first-child-outdent-range-unmapped')
    const patched = patchAuthoredOutdent({ source: journal.source, rows, topology })
    if (!patched) return recognizedRejection('nested-first-child-outdent-source-row-unproven')

    let valid = false
    try { valid = validateMarkdown({ markdown: patched.markdown, expectedDoc }) === true } catch { valid = false }
    if (!valid) return recognizedRejection('nested-first-child-outdent-source-invalid')

    const proof = Object.freeze({
      kind: 'transaction-list-nested-first-child-bullet-outdent-proof',
      journalId: journal.journalId,
      family: LIST_NESTED_FIRST_CHILD_BULLET_OUTDENT_TRANSACTION_FAMILY,
      listType: 'bullet_list',
      topLevelIndex: topology.topLevelIndex,
      parentIndex: topology.parentIndex,
      targetIndex: 0,
      nestedCount: topology.nestedCount,
      successorCount: topology.successors.length,
      parentPath: journalProof.parentPath,
      nestedListPath: journalProof.nestedListPath,
      nestedItemPath: journalProof.nestedItemPath,
      targetNewPath: journalProof.targetNewPath,
      firstStep: journalProof.firstStep,
      secondStep: journalProof.secondStep,
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
    family: LIST_NESTED_FIRST_CHILD_BULLET_OUTDENT_TRANSACTION_FAMILY,
    boundary: LIST_NESTED_FIRST_CHILD_BULLET_OUTDENT_TRANSACTION_BOUNDARY,
    plan
  })
}
