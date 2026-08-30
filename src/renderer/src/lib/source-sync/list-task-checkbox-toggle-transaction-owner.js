import { markdownLines } from '../markdown-preservation/core.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  onlySourceSyncNodePathChanged,
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const LIST_TASK_CHECKBOX_TOGGLE_TRANSACTION_FAMILY = 'list-task-checkbox-toggle'
export const LIST_TASK_CHECKBOX_TOGGLE_TRANSACTION_BOUNDARY = 'transaction-list-task-checkbox-toggle'

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

const sameMarks = (left, right) => {
  const a = left?.marks || []
  const b = right?.marks || []
  return a.length === b.length && a.every((mark, index) => mark?.eq?.(b[index]) === true)
}

const attrsWithoutChecked = (attrs) => Object.fromEntries(
  Object.entries(attrs || {})
    .filter(([key]) => key !== 'checked')
    .sort(([left], [right]) => left.localeCompare(right))
)
const nonCheckedAttrsEqual = (left, right) =>
  JSON.stringify(attrsWithoutChecked(left)) === JSON.stringify(attrsWithoutChecked(right))

const taskItemContract = (item) => Boolean(
  item?.type?.name === 'list_item' &&
  typeof item.attrs?.checked === 'boolean' &&
  item.childCount === 1 &&
  plainParagraph(item.firstChild)
)

const collectTaskToggleCandidates = ({ beforeNode, afterNode, path = [], candidates }) => {
  if (
    !beforeNode || !afterNode ||
    beforeNode.type?.name !== afterNode.type?.name ||
    beforeNode.childCount !== afterNode.childCount
  ) return
  if (
    beforeNode.type?.name === 'list_item' &&
    taskItemContract(beforeNode) && taskItemContract(afterNode) &&
    beforeNode.attrs.checked !== afterNode.attrs.checked &&
    nonCheckedAttrsEqual(beforeNode.attrs, afterNode.attrs) &&
    beforeNode.content?.eq?.(afterNode.content) === true &&
    sameMarks(beforeNode, afterNode)
  ) candidates.push(Object.freeze([...path]))
  for (let index = 0; index < beforeNode.childCount; index += 1) {
    collectTaskToggleCandidates({
      beforeNode: beforeNode.child(index),
      afterNode: afterNode.child(index),
      path: [...path, index],
      candidates
    })
  }
}

