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

export const LIST_NESTED_FIRST_ORDERED_PARENT_JOIN_TRANSACTION_FAMILY =
  'list-nested-first-ordered-parent-join'
export const LIST_NESTED_FIRST_ORDERED_PARENT_JOIN_TRANSACTION_BOUNDARY =
  'transaction-list-nested-first-ordered-parent-join'

const rejected = (reason, { deferred = false, recognized = false, reset = false, proof = null } = {}) =>
  Object.freeze({ ok: false, decision: 'rejected', deferred, recognized, reset, reason, proof })
const recognizedRejection = (reason, options = {}) => rejected(reason, { ...options, recognized: true })

const plainParagraph = (node) => {
  if (node?.type?.name !== 'paragraph' || !node.isTextblock || node.content?.size <= 0) return false
  let plain = true
  node.forEach?.((child) => {
    if (!child?.isText || (child.marks?.length || 0) !== 0) plain = false
  })
  return plain
}
const plainOrderedItem = (node) => {
  if (node?.type?.name !== 'list_item' || node.attrs?.checked != null) return false
  const explicit = node.attrs?.listType
  return explicit == null || explicit === '' || explicit === 'ordered'
}
const attrsEqualExceptLabel = (left, right) => {
  const omit = (attrs) => Object.fromEntries(
    Object.entries(attrs || {}).filter(([key]) => key !== 'label')
  )
  return JSON.stringify(omit(left)) === JSON.stringify(omit(right))
}

const classifyTopology = ({ journal, expectedDoc }) => {
  if (!journal?.oldDoc || !expectedDoc || !Array.isArray(journal.entries)) {
    return rejected('nested-first-ordered-parent-join-document-missing')
  }
  const before = topLevelSourceSyncEntries(journal.oldDoc)
  const after = topLevelSourceSyncEntries(expectedDoc)
  if (before.length !== after.length) {
    return rejected('nested-first-ordered-parent-join-top-level-count')
  }
  const changed = before
    .map((entry, index) => entry.node?.eq?.(after[index]?.node) === true ? null : index)
    .filter((index) => index != null)
  if (changed.length !== 1) {
    return rejected('nested-first-ordered-parent-join-top-level-change-count', {
      proof: { candidateCount: changed.length }
    })
  }

  const topLevelIndex = changed[0]
  const previousList = before[topLevelIndex].node
  const nextList = after[topLevelIndex].node
  if (
    previousList?.type?.name !== 'ordered_list' ||
    nextList?.type?.name !== 'ordered_list' ||
    !sourceSyncAttrsEqual(previousList.attrs, nextList.attrs) ||
    previousList.childCount !== nextList.childCount
  ) return rejected('nested-first-ordered-parent-join-outer-list-shape')

  const candidates = []
  for (let parentIndex = 0; parentIndex < previousList.childCount; parentIndex += 1) {
    const previousParent = previousList.child(parentIndex)
    const nextParent = nextList.child(parentIndex)
    if (
      !plainOrderedItem(previousParent) || previousParent.childCount !== 2 ||
      !plainParagraph(previousParent.firstChild) ||
      !plainOrderedItem(nextParent) || nextParent.childCount !== 3 ||
      !sourceSyncAttrsEqual(previousParent.attrs, nextParent.attrs) ||
      nextParent.child(0)?.eq?.(previousParent.firstChild) !== true
    ) continue

    const previousNested = previousParent.child(1)
    const nextMovedParagraph = nextParent.child(1)
    const nextNested = nextParent.child(2)
    if (
      previousNested?.type?.name !== 'ordered_list' ||
      nextNested?.type?.name !== 'ordered_list' ||
      !sourceSyncAttrsEqual(previousNested.attrs, nextNested.attrs) ||
      Number(previousNested.attrs?.order || 1) !== 1 ||
      previousNested.childCount !== 2 || nextNested.childCount !== 1
    ) continue

    const targetItem = previousNested.child(0)
    const successorItem = previousNested.child(1)
    const nextSuccessor = nextNested.child(0)
    if (
      !plainOrderedItem(targetItem) || targetItem.childCount !== 1 || !plainParagraph(targetItem.firstChild) ||
      !plainOrderedItem(successorItem) || successorItem.childCount !== 1 || !plainParagraph(successorItem.firstChild) ||
      !plainOrderedItem(nextSuccessor) || nextSuccessor.childCount !== 1 || !plainParagraph(nextSuccessor.firstChild) ||
      nextMovedParagraph?.eq?.(targetItem.firstChild) !== true ||
      nextSuccessor.firstChild?.eq?.(successorItem.firstChild) !== true ||
      !attrsEqualExceptLabel(successorItem.attrs, nextSuccessor.attrs) ||
      targetItem.attrs?.label !== '1.' ||
      successorItem.attrs?.label !== '2.' ||
      nextSuccessor.attrs?.label !== '1.'
    ) continue

    let outerMatch = true
    for (let index = 0; index < previousList.childCount; index += 1) {
      if (index === parentIndex) continue
      if (previousList.child(index)?.eq?.(nextList.child(index)) !== true) {
        outerMatch = false
        break
      }
    }
    if (!outerMatch) continue

    candidates.push({
      topLevelIndex,
      parentIndex,
      previousList,
      nextList,
      previousParent,
      nextParent,
      previousNested,
      nextNested,
      targetItem,
      successorItem,
      nextSuccessor,
      parentText: previousParent.firstChild.textContent,
      targetText: targetItem.firstChild.textContent,
      successorText: successorItem.firstChild.textContent
    })
  }
  if (candidates.length !== 1) {
    return rejected('nested-first-ordered-parent-join-target-count', {
      proof: { candidateCount: candidates.length }
    })
  }
  return Object.freeze({ ok: true, ...candidates[0] })
}

