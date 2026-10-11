import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const TOP_LEVEL_BLOCK_REMOVAL_TRANSACTION_FAMILY = 'top-level-block-removal'
export const TOP_LEVEL_BLOCK_REMOVAL_TRANSACTION_BOUNDARY = 'transaction-top-level-block-removal'

/**
 * Whole top-level blocks removed (fuzz seed 36, 2026-10-06).
 *
 * Selecting a horizontal rule (ArrowDown onto it) and pressing Backspace, or
 * typing over it, removes the `hr` node; typing also prepends the text to the
 * following paragraph. The canonical serializer spells `---` as `***`, so the
 * legacy canonical diff could not anchor the change and produced candidates
 * that ate the table/paragraph separator — fail-closed, but every such edit
 * paused sync.
 *
 * This owner proves the change on the PM documents instead: the journal's new
 * document equals the old one with a contiguous run of top-level blocks
 * removed, optionally followed by an edit of ONE adjacent kept textblock. The
 * removed blocks' exact source bytes are located with remark positions (block
 * count and types must align with the PM document) and spliced out; a
 * remaining text edit is delegated to the paragraph-level preservation diff on
 * that intermediate (source, canonical) pair. The result is validated against
 * the live document like every other owner.
 */
const rejected = (reason, { reset = false, proof = null } = {}) => Object.freeze({
  ok: false,
  decision: 'rejected',
  owner: null,
  family: TOP_LEVEL_BLOCK_REMOVAL_TRANSACTION_FAMILY,
  deferred: false,
  reset,
  reason,
  proof
})

const MDAST_TO_PM = Object.freeze({
  paragraph: ['paragraph'],
  heading: ['heading'],
  thematicBreak: ['hr'],
  code: ['code_block'],
  blockquote: ['blockquote'],
  list: ['bullet_list', 'ordered_list', 'list'],
  table: ['table'],
  html: ['html'],
  math: ['math_block'],
  yaml: ['frontmatter']
})

const childrenOf = (doc) => {
  const children = []
  doc?.forEach?.((node) => children.push(node))
  return children
}

// Leaf blocks with no text content: removing them cannot carry authored
// inline spelling into a neighbour (paragraph joins stay with their owners).
const isRemovableLeafBlock = (node) =>
  Boolean(node && node.isBlock && !node.isTextblock && node.childCount === 0)

export function alignTopLevelSourceBlocks({ source, doc, parseMarkdownTree }) {
  const bom = source.startsWith('﻿') ? 1 : 0
  let tree
  try {
    tree = parseMarkdownTree(bom ? source.slice(1) : source)
  } catch {
    return null
  }
  const blocks = (tree?.children || []).filter((node) => node.type !== 'definition')
  const children = childrenOf(doc)
  let count = children.length
  // Milkdown's trailing plugin keeps an empty paragraph after a final
  // table/list/code/quote; it has no source bytes.
  if (
    count === blocks.length + 1 &&
    children[count - 1]?.type?.name === 'paragraph' &&
    children[count - 1].content.size === 0
  ) count -= 1
  if (count !== blocks.length) return null
  const ranges = []
  for (let index = 0; index < count; index += 1) {
    const block = blocks[index]
    const start = block?.position?.start?.offset
    const end = block?.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null
    const pmTypes = MDAST_TO_PM[block.type]
    if (pmTypes && !pmTypes.includes(children[index].type.name)) return null
    ranges.push(Object.freeze({ start: start + bom, end: end + bom, type: block.type }))
  }
  return ranges
}

export function classifyTopLevelBlockRemoval(oldDoc, newDoc) {
  const before = childrenOf(oldDoc)
  const after = childrenOf(newDoc)
  if (after.length >= before.length) return null
  let prefix = 0
  while (prefix < after.length && before[prefix].eq(after[prefix])) prefix += 1
  let suffix = 0
  while (
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix].eq(after[after.length - 1 - suffix])
  ) suffix += 1
  const oldRegion = before.slice(prefix, before.length - suffix)
  const newRegion = after.slice(prefix, after.length - suffix)
  if (!oldRegion.length || newRegion.length > 1) return null
  if (!newRegion.length) {
    return Object.freeze({ removedFrom: prefix, removedTo: prefix + oldRegion.length, edited: null })
  }
  // One kept textblock of the same type, at either end of the old region; the
  // rest of the region must be removable leaf blocks.
  const replacement = newRegion[0]
  const candidates = [oldRegion.length - 1, 0]
  for (const keptOffset of candidates) {
    const kept = oldRegion[keptOffset]
    if (!kept?.isTextblock || kept.type !== replacement.type) continue
    const removed = oldRegion.filter((_, index) => index !== keptOffset)
    if (!removed.length || !removed.every(isRemovableLeafBlock)) continue
    const removedFrom = keptOffset === 0 ? prefix + 1 : prefix
    return Object.freeze({
      removedFrom,
      removedTo: removedFrom + removed.length,
      edited: Object.freeze({ index: prefix + keptOffset })
    })
  }
  return null
}