const classifyTaskCheckboxToggle = ({ journal, expectedDoc }) => {
  if (!journal?.oldDoc || !expectedDoc) return rejected('list-task-checkbox-toggle-document-missing')
  const candidates = []
  collectTaskToggleCandidates({ beforeNode: journal.oldDoc, afterNode: expectedDoc, candidates })
  if (candidates.length !== 1) {
    return rejected('list-task-checkbox-toggle-target-count', {
      proof: { candidateCount: candidates.length, candidatePaths: candidates }
    })
  }

  const itemPath = candidates[0]
  if (!onlySourceSyncNodePathChanged(journal.oldDoc, expectedDoc, itemPath)) {
    return rejected('list-task-checkbox-toggle-extra-change', { proof: { itemPath } })
  }
  const previousEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, itemPath)
  const nextEntry = sourceSyncNodeEntryAtPath(expectedDoc, itemPath)
  const previousItem = previousEntry?.node
  const nextItem = nextEntry?.node
  if (!taskItemContract(previousItem) || !taskItemContract(nextItem)) {
    return rejected('list-task-checkbox-toggle-item-contract')
  }

  const listPath = itemPath.slice(0, -1)
  const previousListEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, listPath)
  const nextListEntry = sourceSyncNodeEntryAtPath(expectedDoc, listPath)
  if (
    previousListEntry?.type !== 'bullet_list' || nextListEntry?.type !== 'bullet_list' ||
    !sourceSyncAttrsEqual(previousListEntry.node.attrs, nextListEntry.node.attrs)
  ) return rejected('list-task-checkbox-toggle-parent-list')

  let scope = null
  if (itemPath.length === 2) {
    scope = 'top-level'
  } else if (itemPath.length === 4 && itemPath[2] === 1) {
    const parentPath = itemPath.slice(0, 2)
    const previousParent = sourceSyncNodeEntryAtPath(journal.oldDoc, parentPath)?.node
    const nextParent = sourceSyncNodeEntryAtPath(expectedDoc, parentPath)?.node
    if (
      previousParent?.type?.name !== 'list_item' || nextParent?.type?.name !== 'list_item' ||
      previousParent.attrs?.checked != null || nextParent.attrs?.checked != null ||
      previousParent.childCount !== 2 || nextParent.childCount !== 2 ||
      !plainParagraph(previousParent.firstChild) || nextParent.firstChild?.eq?.(previousParent.firstChild) !== true ||
      previousParent.child(1)?.type?.name !== 'bullet_list' || nextParent.child(1)?.type?.name !== 'bullet_list' ||
      !sourceSyncAttrsEqual(previousParent.attrs, nextParent.attrs) ||
      !sourceSyncAttrsEqual(previousParent.child(1).attrs, nextParent.child(1).attrs)
    ) return rejected('list-task-checkbox-toggle-nested-parent-contract')
    scope = 'nested'
  } else {
    return rejected('list-task-checkbox-toggle-path-scope', { proof: { itemPath } })
  }

  if (journal.transactionCount !== 1 || journal.stepCount !== 1 || journal.entries?.length !== 1) {
    return recognizedRejection('list-task-checkbox-toggle-transaction-count')
  }
  const entry = journal.entries[0]
  const step = entry.steps?.[0]
  const stepDoc = entry.stepDocs?.[0] || entry.beforeDoc
  if (
    !sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(stepDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(entry.afterDoc, expectedDoc)
  ) return recognizedRejection('list-task-checkbox-toggle-step-document')
  if (
    step?.constructor?.name !== 'AttrStep' ||
    step.attr !== 'checked' ||
    typeof step.value !== 'boolean' ||
    !Number.isFinite(step.pos)
  ) return recognizedRejection('list-task-checkbox-toggle-step-shape')
  if (
    step.pos !== previousEntry.beforePos ||
    step.value !== nextItem.attrs.checked
  ) return recognizedRejection('list-task-checkbox-toggle-step-target')

  const stepItem = sourceSyncNodeEntryAtPath(stepDoc, itemPath)?.node
  if (
    !taskItemContract(stepItem) ||
    stepItem.attrs.checked !== previousItem.attrs.checked ||
    !nonCheckedAttrsEqual(stepItem.attrs, previousItem.attrs) ||
    stepItem.content?.eq?.(previousItem.content) !== true
  ) return recognizedRejection('list-task-checkbox-toggle-step-baseline')

  let applied
  try { applied = step.apply(stepDoc) } catch { applied = null }
  if (applied?.failed || !applied?.doc) return recognizedRejection('list-task-checkbox-toggle-step-apply')
  if (!onlySourceSyncNodePathChanged(stepDoc, applied.doc, itemPath)) {
    return recognizedRejection('list-task-checkbox-toggle-neighbour-change')
  }
  const resultItem = sourceSyncNodeEntryAtPath(applied.doc, itemPath)?.node
  if (
    !taskItemContract(resultItem) ||
    resultItem.attrs.checked !== nextItem.attrs.checked ||
    !nonCheckedAttrsEqual(resultItem.attrs, previousItem.attrs) ||
    resultItem.content?.eq?.(previousItem.content) !== true ||
    !sameSourceSyncDocument(applied.doc, expectedDoc)
  ) return recognizedRejection('list-task-checkbox-toggle-step-result')

  return Object.freeze({
    ok: true,
    recognized: true,
    scope,
    topLevelIndex: itemPath[0],
    itemPath: Object.freeze([...itemPath]),
    paragraphPath: Object.freeze([...itemPath, 0]),
    previousChecked: previousItem.attrs.checked,
    nextChecked: nextItem.attrs.checked,
    text: previousItem.firstChild.textContent,
    step: Object.freeze({
      name: 'AttrStep',
      pos: step.pos,
      attr: step.attr,
      value: step.value
    })
  })
}

const lineAtRawOffset = (markdown, rawOffset) => markdownLines(markdown)
  .find((line) => rawOffset >= line.start && rawOffset <= line.end) || null

