import { mapPlainTextTransactionsToSource } from '../source-transaction-sync.js'
import { mapTableCellEmptyTransition, mapTableCellBySlot, mapTableCellsBySlot } from './table-cell-empty-transition.js'
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

export const TABLE_CELL_TRANSACTION_FAMILY = 'table-cell-plain-text-replace'
export const TABLE_CELL_TRANSACTION_BOUNDARY = 'transaction-table-cell-text'

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

const nodeAtPath = (doc, path) => {
  let node = doc
  for (const index of path || []) {
    if (!Number.isInteger(index) || index < 0 || index >= node?.childCount) return null
    node = node.child(index)
  }
  return node
}

const isTableCellType = (name) => name === 'table_cell' || name === 'table_header'

// In-cell line breaks (Enter in a cell → `hardbreak`, serialized as `<br>`)
// are part of the plain cell contract since 0.13.235; the plain-text step
// mapper still refuses them and the structural slot mapper spells them.
const isCellLineBreak = (node) =>
  (node?.type?.name === 'hardbreak' || node?.type?.name === 'hard_break') &&
  (node.marks?.length || 0) === 0

const isSimpleParagraph = (node) => {
  if (
    node?.type?.name !== 'paragraph' ||
    !node.isTextblock
  ) return false
  let simple = true
  node.forEach?.((child) => {
    if (isCellLineBreak(child)) return
    if (!child?.isText || (child.marks?.length || 0) > 0) simple = false
  })
  return simple
}

const isClosedPlainTextSlice = (slice) => {
  if (!slice || slice.size === 0 || slice.content?.size === 0) return true
  if (slice.openStart || slice.openEnd) return false
  let plain = true
  slice.content.forEach?.((node) => {
    if (isCellLineBreak(node)) return
    if (!node?.isText || (node.marks?.length || 0) > 0) plain = false
  })
  return plain
}

const classifyAnchoredCell = ({ oldDoc, newDoc }) => {
  const attempts = ['table_cell', 'table_header'].map((expectedType) =>
    classifySingleAnchoredSubtreeChange({
      oldDoc,
      newDoc,
      expectedType,
      reasonPrefix: 'table-cell'
    })
  )
  const owned = attempts.filter((attempt) => attempt.ok)
  if (owned.length === 1) return owned[0]
  return rejected('table-cell-anchored-target-count', {
    proof: {
      candidateCount: owned.length,
      attempts: attempts.map((attempt) => ({
        ok: attempt.ok === true,
        reason: attempt.reason || null,
        proof: attempt.proof || null
      }))
    }
  })
}