const classifyJournal = ({ journal, expectedDoc, topology }) => {
  if (
    journal.transactionCount !== 2 || journal.stepCount !== 2 ||
    journal.entries?.length !== 2 ||
    journal.entries[0]?.stepCount !== 1 || journal.entries[1]?.stepCount !== 1
  ) return recognizedRejection('nested-first-ordered-parent-join-transaction-count')

  const firstEntry = journal.entries[0]
  const secondEntry = journal.entries[1]
  const firstStep = firstEntry.steps?.[0]
  const secondStep = secondEntry.steps?.[0]
  const firstStepDoc = firstEntry.stepDocs?.[0] || firstEntry.beforeDoc
  const secondStepDoc = secondEntry.stepDocs?.[0] || secondEntry.beforeDoc
  const intermediateDoc = firstEntry.afterDoc
  if (
    !sameSourceSyncDocument(firstEntry.beforeDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(firstStepDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(secondEntry.beforeDoc, intermediateDoc) ||
    !sameSourceSyncDocument(secondStepDoc, intermediateDoc) ||
    !sameSourceSyncDocument(secondEntry.afterDoc, expectedDoc)
  ) return recognizedRejection('nested-first-ordered-parent-join-step-document')

  const top = topology.topLevelIndex
  const parentPath = [top, topology.parentIndex]
  const nestedPath = [top, topology.parentIndex, 1]
  const targetItemPath = [top, topology.parentIndex, 1, 0]
  const targetParagraphPath = [...targetItemPath, 0]
  const successorItemPath = [top, topology.parentIndex, 1, 1]
  const successorParagraphPath = [...successorItemPath, 0]
  const nestedEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, nestedPath)
  const targetEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, targetItemPath)
  const targetParagraphEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, targetParagraphPath)
  if (!nestedEntry || !targetEntry || !targetParagraphEntry) {
    return recognizedRejection('nested-first-ordered-parent-join-old-path')
  }

  const firstSliceList = firstStep?.slice?.content?.firstChild
  if (
    firstStep?.constructor?.name !== 'ReplaceAroundStep' ||
    firstStep.structure !== true || firstStep.insert !== 0 ||
    firstStep.slice?.size !== 1 || firstStep.slice?.openStart !== 0 || firstStep.slice?.openEnd !== 1 ||
    firstSliceList?.type?.name !== 'ordered_list' || firstSliceList.childCount !== 0 ||
    !sourceSyncAttrsEqual(firstSliceList.attrs, topology.previousNested.attrs) ||
    firstStep.from !== nestedEntry.beforePos ||
    firstStep.to !== targetEntry.beforePos + targetEntry.node.nodeSize ||
    firstStep.gapFrom !== targetEntry.beforePos + 1 ||
    firstStep.gapTo !== targetEntry.beforePos + targetEntry.node.nodeSize - 1
  ) return recognizedRejection('nested-first-ordered-parent-join-first-step-contract')

  let firstApplied
  try { firstApplied = firstStep.apply(firstStepDoc) } catch { firstApplied = null }
  if (firstApplied?.failed || !firstApplied?.doc || !sameSourceSyncDocument(firstApplied.doc, intermediateDoc)) {
    return recognizedRejection('nested-first-ordered-parent-join-first-step-result')
  }

  const intermediateParent = sourceSyncNodeEntryAtPath(intermediateDoc, parentPath)?.node
  const intermediateNested = sourceSyncNodeEntryAtPath(intermediateDoc, [top, topology.parentIndex, 2])?.node
  const intermediateSuccessorEntry = sourceSyncNodeEntryAtPath(intermediateDoc, [top, topology.parentIndex, 2, 0])
  if (
    !plainOrderedItem(intermediateParent) || intermediateParent.childCount !== 3 ||
    intermediateParent.child(0)?.eq?.(topology.previousParent.firstChild) !== true ||
    intermediateParent.child(1)?.eq?.(topology.targetItem.firstChild) !== true ||
    intermediateNested?.type?.name !== 'ordered_list' || intermediateNested.childCount !== 1 ||
    !sourceSyncAttrsEqual(intermediateNested.attrs, topology.previousNested.attrs) ||
    intermediateNested.child(0)?.eq?.(topology.successorItem) !== true ||
    !intermediateSuccessorEntry
  ) return recognizedRejection('nested-first-ordered-parent-join-intermediate-shape')

  const secondSliceItem = secondStep?.slice?.content?.firstChild
  if (
    secondStep?.constructor?.name !== 'ReplaceAroundStep' ||
    secondStep.structure !== true || secondStep.insert !== 1 ||
    secondStep.slice?.size !== 2 || secondStep.slice?.openStart !== 0 || secondStep.slice?.openEnd !== 0 ||
    secondSliceItem?.type?.name !== 'list_item' || secondSliceItem.childCount !== 0 ||
    !sourceSyncAttrsEqual(secondSliceItem.attrs, topology.nextSuccessor.attrs) ||
    secondStep.from !== intermediateSuccessorEntry.beforePos ||
    secondStep.to !== intermediateSuccessorEntry.beforePos + intermediateSuccessorEntry.node.nodeSize ||
    secondStep.gapFrom !== intermediateSuccessorEntry.beforePos + 1 ||
    secondStep.gapTo !== intermediateSuccessorEntry.beforePos + intermediateSuccessorEntry.node.nodeSize - 1
  ) return recognizedRejection('nested-first-ordered-parent-join-second-step-contract')

  let secondApplied
  try { secondApplied = secondStep.apply(secondStepDoc) } catch { secondApplied = null }
  if (secondApplied?.failed || !secondApplied?.doc || !sameSourceSyncDocument(secondApplied.doc, expectedDoc)) {
    return recognizedRejection('nested-first-ordered-parent-join-second-step-result')
  }

  return Object.freeze({
    ok: true,
    parentPath: Object.freeze(parentPath),
    nestedPath: Object.freeze(nestedPath),
    targetItemPath: Object.freeze(targetItemPath),
    targetParagraphPath: Object.freeze(targetParagraphPath),
    successorItemPath: Object.freeze(successorItemPath),
    successorParagraphPath: Object.freeze(successorParagraphPath),
    movedParagraphPath: Object.freeze([top, topology.parentIndex, 1]),
    remainingNestedPath: Object.freeze([top, topology.parentIndex, 2]),
    firstStep: Object.freeze({
      name: firstStep.constructor.name,
      from: firstStep.from,
      to: firstStep.to,
      gapFrom: firstStep.gapFrom,
      gapTo: firstStep.gapTo,
      insert: firstStep.insert,
      structure: true,
      sliceSize: firstStep.slice.size,
      openStart: firstStep.slice.openStart,
      openEnd: firstStep.slice.openEnd
    }),
    secondStep: Object.freeze({
      name: secondStep.constructor.name,
      from: secondStep.from,
      to: secondStep.to,
      gapFrom: secondStep.gapFrom,
      gapTo: secondStep.gapTo,
      insert: secondStep.insert,
      structure: true,
      sliceSize: secondStep.slice.size,
      openStart: secondStep.slice.openStart,
      openEnd: secondStep.slice.openEnd
    })
  })
}