const taskRow = (source, line) => {
  if (!line) return null
  const bare = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
  const match = bare.match(/^([ \t]*)([-+*])([ \t]+)\[([ xX])\]([ \t]+)(.*)$/)
  if (!match) return null
  const stateAt = line.start + match[1].length + 1 + match[3].length + 1
  const contentEnd = line.start + bare.length
  const physicalEnd = line.end < source.length && source[line.end] === '\n' ? line.end + 1 : line.end
  return Object.freeze({
    indent: match[1],
    token: match[2],
    markerSpacing: match[3],
    state: match[4],
    taskSpacing: match[5],
    body: match[6],
    stateAt,
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
    } else {
      return false
    }
  }
  return rawIndex === source.length
}

const resolveTaskRow = ({ markdown, doc, classification, resolveMarkdownOffset }) => {
  const paragraph = sourceSyncNodeEntryAtPath(doc, classification.paragraphPath)
  if (!paragraph) return null
  let rawOffset
  try {
    rawOffset = resolveMarkdownOffset({
      markdown,
      pmPos: paragraph.contentStart,
      doc,
      topLevelIndex: classification.topLevelIndex,
      role: 'task-checkbox-toggle'
    })
  } catch {
    return null
  }
  if (!Number.isFinite(rawOffset)) return null
  return taskRow(markdown, lineAtRawOffset(markdown, rawOffset))
}

const patchTaskCheckbox = ({ source, row, classification }) => {
  const expectedIndent = classification.scope === 'nested' ? '  ' : ''
  const previousStateMatches = classification.previousChecked
    ? row.state === 'x' || row.state === 'X'
    : row.state === ' '
  if (
    row.indent !== expectedIndent ||
    !previousStateMatches ||
    !authoredPlainTextMatches(row.body, classification.text)
  ) return null
  const nextState = classification.nextChecked ? 'x' : ' '
  return Object.freeze({
    markdown: source.slice(0, row.stateAt) + nextState + source.slice(row.stateAt + 1),
    row: Object.freeze({
      indent: row.indent,
      token: row.token,
      markerSpacing: row.markerSpacing,
      previousState: row.state,
      nextState,
      taskSpacing: row.taskSpacing,
      body: row.body,
      eol: row.eol
    }),
    rawPatch: Object.freeze({ at: row.stateAt, from: row.state, to: nextState })
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'list-task-checkbox-toggled',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_TASK_CHECKBOX_TOGGLE_TRANSACTION_FAMILY,
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

export function createListTaskCheckboxToggleTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('task checkbox toggle owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('task checkbox toggle owner requires validateMarkdown')
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
    boundary = LIST_TASK_CHECKBOX_TOGGLE_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('list-task-checkbox-toggle-journal-stale', { reset: true })
    }
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('list-task-checkbox-toggle-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('list-task-checkbox-toggle-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('list-task-checkbox-toggle-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyTaskCheckboxToggle({ journal, expectedDoc })
    if (!classification.ok) return classification
    const row = resolveTaskRow({
      markdown: journal.source,
      doc: journal.oldDoc,
      classification,
      resolveMarkdownOffset
    })
    if (!row) return recognizedRejection('list-task-checkbox-toggle-range-unmapped')
    const patched = patchTaskCheckbox({ source: journal.source, row, classification })
    if (!patched) return recognizedRejection('list-task-checkbox-toggle-source-row-unproven')

    let valid = false
    try { valid = validateMarkdown({ markdown: patched.markdown, expectedDoc }) === true } catch { valid = false }
    if (!valid) return recognizedRejection('list-task-checkbox-toggle-source-invalid')

    const proof = Object.freeze({
      kind: 'transaction-list-task-checkbox-toggle-proof',
      journalId: journal.journalId,
      family: LIST_TASK_CHECKBOX_TOGGLE_TRANSACTION_FAMILY,
      scope: classification.scope,
      topLevelIndex: classification.topLevelIndex,
      itemPath: classification.itemPath,
      paragraphPath: classification.paragraphPath,
      previousChecked: classification.previousChecked,
      nextChecked: classification.nextChecked,
      text: classification.text,
      step: classification.step,
      stepDetails: journal.stepDetails,
      chainLength: journal.transactionCount,
      transactionJournal: verified.proof,
      sourceRow: patched.row,
      rawPatch: patched.rawPatch,
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
    family: LIST_TASK_CHECKBOX_TOGGLE_TRANSACTION_FAMILY,
    boundary: LIST_TASK_CHECKBOX_TOGGLE_TRANSACTION_BOUNDARY,
    plan
  })
}