const classifyTableCellJournal = ({ journal, expectedDoc }) => {
  const classification = classifyAnchoredCell({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc
  })
  if (!classification.ok) return classification

  const cellPath = classification.nodePath
  const rowPath = cellPath.slice(0, -1)
  const tablePath = cellPath.slice(0, -2)
  const previousCell = classification.previousEntry.node
  const nextCell = classification.nextEntry.node
  const previousRow = nodeAtPath(journal.oldDoc, rowPath)
  const nextRow = nodeAtPath(expectedDoc, rowPath)
  const previousTable = nodeAtPath(journal.oldDoc, tablePath)
  const nextTable = nodeAtPath(expectedDoc, tablePath)
  if (
    cellPath.length < 3 ||
    !['table_row', 'table_header_row'].includes(previousRow?.type?.name) ||
    previousRow.type.name !== nextRow?.type?.name ||
    previousTable?.type?.name !== 'table' ||
    nextTable?.type?.name !== 'table'
  ) return rejected('table-cell-path-not-table')
  if (
    !isTableCellType(previousCell.type?.name) ||
    previousCell.type?.name !== nextCell.type?.name ||
    !sourceSyncAttrsEqual(previousTable.attrs, nextTable.attrs) ||
    !sourceSyncAttrsEqual(previousRow.attrs, nextRow.attrs) ||
    !sourceSyncAttrsEqual(previousCell.attrs, nextCell.attrs)
  ) return rejected('table-cell-attrs-or-type-changed')
  if (previousCell.childCount !== 1 || nextCell.childCount !== 1) {
    return rejected('table-cell-paragraph-count')
  }
  const previousParagraph = previousCell.child(0)
  const nextParagraph = nextCell.child(0)
  if (
    !isSimpleParagraph(previousParagraph) ||
    !isSimpleParagraph(nextParagraph)
  ) return rejected('table-cell-not-simple-nonempty')
  if (!sourceSyncAttrsEqual(previousParagraph.attrs, nextParagraph.attrs)) {
    return rejected('table-cell-paragraph-attrs-changed')
  }
  if (previousParagraph.textContent === nextParagraph.textContent) {
    return rejected('table-cell-text-unchanged')
  }

  let hasEmptyParagraph = previousParagraph.content.size === 0 || nextParagraph.content.size === 0
  let currentDoc = journal.oldDoc
  for (const entry of journal.entries || []) {
    if (!sameSourceSyncDocument(entry.beforeDoc, currentDoc)) {
      return rejected('table-cell-transaction-chain-mismatch')
    }
    if (!entry.steps?.length) return rejected('table-cell-step-count')
    let entryDoc = entry.beforeDoc
    for (let index = 0; index < entry.steps.length; index += 1) {
      const step = entry.steps[index]
      if (step?.constructor?.name !== 'ReplaceStep') {
        return rejected('table-cell-step-not-replace')
      }
      if (!Number.isFinite(step.from) || !Number.isFinite(step.to)) {
        return rejected('table-cell-step-range-invalid')
      }
      if (step.structure === true) return rejected('table-cell-structural-step')
      if (!isClosedPlainTextSlice(step.slice)) {
        return rejected('table-cell-structural-slice')
      }

      const stepDoc = entry.stepDocs?.[index] || (index === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
        return rejected('table-cell-step-document-missing')
      }
      let $from
      let $to
      try {
        $from = stepDoc.resolve(step.from)
        $to = stepDoc.resolve(step.to)
      } catch {
        return rejected('table-cell-step-range-unresolvable')
      }
      if (!$from?.sameParent?.($to)) return rejected('table-cell-cross-parent-range')
      const beforeEntry = sourceSyncNodeEntryAtPath(stepDoc, cellPath)
      const cellDepth = cellPath.length
      if (
        !beforeEntry ||
        !isTableCellType(beforeEntry.type) ||
        $from.depth !== cellDepth + 1 ||
        $from.parent?.type?.name !== 'paragraph' ||
        $from.node(cellDepth)?.type?.name !== beforeEntry.type ||
        $from.before(cellDepth) !== beforeEntry.offset ||
        !sourceSyncResolvedPositionMatchesPath($from, cellPath) ||
        !sourceSyncResolvedPositionMatchesPath($to, cellPath) ||
        $from.index(cellDepth) !== 0 ||
        $to.index(cellDepth) !== 0
      ) return rejected('table-cell-step-outside-owned-cell')
      const beforeCell = beforeEntry.node
      const beforeParagraph = beforeCell.childCount === 1 ? beforeCell.child(0) : null
      if (
        beforeCell.type?.name !== previousCell.type?.name ||
        !sourceSyncAttrsEqual(beforeCell.attrs, previousCell.attrs) ||
        !isSimpleParagraph(beforeParagraph) ||
        !sourceSyncAttrsEqual(beforeParagraph.attrs, previousParagraph.attrs)
      ) return rejected('table-cell-step-baseline-mismatch')

      let applied
      try {
        applied = step.apply(stepDoc)
      } catch {
        return rejected('table-cell-step-apply-failed')
      }
      if (applied?.failed || !applied?.doc) {
        return rejected('table-cell-step-apply-failed')
      }
      if (!onlySourceSyncNodePathChanged(stepDoc, applied.doc, cellPath)) {
        return rejected('table-cell-neighbour-or-topology-changed')
      }
      const afterCell = sourceSyncNodeEntryAtPath(applied.doc, cellPath)?.node
      const afterParagraph = afterCell?.childCount === 1 ? afterCell.child(0) : null
      if (
        afterCell?.type?.name !== previousCell.type?.name ||
        !sourceSyncAttrsEqual(afterCell.attrs, previousCell.attrs) ||
        !isSimpleParagraph(afterParagraph) ||
        !sourceSyncAttrsEqual(afterParagraph.attrs, previousParagraph.attrs) ||
        beforeParagraph.eq?.(afterParagraph) === true
      ) return rejected('table-cell-result-not-simple-nonempty')
      hasEmptyParagraph ||= beforeParagraph.content.size === 0 || afterParagraph.content.size === 0
      entryDoc = applied.doc
    }
    if (!sameSourceSyncDocument(entryDoc, entry.afterDoc)) {
      return rejected('table-cell-transaction-result-mismatch')
    }
    currentDoc = entry.afterDoc
  }
  if (!sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return rejected('table-cell-final-document-mismatch')
  }

  return Object.freeze({
    ...classification,
    cellPath,
    rowPath,
    tablePath,
    rowIndex: cellPath.at(-2),
    cellIndex: cellPath.at(-1),
    columnCount: previousRow.childCount,
    hasEmptyParagraph,
    previousCell,
    nextCell,
    previousParagraph,
    nextParagraph
  })
}