export function removeTopLevelSourceBlocks(source, ranges, from, to) {
  if (from < 0 || to > ranges.length || from >= to) return null
  if (to < ranges.length) {
    return source.slice(0, ranges[from].start) + source.slice(ranges[to].start)
  }
  if (from > 0) {
    return source.slice(0, ranges[from - 1].end) + source.slice(ranges[to - 1].end)
  }
  return source.slice(0, ranges[from].start) + source.slice(ranges[to - 1].end).replace(/^(?:\r\n|\r|\n)+/, '')
}

export function createTopLevelBlockRemovalTransactionSourceSyncOwner({
  parseMarkdownTree,
  serializeCanonical,
  preserveTextEdit,
  validateMarkdown
} = {}) {
  for (const [name, value] of Object.entries({
    parseMarkdownTree,
    serializeCanonical,
    preserveTextEdit,
    validateMarkdown
  })) {
    if (typeof value !== 'function') {
      throw new TypeError(`top-level block removal owner requires ${name}`)
    }
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
    boundary = TOP_LEVEL_BLOCK_REMOVAL_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('top-level-block-removal-journal-stale', { reset: true })
    }
    const verified = verifySourceSyncTransactionJournalCheckpoint({
      checkpoint: journal,
      snapshot,
      expectedDoc
    })
    if (!verified.ok) return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    if (
      typeof currentSource !== 'string' ||
      typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' ||
      !expectedDoc
    ) return rejected('top-level-block-removal-plan-incomplete')
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('top-level-block-removal-live-snapshot-stale')
    }

    const oldDoc = journal.oldDoc
    const classification = classifyTopLevelBlockRemoval(oldDoc, expectedDoc)
    if (!classification) return rejected('top-level-block-removal-not-removal')

    const source = journal.source
    const ranges = alignTopLevelSourceBlocks({ source, doc: oldDoc, parseMarkdownTree })
    if (!ranges) return rejected('top-level-block-removal-source-unaligned')
    const { removedFrom, removedTo, edited } = classification
    if (removedTo > ranges.length) return rejected('top-level-block-removal-source-unaligned')
    const removedSource = removeTopLevelSourceBlocks(source, ranges, removedFrom, removedTo)
    if (removedSource == null) return rejected('top-level-block-removal-range-invalid')

    let markdown = removedSource
    let textEditReason = null
    if (edited) {
      const remaining = childrenOf(oldDoc).filter((_, index) => index < removedFrom || index >= removedTo)
      let intermediateDoc
      try {
        intermediateDoc = oldDoc.type.create(oldDoc.attrs, remaining)
      } catch {
        return rejected('top-level-block-removal-intermediate-invalid')
      }
      let intermediateCanonical
      try {
        intermediateCanonical = serializeCanonical(intermediateDoc)
      } catch {
        return rejected('top-level-block-removal-serializer-threw')
      }
      const preserved = preserveTextEdit(removedSource, intermediateCanonical, canonical)
      if (!preserved || preserved.preserved === false || typeof preserved.markdown !== 'string') {
        return rejected('top-level-block-removal-text-edit-unpreserved')
      }
      markdown = preserved.markdown
      textEditReason = preserved.reason || null
    }

    let equivalent = false
    try {
      equivalent = validateMarkdown({ markdown, expectedDoc }) === true
    } catch {
      return rejected('top-level-block-removal-semantic-validator-threw')
    }
    if (!equivalent) return rejected('top-level-block-removal-semantic-document-mismatch')

    const proof = Object.freeze({
      kind: 'transaction-top-level-block-removal-proof',
      journalId: journal.journalId,
      family: TOP_LEVEL_BLOCK_REMOVAL_TRANSACTION_FAMILY,
      removedFrom,
      removedTo,
      removedTypes: Object.freeze(ranges.slice(removedFrom, removedTo).map((range) => range.type)),
      editedIndex: edited?.index ?? null,
      textEditReason,
      transactionJournal: verified.proof,
      sourceDigest: sourceSyncDigest(source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(markdown),
      callbackDocumentEquivalent: callbackDocumentEquivalent === true,
      snapshotMatched: true,
      documentMatched: true
    })
    const result = Object.freeze({
      markdown,
      preserved: true,
      reason: 'top-level-blocks-removed',
      integrityProof: proof
    })
    return Object.freeze({
      ok: true,
      decision: 'owned',
      owner: SOURCE_SYNC_OWNERS.TRANSACTION,
      family: TOP_LEVEL_BLOCK_REMOVAL_TRANSACTION_FAMILY,
      boundary,
      reason: result.reason,
      baseRevision: verified.proof.baseRevision,
      baseSourceDigest: verified.proof.baseSourceDigest,
      baseCanonicalDigest: verified.proof.baseCanonicalDigest,
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

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: TOP_LEVEL_BLOCK_REMOVAL_TRANSACTION_FAMILY,
    boundary: TOP_LEVEL_BLOCK_REMOVAL_TRANSACTION_BOUNDARY,
    plan
  })
}
