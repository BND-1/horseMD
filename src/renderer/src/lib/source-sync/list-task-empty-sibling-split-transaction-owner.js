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

export const LIST_TASK_EMPTY_SIBLING_SPLIT_TRANSACTION_FAMILY = 'list-task-empty-sibling-split'
export const LIST_TASK_EMPTY_SIBLING_SPLIT_TRANSACTION_BOUNDARY = 'transaction-list-task-empty-sibling-split'

const ZERO_WIDTH_SENTINEL = '\u200B'
const rejected = (reason, { deferred = false, recognized = false, reset = false, proof = null } = {}) =>
  Object.freeze({ ok: false, decision: 'rejected', deferred, recognized, reset, reason, proof })
const recognizedRejection = (reason, options = {}) => rejected(reason, { ...options, recognized: true })

const plainParagraph = (node, { allowEmpty = false } = {}) => {
  if (node?.type?.name !== 'paragraph' || !node.isTextblock) return false
  if (!allowEmpty && node.content?.size <= 0) return false
  let plain = true
  node.forEach?.((child) => {
    if (!child?.isText || (child.marks?.length || 0) !== 0) plain = false
  })
  return plain
}
const taskItem = (node, { allowEmpty = false } = {}) => {
  if (
    node?.type?.name !== 'list_item' ||
    typeof node.attrs?.checked !== 'boolean' ||
    node.childCount !== 1 ||
    !plainParagraph(node.firstChild, { allowEmpty })
  ) return false
  const explicit = node.attrs?.listType
  return explicit == null || explicit === '' || explicit === 'bullet'
}
const plainBulletParent = (node) => {
  if (node?.type?.name !== 'list_item' || node.attrs?.checked != null || node.childCount !== 2) return false
  const explicit = node.attrs?.listType
  return (explicit == null || explicit === '' || explicit === 'bullet') && plainParagraph(node.firstChild)
}

const taskSplitMatch = ({ oldItem, leftItem, rightItem }) => {
  if (
    !taskItem(oldItem) || !taskItem(leftItem) || !taskItem(rightItem, { allowEmpty: true }) ||
    !sourceSyncAttrsEqual(oldItem.attrs, leftItem.attrs) ||
    !sourceSyncAttrsEqual(oldItem.attrs, rightItem.attrs) ||
    leftItem.firstChild?.eq?.(oldItem.firstChild) !== true ||
    rightItem.firstChild?.content?.size !== 0
  ) return false
  return true
}