const lineAtRawOffset = (markdown, rawOffset) => markdownLines(markdown)
  .find((line) => rawOffset >= line.start && rawOffset <= line.end) || null
const orderedRow = (source, line) => {
  if (!line) return null
  const bareText = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
  const match = bareText.match(/^([ \t]*)(\d{1,9})([.)])([ \t]+)(.*)$/)
  if (!match) return null
  const contentEnd = line.start + bareText.length
  const physicalEnd = line.end < source.length && source[line.end] === '\n' ? line.end + 1 : line.end
  const tokenStart = line.start + match[1].length
  const tokenEnd = tokenStart + match[2].length + match[3].length
  return Object.freeze({
    indent: match[1],
    number: Number(match[2]),
    delimiter: match[3],
    token: `${match[2]}${match[3]}`,
    spacing: match[4],
    body: match[5],
    start: line.start,
    tokenStart,
    tokenEnd,
    bodyStart: tokenEnd + match[4].length,
    contentEnd,
    physicalEnd,
    eol: source.slice(contentEnd, physicalEnd)
  })
}
const authoredPlainTextMatches = (raw, text) => {
  const source = String(raw || '')
  const expected = String(text || '')
  const escapable = /[\\`*{}\[\]()#+\-.!_>~|]/
  let rawIndex = 0
  for (let textIndex = 0; textIndex < expected.length; textIndex += 1) {
    const expectedChar = expected[textIndex]
    if (source[rawIndex] === expectedChar) {
      rawIndex += 1
    } else if (
      source[rawIndex] === '\\' && rawIndex + 1 < source.length &&
      source[rawIndex + 1] === expectedChar && escapable.test(expectedChar)
    ) {
      rawIndex += 2
    } else return false
  }
  return rawIndex === source.length
}

const resolveRows = ({ markdown, doc, topology, resolveMarkdownOffset }) => {
  const paths = [
    [topology.topLevelIndex, topology.parentIndex, 0],
    [topology.topLevelIndex, topology.parentIndex, 1, 0, 0],
    [topology.topLevelIndex, topology.parentIndex, 1, 1, 0]
  ]
  const offsets = []
  for (let index = 0; index < paths.length; index += 1) {
    const entry = sourceSyncNodeEntryAtPath(doc, paths[index])
    if (!entry) return null
    try {
      offsets.push(resolveMarkdownOffset({
        markdown,
        pmPos: entry.contentStart,
        doc,
        topLevelIndex: topology.topLevelIndex,
        role: ['parent', 'target', 'successor'][index]
      }))
    } catch {
      return null
    }
  }
  if (offsets.some((offset) => !Number.isFinite(offset))) return null
  const rows = offsets.map((offset) => orderedRow(markdown, lineAtRawOffset(markdown, offset)))
  if (rows.some((row) => !row)) return null
  return Object.freeze({ parent: rows[0], target: rows[1], successor: rows[2] })
}

const patchAuthoredJoin = ({ source, rows, topology }) => {
  const { parent, target, successor } = rows
  if (
    parent.indent !== '' || parent.spacing !== ' ' ||
    target.indent !== '   ' || successor.indent !== target.indent ||
    target.spacing !== ' ' || successor.spacing !== ' ' ||
    target.number !== 1 || successor.number !== 2 ||
    target.delimiter !== '.' || successor.delimiter !== '.' ||
    (target.eol !== '\n' && target.eol !== '\r\n') ||
    parent.eol !== target.eol || successor.eol !== target.eol ||
    parent.physicalEnd !== target.start || target.physicalEnd !== successor.start ||
    !authoredPlainTextMatches(parent.body, topology.parentText) ||
    !authoredPlainTextMatches(target.body, topology.targetText) ||
    !authoredPlainTextMatches(successor.body, topology.successorText)
  ) return null

  const targetBody = source.slice(target.bodyStart, target.contentEnd)
  const replacement = `${target.eol}${target.indent}${targetBody}${target.eol}${target.eol}${successor.indent}1.`
  return Object.freeze({
    markdown: source.slice(0, target.start) + replacement + source.slice(successor.tokenEnd),
    range: Object.freeze({ start: target.start, end: successor.tokenEnd, replacement }),
    parentRow: Object.freeze({ token: parent.token, body: parent.body, eol: parent.eol }),
    targetRow: Object.freeze({ indent: target.indent, token: target.token, body: target.body, eol: target.eol }),
    successorRow: Object.freeze({ indent: successor.indent, token: successor.token, body: successor.body, eol: successor.eol }),
    successorTokenReplacement: Object.freeze({ from: successor.token, to: '1.' })
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'list-nested-first-ordered-parent-joined',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_NESTED_FIRST_ORDERED_PARENT_JOIN_TRANSACTION_FAMILY,
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

export function createListNestedFirstOrderedParentJoinTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('nested first ordered parent join owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('nested first ordered parent join owner requires validateMarkdown')
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
    boundary = LIST_NESTED_FIRST_ORDERED_PARENT_JOIN_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('nested-first-ordered-parent-join-journal-stale', { reset: true })
    }
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('nested-first-ordered-parent-join-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('nested-first-ordered-parent-join-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('nested-first-ordered-parent-join-callback-document-mismatch', { deferred: true })
    }

    const topology = classifyTopology({ journal, expectedDoc })
    if (!topology.ok) return topology
    const journalProof = classifyJournal({ journal, expectedDoc, topology })
    if (!journalProof.ok) return journalProof
    const rows = resolveRows({ markdown: journal.source, doc: journal.oldDoc, topology, resolveMarkdownOffset })
    if (!rows) return recognizedRejection('nested-first-ordered-parent-join-range-unmapped')
    const patched = patchAuthoredJoin({ source: journal.source, rows, topology })
    if (!patched) return recognizedRejection('nested-first-ordered-parent-join-source-row-unproven')

    let valid = false
    try { valid = validateMarkdown({ markdown: patched.markdown, expectedDoc }) === true } catch { valid = false }
    if (!valid) return recognizedRejection('nested-first-ordered-parent-join-source-invalid')

    const proof = Object.freeze({
      kind: 'transaction-list-nested-first-ordered-parent-join-proof',
      journalId: journal.journalId,
      family: LIST_NESTED_FIRST_ORDERED_PARENT_JOIN_TRANSACTION_FAMILY,
      listType: 'ordered_list',
      topLevelIndex: topology.topLevelIndex,
      parentIndex: topology.parentIndex,
      targetIndex: 0,
      successorIndex: 1,
      parentPath: journalProof.parentPath,
      nestedPath: journalProof.nestedPath,
      targetItemPath: journalProof.targetItemPath,
      targetParagraphPath: journalProof.targetParagraphPath,
      successorItemPath: journalProof.successorItemPath,
      successorParagraphPath: journalProof.successorParagraphPath,
      movedParagraphPath: journalProof.movedParagraphPath,
      remainingNestedPath: journalProof.remainingNestedPath,
      firstStep: journalProof.firstStep,
      secondStep: journalProof.secondStep,
      stepDetails: journal.stepDetails,
      chainLength: journal.transactionCount,
      transactionJournal: verified.proof,
      parentSourceRow: patched.parentRow,
      targetSourceRow: patched.targetRow,
      successorSourceRow: patched.successorRow,
      successorTokenReplacement: patched.successorTokenReplacement,
      rawReplacement: patched.range,
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
    family: LIST_NESTED_FIRST_ORDERED_PARENT_JOIN_TRANSACTION_FAMILY,
    boundary: LIST_NESTED_FIRST_ORDERED_PARENT_JOIN_TRANSACTION_BOUNDARY,
    plan
  })
}