// Several cells of ONE top-level table changed text within one journal
// (type, Tab, type before a publication point). Proves: exactly one top-level
// block differs and it is a table on both sides; table/row/cell types, attrs
// and grid shape are identical; every changed cell is one plain paragraph
// (text + in-cell line breaks) on both sides; every journal step is a
// non-structural ReplaceStep with a closed text/break slice.
const classifyMultiCellJournal = ({ journal, expectedDoc }) => {
  const oldDoc = journal?.oldDoc
  if (!oldDoc || !expectedDoc || oldDoc.childCount !== expectedDoc.childCount) {
    return rejected('table-cells-top-level-count')
  }
  let topLevelIndex = -1
  for (let index = 0; index < oldDoc.childCount; index++) {
    if (oldDoc.child(index).eq(expectedDoc.child(index))) continue
    if (topLevelIndex >= 0) return rejected('table-cells-top-level-change-count')
    topLevelIndex = index
  }
  if (topLevelIndex < 0) return rejected('table-cells-no-change')
  const oldTable = oldDoc.child(topLevelIndex)
  const newTable = expectedDoc.child(topLevelIndex)
  if (oldTable.type.name !== 'table' || newTable.type.name !== 'table') return rejected('table-cells-not-table')
  if (!sourceSyncAttrsEqual(oldTable.attrs, newTable.attrs) || oldTable.childCount !== newTable.childCount) {
    return rejected('table-cells-table-shape')
  }
  const changedCells = []
  let padded = false
  // prosemirror-tables' fixTables pads a short authored row with empty cells
  // in the same batch as the first edit inside that table (fuzz seeds 34/35:
  // irregular table left by a source edit). Such trailing empty cells have no
  // source bytes — the authored row stays short — so they are not changes.
  const isEmptyPaddingCell = (cell) =>
    cell.childCount === 1 && cell.child(0).type.name === 'paragraph' && cell.child(0).content.size === 0
  for (let rowIndex = 0; rowIndex < oldTable.childCount; rowIndex++) {
    const oldRow = oldTable.child(rowIndex)
    const newRow = newTable.child(rowIndex)
    if (
      oldRow.type.name !== newRow.type.name ||
      !sourceSyncAttrsEqual(oldRow.attrs, newRow.attrs) ||
      oldRow.childCount > newRow.childCount
    ) return rejected('table-cells-row-shape')
    for (let cellIndex = oldRow.childCount; cellIndex < newRow.childCount; cellIndex++) {
      if (!isEmptyPaddingCell(newRow.child(cellIndex))) return rejected('table-cells-row-shape')
      padded = true
    }
    for (let cellIndex = 0; cellIndex < oldRow.childCount; cellIndex++) {
      const oldCell = oldRow.child(cellIndex)
      const newCell = newRow.child(cellIndex)
      if (oldCell.eq(newCell)) continue
      if (
        oldCell.type.name !== newCell.type.name ||
        !sourceSyncAttrsEqual(oldCell.attrs, newCell.attrs) ||
        oldCell.childCount !== 1 || newCell.childCount !== 1 ||
        !isSimpleParagraph(oldCell.child(0)) || !isSimpleParagraph(newCell.child(0)) ||
        !sourceSyncAttrsEqual(oldCell.child(0).attrs, newCell.child(0).attrs)
      ) return rejected('table-cells-cell-not-plain')
      changedCells.push(Object.freeze({ rowIndex, cellIndex }))
    }
  }
  if (changedCells.length < (padded ? 1 : 2)) return rejected('table-cells-change-count')
  const isPaddingSlice = (slice) => {
    if (!padded || !slice?.content?.childCount || slice.openStart || slice.openEnd) return false
    let only = true
    slice.content.forEach((node) => {
      if (!/^table_(cell|header)$/.test(node.type?.name || '') || !isEmptyPaddingCell(node)) only = false
    })
    return only
  }
  // fixTables follows the insertion with a setNodeMarkup (ReplaceAroundStep)
  // on the new cell; accept it only when it re-marks an empty padding cell.
  const isPaddingMarkup = (step, stepDoc) => {
    if (!padded || step?.constructor?.name !== 'ReplaceAroundStep' || !stepDoc) return false
    if (step.insert !== 1 || step.gapFrom !== step.from + 1 || step.gapTo !== step.to - 1) return false
    const node = stepDoc.nodeAt(step.from)
    return Boolean(node && node.nodeSize === step.to - step.from &&
      /^table_(cell|header)$/.test(node.type.name) && isEmptyPaddingCell(node))
  }
  for (const entry of journal.entries || []) {
    for (const [index, step] of (entry.steps || []).entries()) {
      const stepDoc = entry.stepDocs?.[index] || (index === 0 ? entry.beforeDoc : null)
      if (isPaddingMarkup(step, stepDoc)) continue
      if (step?.constructor?.name !== 'ReplaceStep') return rejected('table-cells-step-contract')
      if (isPaddingSlice(step.slice) && step.from === step.to) continue
      if (step.structure === true || !isClosedPlainTextSlice(step.slice)) {
        return rejected('table-cells-step-contract')
      }
    }
  }
  return Object.freeze({ ok: true, topLevelIndex, oldTable, newTable, changedCells: Object.freeze(changedCells) })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'table-cell-plain-text-change',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: TABLE_CELL_TRANSACTION_FAMILY,
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

export function createTableCellTransactionSourceSyncOwner({
  mapTransactions = mapPlainTextTransactionsToSource,
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof mapTransactions !== 'function') {
    throw new TypeError('table cell owner requires mapTransactions')
  }
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('table cell owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('table cell owner requires validateMarkdown')
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
    boundary = TABLE_CELL_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('table-cell-journal-stale', { reset: true })
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
    ) return rejected('table-cell-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('table-cell-live-snapshot-stale', { reset: true })
    }

    const classification = classifyTableCellJournal({ journal, expectedDoc })
    if (!classification.ok) {
      if (!/anchored-target-count$/.test(classification.reason || '')) return classification
      const multi = classifyMultiCellJournal({ journal, expectedDoc })
      if (!multi.ok) return rejected(classification.reason, { proof: Object.freeze({ multiCellReason: multi.reason }) })
      let mappedMulti = null
      try {
        mappedMulti = mapTableCellsBySlot({
          source: journal.source,
          oldTable: multi.oldTable,
          newTable: multi.newTable,
          changedCells: multi.changedCells,
          expectedDoc,
          validateMarkdown
        })
      } catch {
        mappedMulti = null
      }
      if (!mappedMulti?.ok) return rejected(mappedMulti?.reason || 'table-cells-mapper-rejected')
      const multiProof = Object.freeze({
        kind: 'transaction-table-cell-proof',
        journalId: journal.journalId,
        family: TABLE_CELL_TRANSACTION_FAMILY,
        topLevelIndex: multi.topLevelIndex,
        changedCells: multi.changedCells,
        chainLength: journal.transactionCount,
        stepDetails: journal.stepDetails,
        transactionJournal: verified.proof,
        sourceDigest: sourceSyncDigest(journal.source),
        previousCanonicalDigest: sourceSyncDigest(journal.canonical),
        canonicalDigest: sourceSyncDigest(canonical),
        markdownDigest: sourceSyncDigest(mappedMulti.markdown),
        mapperReason: mappedMulti.reason,
        callbackDocumentEquivalent: callbackDocumentEquivalent === true,
        snapshotMatched: true,
        documentMatched: true
      })
      return createOwnedPlan({ boundary, markdown: mappedMulti.markdown, canonical, expectedDoc, proof: multiProof })
    }
    const transactions = transactionsFromSourceSyncTransactionJournal(journal)
    if (!transactions.length) return rejected('table-cell-step-count')

    let mapped
    try {
      mapped = classification.hasEmptyParagraph
        ? mapTableCellEmptyTransition({ journal, classification, expectedDoc, resolveMarkdownOffset, validateMarkdown })
        : mapTransactions({
        source: journal.source,
        transactions,
        oldState: { doc: journal.oldDoc },
        newState: { doc: expectedDoc },
        blockHints: [],
        mapPosition: (markdown, pmPos, doc) => resolveMarkdownOffset({
          markdown,
          pmPos,
          doc,
          topLevelIndex: classification.topLevelIndex,
          rowIndex: classification.rowIndex,
          cellIndex: classification.cellIndex,
          nodePath: classification.cellPath
        }),
        validateMarkdown: (markdown, mappedExpectedDoc) => validateMarkdown({
          markdown,
          expectedDoc: mappedExpectedDoc
        })
      })
    } catch (error) {
      return rejected(`table-cell-mapper-threw:${error?.name || 'Error'}`)
    }
    if (!mapped?.ok || typeof mapped.markdown !== 'string') {
      // Position-mapped anchoring failed (e.g. raw-block-text-mismatch in a
      // CJK table). Fall back to locating the cell's raw slot structurally.
      let slotted = null
      try {
        slotted = mapTableCellBySlot({
          journal,
          classification,
          expectedDoc,
          resolveMarkdownOffset,
          validateMarkdown,
          tableNode: sourceSyncNodeEntryAtPath(journal.oldDoc, classification.tablePath)?.node
        })
      } catch {
        slotted = null
      }
      if (!slotted?.ok) {
        return rejected(mapped?.reason || 'table-cell-mapper-rejected', {
          proof: slotted ? Object.freeze({ slotReason: slotted.reason }) : null
        })
      }
      mapped = slotted
    }

    const proof = Object.freeze({
      kind: 'transaction-table-cell-proof',
      journalId: journal.journalId,
      family: TABLE_CELL_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      nodePath: classification.cellPath,
      tablePath: classification.tablePath,
      rowPath: classification.rowPath,
      rowIndex: classification.rowIndex,
      cellIndex: classification.cellIndex,
      cellType: classification.previousCell.type?.name || null,
      previousText: classification.previousParagraph.textContent,
      nextText: classification.nextParagraph.textContent,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(mapped.markdown),
      mapperReason: mapped.reason || null,
      sourceRange: mapped.sourceRange || null,
      callbackDocumentEquivalent: callbackDocumentEquivalent === true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({
      boundary,
      markdown: mapped.markdown,
      canonical,
      expectedDoc,
      proof
    })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: TABLE_CELL_TRANSACTION_FAMILY,
    boundary: TABLE_CELL_TRANSACTION_BOUNDARY,
    plan
  })
}