const classify = ({ journal, expectedDoc }) => {
  if (!journal?.oldDoc || !expectedDoc || !Array.isArray(journal.entries)) {
    return rejected('task-empty-sibling-split-document-missing')
  }
  const before = topLevelSourceSyncEntries(journal.oldDoc)
  const after = topLevelSourceSyncEntries(expectedDoc)
  if (before.length !== after.length) return rejected('task-empty-sibling-split-top-level-count')
  const changed = before
    .map((entry, index) => entry.node?.eq?.(after[index]?.node) === true ? null : index)
    .filter((index) => index != null)
  if (changed.length !== 1) return rejected('task-empty-sibling-split-top-level-change-count')

  const topLevelIndex = changed[0]
  const oldList = before[topLevelIndex].node
  const newList = after[topLevelIndex].node
  if (
    oldList?.type?.name !== 'bullet_list' || newList?.type?.name !== 'bullet_list' ||
    !sourceSyncAttrsEqual(oldList.attrs, newList.attrs)
  ) return rejected('task-empty-sibling-split-list-shape')

  const candidates = []

  if (newList.childCount === oldList.childCount + 1) {
    for (let targetIndex = 0; targetIndex < oldList.childCount; targetIndex += 1) {
      const oldItem = oldList.child(targetIndex)
      const left = newList.child(targetIndex)
      const right = newList.child(targetIndex + 1)
      if (!taskSplitMatch({ oldItem, leftItem: left, rightItem: right })) continue
      let siblingsMatch = true
      for (let index = 0; index < oldList.childCount; index += 1) {
        if (index === targetIndex) continue
        const nextIndex = index > targetIndex ? index + 1 : index
        if (oldList.child(index)?.eq?.(newList.child(nextIndex)) !== true) {
          siblingsMatch = false
          break
        }
      }
      if (siblingsMatch) {
        candidates.push({
          scope: 'top-level',
          targetIndex,
          targetPath: [topLevelIndex, targetIndex],
          paragraphPath: [topLevelIndex, targetIndex, 0],
          oldItem,
          left,
          right,
          text: oldItem.firstChild.textContent
        })
      }
    }
  }

  if (newList.childCount === oldList.childCount) {
    for (let parentIndex = 0; parentIndex < oldList.childCount; parentIndex += 1) {
      const oldParent = oldList.child(parentIndex)
      const newParent = newList.child(parentIndex)
      if (
        !plainBulletParent(oldParent) || !plainBulletParent(newParent) ||
        !sourceSyncAttrsEqual(oldParent.attrs, newParent.attrs) ||
        newParent.firstChild?.eq?.(oldParent.firstChild) !== true
      ) continue
      const oldNested = oldParent.child(1)
      const newNested = newParent.child(1)
      if (
        oldNested?.type?.name !== 'bullet_list' || newNested?.type?.name !== 'bullet_list' ||
        !sourceSyncAttrsEqual(oldNested.attrs, newNested.attrs) ||
        newNested.childCount !== oldNested.childCount + 1
      ) continue
      for (let targetIndex = 0; targetIndex < oldNested.childCount; targetIndex += 1) {
        const oldItem = oldNested.child(targetIndex)
        const left = newNested.child(targetIndex)
        const right = newNested.child(targetIndex + 1)
        if (!taskSplitMatch({ oldItem, leftItem: left, rightItem: right })) continue
        let nestedMatch = true
        for (let index = 0; index < oldNested.childCount; index += 1) {
          if (index === targetIndex) continue
          const nextIndex = index > targetIndex ? index + 1 : index
          if (oldNested.child(index)?.eq?.(newNested.child(nextIndex)) !== true) {
            nestedMatch = false
            break
          }
        }
        if (!nestedMatch) continue
        let outerMatch = true
        for (let index = 0; index < oldList.childCount; index += 1) {
          if (index === parentIndex) continue
          if (oldList.child(index)?.eq?.(newList.child(index)) !== true) {
            outerMatch = false
            break
          }
        }
        if (outerMatch) {
          candidates.push({
            scope: 'nested',
            parentIndex,
            targetIndex,
            targetPath: [topLevelIndex, parentIndex, 1, targetIndex],
            paragraphPath: [topLevelIndex, parentIndex, 1, targetIndex, 0],
            oldItem,
            left,
            right,
            text: oldItem.firstChild.textContent
          })
        }
      }
    }
  }

  if (candidates.length !== 1) {
    return rejected('task-empty-sibling-split-target-count', {
      proof: { candidateCount: candidates.length }
    })
  }
  const match = candidates[0]

  if (journal.transactionCount !== 1 || journal.stepCount !== 1 || journal.entries.length !== 1) {
    return recognizedRejection('task-empty-sibling-split-transaction-count')
  }
  const entry = journal.entries[0]
  const step = entry.steps?.[0]
  const stepDoc = entry.stepDocs?.[0] || entry.beforeDoc
  if (
    !sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(stepDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(entry.afterDoc, expectedDoc)
  ) return recognizedRejection('task-empty-sibling-split-step-document')
  if (
    step?.constructor?.name !== 'ReplaceStep' || step.structure !== true ||
    !Number.isFinite(step.from) || step.from !== step.to ||
    Number(step.slice?.size || 0) !== 4 ||
    step.slice?.openStart !== 2 || step.slice?.openEnd !== 2
  ) return recognizedRejection('task-empty-sibling-split-step-shape')

  const paragraphEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, match.paragraphPath)
  const sliceContent = step.slice?.content
  const sliceLeft = sliceContent?.childCount === 2 ? sliceContent.child(0) : null
  const sliceRight = sliceContent?.childCount === 2 ? sliceContent.child(1) : null
  if (
    !paragraphEntry || paragraphEntry.type !== 'paragraph' ||
    sliceLeft?.type?.name !== 'list_item' || sliceRight?.type?.name !== 'list_item' ||
    sliceLeft.childCount !== 1 || sliceRight.childCount !== 1 ||
    !sourceSyncAttrsEqual(sliceLeft.attrs, match.oldItem.attrs) ||
    !sourceSyncAttrsEqual(sliceRight.attrs, match.oldItem.attrs) ||
    sliceLeft.firstChild?.type?.name !== 'paragraph' || sliceLeft.firstChild.content?.size !== 0 ||
    sliceRight.firstChild?.type?.name !== 'paragraph' || sliceRight.firstChild.content?.size !== 0
  ) return recognizedRejection('task-empty-sibling-split-step-slice')
  const expectedSplitPos = paragraphEntry.contentStart + match.text.length
  if (step.from !== expectedSplitPos) {
    return recognizedRejection('task-empty-sibling-split-step-range')
  }

  let applied
  try { applied = step.apply(stepDoc) } catch { applied = null }
  if (applied?.failed || !applied?.doc || !sameSourceSyncDocument(applied.doc, expectedDoc)) {
    return recognizedRejection('task-empty-sibling-split-step-result')
  }

  return Object.freeze({
    ok: true,
    recognized: true,
    scope: match.scope,
    topLevelIndex,
    parentIndex: match.parentIndex ?? null,
    targetIndex: match.targetIndex,
    targetPath: Object.freeze([...match.targetPath]),
    paragraphPath: Object.freeze([...match.paragraphPath]),
    leftPath: Object.freeze([...match.targetPath]),
    rightPath: Object.freeze([
      ...match.targetPath.slice(0, -1),
      match.targetIndex + 1
    ]),
    text: match.text,
    checked: match.oldItem.attrs.checked,
    attrs: Object.freeze({ ...match.oldItem.attrs }),
    step: Object.freeze({
      name: step.constructor.name,
      from: step.from,
      to: step.to,
      structure: true,
      sliceSize: Number(step.slice?.size || 0),
      openStart: step.slice?.openStart,
      openEnd: step.slice?.openEnd
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
  const contentEnd = line.start + bare.length
  const physicalEnd = line.end < source.length && source[line.end] === '\n' ? line.end + 1 : line.end
  return Object.freeze({
    indent: match[1],
    token: match[2],
    markerSpacing: match[3],
    state: match[4],
    taskSpacing: match[5],
    body: match[6],
    start: line.start,
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
      role: 'task-empty-sibling-split'
    })
  } catch {
    return null
  }
  if (!Number.isFinite(rawOffset)) return null
  return taskRow(markdown, lineAtRawOffset(markdown, rawOffset))
}

const patchAuthoredTaskSplit = ({ source, row, classification }) => {
  const expectedIndent = classification.scope === 'nested' ? '  ' : ''
  const stateMatches = classification.checked
    ? row.state === 'x' || row.state === 'X'
    : row.state === ' '
  if (
    row.indent !== expectedIndent ||
    row.markerSpacing !== ' ' || row.taskSpacing !== ' ' ||
    !stateMatches ||
    !authoredPlainTextMatches(row.body, classification.text) ||
    (row.eol !== '\n' && row.eol !== '\r\n')
  ) return null
  const insertion = `${row.indent}${row.token}${row.markerSpacing}[${row.state}]${row.taskSpacing}${ZERO_WIDTH_SENTINEL}${row.eol}`
  return Object.freeze({
    markdown: source.slice(0, row.physicalEnd) + insertion + source.slice(row.physicalEnd),
    insertionAt: row.physicalEnd,
    insertion,
    sourceRow: Object.freeze({
      indent: row.indent,
      token: row.token,
      markerSpacing: row.markerSpacing,
      state: row.state,
      taskSpacing: row.taskSpacing,
      body: row.body,
      eol: row.eol
    })
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'list-task-empty-sibling-split',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_TASK_EMPTY_SIBLING_SPLIT_TRANSACTION_FAMILY,
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

export function createListTaskEmptySiblingSplitTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('task empty sibling split owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('task empty sibling split owner requires validateMarkdown')
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
    boundary = LIST_TASK_EMPTY_SIBLING_SPLIT_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('task-empty-sibling-split-journal-stale', { reset: true })
    }
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('task-empty-sibling-split-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('task-empty-sibling-split-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('task-empty-sibling-split-callback-document-mismatch', { deferred: true })
    }

    const classification = classify({ journal, expectedDoc })
    if (!classification.ok) return classification
    const row = resolveTaskRow({
      markdown: journal.source,
      doc: journal.oldDoc,
      classification,
      resolveMarkdownOffset
    })
    if (!row) return recognizedRejection('task-empty-sibling-split-range-unmapped')
    const patched = patchAuthoredTaskSplit({ source: journal.source, row, classification })
    if (!patched) return recognizedRejection('task-empty-sibling-split-source-row-unproven')

    let valid = false
    try { valid = validateMarkdown({ markdown: patched.markdown, expectedDoc }) === true } catch { valid = false }
    if (!valid) return recognizedRejection('task-empty-sibling-split-source-invalid')

    const proof = Object.freeze({
      kind: 'transaction-list-task-empty-sibling-split-proof',
      journalId: journal.journalId,
      family: LIST_TASK_EMPTY_SIBLING_SPLIT_TRANSACTION_FAMILY,
      scope: classification.scope,
      topLevelIndex: classification.topLevelIndex,
      parentIndex: classification.parentIndex,
      targetIndex: classification.targetIndex,
      targetPath: classification.targetPath,
      paragraphPath: classification.paragraphPath,
      leftPath: classification.leftPath,
      rightPath: classification.rightPath,
      text: classification.text,
      checked: classification.checked,
      attrs: classification.attrs,
      step: classification.step,
      stepDetails: journal.stepDetails,
      chainLength: journal.transactionCount,
      transactionJournal: verified.proof,
      sourceRow: patched.sourceRow,
      rawInsertion: Object.freeze({ at: patched.insertionAt, text: patched.insertion }),
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
    family: LIST_TASK_EMPTY_SIBLING_SPLIT_TRANSACTION_FAMILY,
    boundary: LIST_TASK_EMPTY_SIBLING_SPLIT_TRANSACTION_BOUNDARY,
    plan
  })
}
