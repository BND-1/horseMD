// Transaction-first source synchronization for edits whose raw ownership can
// be proven without serializing/reformatting the whole Markdown document.
//
// This is deliberately narrower than the canonical preservation fallback:
// only plain-text ReplaceStep edits inside one unmarked textblock are accepted.
// Every transaction batch is atomic. If one step is structural, marked, or
// cannot be mapped byte-for-byte, the caller keeps the authored source intact
// and lets the existing fail-closed preservation path handle the batch.

const unsafeInlineSyntax = /[`*_{}\[\]<>#|\\]/
const unsafeAtBlockStart = /^(?:[-+>]|\d+[.)])/u
const leadingSpaceSentinel = '\u200B'

const plainSliceText = (slice) => {
  if (!slice || slice.size === 0 || slice.content?.size === 0) return ''
  if (slice.openStart || slice.openEnd) return null
  let text = ''
  let valid = true
  slice.content.forEach((node) => {
    if (!node?.isText || node.marks?.length) {
      valid = false
      return
    }
    text += node.text || ''
  })
  if (!valid || /[\r\n]/.test(text)) return null
  return text
}

const isPlainTextblock = (node) => {
  if (!node?.isTextblock) return false
  let valid = true
  node.forEach((child) => {
    if (!child?.isText || child.marks?.length) valid = false
  })
  return valid
}

const isPlainTopLevelSplit = (step, $from, $to) => {
  if (!step?.structure || step.from !== step.to) return false
  if (!$from.sameParent($to) || $from.depth !== 1 || !isPlainTextblock($from.parent)) return false
  const slice = step.slice
  if (!slice || slice.openStart !== 1 || slice.openEnd !== 1 || slice.content?.childCount !== 2) {
    return false
  }
  let valid = true
  slice.content.forEach((node) => {
    if (!node?.isTextblock) valid = false
  })
  return valid
}

const sameDocument = (left, right) => {
  if (!left || !right) return false
  if (typeof left.eq === 'function') return left.eq(right)
  return left === right
}

const documentLineEnding = (source) => {
  const hasCrLf = source.includes('\r\n')
  const withoutCrLf = source.replace(/\r\n/g, '')
  const hasLoneLf = withoutCrLf.includes('\n')
  const hasLoneCr = withoutCrLf.includes('\r')
  const kinds = (hasCrLf ? 1 : 0) + (hasLoneLf ? 1 : 0) + (hasLoneCr ? 1 : 0)
  if (kinds > 1) return null
  if (hasCrLf) return '\r\n'
  if (hasLoneCr) return '\r'
  return '\n'
}

const leadingLineEndingCount = (source, lineEnding) => {
  let count = 0
  let offset = 0
  while (source.startsWith(lineEnding, offset)) {
    count += 1
    offset += lineEnding.length
  }
  return count
}

// A mapping view keeps one byte-for-byte normalized copy (BOM stripped, every
// line ending reduced to a single `\n`) plus the original authored bytes.
// remark/Pm coordinates are only exact against the normalized copy; every raw
// proof happens there. Edits are applied to both copies simultaneously so the
// final source keeps the author's BOM/CRLF spelling byte-for-byte.
const createMappingView = (original) => {
  let text = ''
  const toRaw = []
  let index = 0
  if (original.charCodeAt(0) === 0xFEFF) index = 1
  while (index < original.length) {
    const code = original.charCodeAt(index)
    if (code === 13) {
      toRaw.push(index)
      text += '\n'
      index += original.charCodeAt(index + 1) === 10 ? 2 : 1
    } else {
      toRaw.push(index)
      text += original[index]
      index += 1
    }
  }
  toRaw.push(original.length)
  return { text, toRaw, original }
}

// Original raw offset -> normalized position. toRaw is monotonically
// increasing, so this is a binary search for the owning normalized slot.
const normalizedFromRaw = (toRaw, rawOffset) => {
  if (!Number.isFinite(rawOffset) || rawOffset < 0) return null
  const max = toRaw[toRaw.length - 1]
  if (rawOffset > max) return null
  let low = 0
  let high = toRaw.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (toRaw[mid] <= rawOffset) low = mid
    else high = mid - 1
  }
  return low
}

// Apply a normalized-coordinate edit to both copies of the mapping view.
// `lineEnding` converts authored separators only for structural splits;
// plain text insertions never contain a newline.
const applyViewEdit = (view, from, to, text, lineEnding = null) => {
  const origFrom = view.toRaw[from]
  const origTo = view.toRaw[to]
  if (!Number.isFinite(origFrom) || !Number.isFinite(origTo)) {
    return { ok: false }
  }
  const origText = lineEnding && text.includes('\n')
    ? text.replace(/\n/g, lineEnding)
    : text
  view.text = view.text.slice(0, from) + text + view.text.slice(to)
  view.original = view.original.slice(0, origFrom) + origText + view.original.slice(origTo)
  const delta = origText.length - (origTo - origFrom)
  const next = view.toRaw.slice(0, from)
  const insertedMapsOneToOne = origText.length === text.length
  for (let i = 0; i < text.length; i += 1) {
    next.push(insertedMapsOneToOne ? origFrom + i : null)
  }
  for (let i = to + 1; i < view.toRaw.length; i += 1) {
    const value = view.toRaw[i]
    next.push(value == null ? null : value + delta)
  }
  view.toRaw = next
  return { ok: true, origFrom, origTo, origText }
}

const diagnostic = (value) => {
  if (!Array.isArray(globalThis.__hmSourceTransactionLog)) return
  globalThis.__hmSourceTransactionLog.push(value)
  if (globalThis.__hmSourceTransactionLog.length > 200) {
    globalThis.__hmSourceTransactionLog.shift()
  }
}

const semanticJson = (node) => {
  if (!node?.toJSON) return null
  const visit = (value) => {
    if (!value || typeof value !== 'object') return value
    const next = { ...value }
    if (next.type === 'heading' && next.attrs) {
      next.attrs = { ...next.attrs }
      // Heading ids are derived by the live editor and regenerated after parse;
      // they are not authored Markdown semantics.
      delete next.attrs.id
      if (!Object.keys(next.attrs).length) delete next.attrs
    }
    if (Array.isArray(next.content)) next.content = next.content.map(visit)
    if (Array.isArray(next.marks)) next.marks = next.marks.map(visit)
    return next
  }
  const result = visit(node.toJSON())
  if (result?.type === 'doc' && Array.isArray(result.content)) {
    // Blank lines are raw Markdown spacing, not parser-level paragraph nodes.
    // Crepe temporarily represents them as empty top-level paragraphs while a
    // user is typing; the parser drops those nodes on reopen. Their exact byte
    // count is protected by source slots/hints, so semantic comparison ignores
    // only these top-level empty paragraphs (never nested quote/list content).
    result.content = result.content.filter((child) => !(
      child?.type === 'paragraph' && !child?.content?.length
    ))
  }
  return result
}

export const areSourceDocumentsEquivalent = (parsed, expected) => {
  const left = semanticJson(parsed)
  const right = semanticJson(expected)
  if (!left || !right) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

export function mapPlainTextTransactionsToSource({
  source,
  transactions,
  oldState,
  newState,
  mapPosition,
  blockHints = [],
  validateMarkdown
}) {
  const original = String(source || '')
  if (!Array.isArray(transactions) || !transactions.length) {
    return { ok: false, markdown: original, reason: 'no-transactions' }
  }
  if (typeof mapPosition !== 'function') {
    return { ok: false, markdown: original, reason: 'missing-position-mapper' }
  }

  const view = createMappingView(original)
  let markdown = view.text
  let doc = oldState?.doc
  let changed = false
  let hints = Array.isArray(blockHints)
    ? blockHints.map((hint) => ({ ...hint }))
    : []

  const fail = (reason, details = null) => {
    const result = { ok: false, markdown: original, reason }
    diagnostic({ ok: false, reason, ...(details || {}) })
    return result
  }

  if (!doc) return fail('missing-old-document')

  for (const transaction of transactions) {
    if (!transaction?.docChanged) continue
    if (!sameDocument(transaction.before, doc)) return fail('transaction-chain-mismatch')
    if (!transaction.steps?.length) return fail('changed-transaction-without-steps')

    for (let index = 0; index < transaction.steps.length; index += 1) {
      const step = transaction.steps[index]
      if (step?.constructor?.name !== 'ReplaceStep') {
        return fail(`unsupported-step-${step?.constructor?.name || 'unknown'}`)
      }
      if (!Number.isFinite(step.from) || !Number.isFinite(step.to)) {
        return fail('invalid-step-range')
      }

      const stepDoc = transaction.docs?.[index] || doc
      let $from
      let $to
      try {
        $from = stepDoc.resolve(step.from)
        $to = stepDoc.resolve(step.to)
      } catch {
        return fail('unresolvable-step-range')
      }
      if (!$from.sameParent($to) || !isPlainTextblock($from.parent)) {
        return fail('non-plain-textblock-edit')
      }

      const blockSplit = isPlainTopLevelSplit(step, $from, $to)
      const inserted = plainSliceText(step.slice)
      if (inserted == null && !blockSplit) return fail('non-plain-inserted-slice')
      if (!blockSplit && unsafeInlineSyntax.test(inserted)) return fail('syntax-sensitive-insert')
      if (!blockSplit && $from.parentOffset === 0 && unsafeAtBlockStart.test(inserted)) {
        return fail('block-prefix-sensitive-insert')
      }
      let rawFrom
      let rawTo
      let blockHint = null
      try {
        const topBlockStart = $from.depth >= 1 ? $from.before(1) : null
        blockHint = hints.find((candidate) => candidate.pmBlockStart === topBlockStart) || null
        if (blockHint) {
          const slotStart = normalizedFromRaw(view.toRaw, blockHint.rawStart)
          if (slotStart == null) return fail('hint-raw-position-unmapped')
          rawFrom = slotStart + $from.parentOffset
          rawTo = slotStart + $to.parentOffset
        } else {
          rawFrom = mapPosition(markdown, step.from, stepDoc)
          rawTo = mapPosition(markdown, step.to, stepDoc)
        }
      } catch {
        return fail('position-mapper-threw')
      }
      if (
        !Number.isFinite(rawFrom) ||
        !Number.isFinite(rawTo)
      ) {
        return fail('unmapped-step-range')
      }
      if (rawFrom > rawTo || rawFrom < 0 || rawTo > markdown.length) {
        return fail('invalid-raw-range')
      }

      // Empty textblocks have no visible character that can prove which raw
      // Markdown blank-line slot owns them. Only a preceding structural edit
      // can establish that ownership. A generic position-map result is
      // ambiguous and previously inserted text into an adjacent paragraph.
      if ($from.parent.content.size === 0) {
        if (!blockHint) return fail('empty-block-without-source-slot')
        // An empty textblock nested inside a list item or blockquote has its
        // container marker immediately before the slot. Mapping the caret to
        // the slot would write text before the marker. List/quote structure is
        // owned by the specialized preservation paths, which keep the marker
        // position exact; the transaction mapper stays out.
        if ($from.depth > 1) return fail('nested-empty-textblock-edit')
      }

      const removed = $from.parent.textBetween(
        $from.parentOffset,
        $to.parentOffset,
        '',
        '\uFFFC'
      )
      const blockText = $from.parent.textBetween(0, $from.parent.content.size, '', '\uFFFC')
      const rawBlockStart = rawFrom - $from.parentOffset
      const rawBlockEnd = rawBlockStart + blockText.length
      if (rawTo !== rawBlockStart + $to.parentOffset) {
        return fail('non-linear-raw-range')
      }
      if (markdown.slice(rawBlockStart, rawBlockEnd) !== blockText) {
        return fail('raw-block-text-mismatch', {
          rawFrom,
          rawTo,
          rawBlockStart,
          rawBlockEnd,
          parentOffset: $from.parentOffset,
          blockText,
          rawBlockText: markdown.slice(rawBlockStart, rawBlockEnd)
        })
      }
      if (blockSplit) {
        // Enter in a top-level heading/paragraph creates two PM textblocks.
        // Markdown needs one blank line between them. Reuse any authored line
        // ending already adjacent to the caret and add only the missing bytes.
        // Splitting at block start is safe only for an empty paragraph whose
        // raw slot was created by this mapper. Non-empty block-at-start splits
        // may interact with heading/list/quote prefixes and stay quarantined.
        if ($from.parentOffset === 0 && ($from.parent.content.size !== 0 || !blockHint)) {
          return fail('split-at-unowned-block-start')
        }
        const lineEnding = documentLineEnding(view.original)
        if (!lineEnding) return fail('mixed-line-ending-split')
        const origFrom = view.toRaw[rawFrom]
        const rightBreaks = leadingLineEndingCount(view.original.slice(origFrom), lineEnding)
        const splitAtBlockEnd = $from.parentOffset === $from.parent.content.size
        // If another authored block already follows, its existing `\n\n`
        // belongs to that boundary. The new empty PM paragraph needs its own
        // preceding boundary as well; inserting another pair creates a stable
        // raw slot between the two boundaries for the first typed character.
        // The separator is authored in the normalized view (plain LF); the
        // view edit converts it to the document's own line ending once.
        const separator = splitAtBlockEnd && rightBreaks >= 2
          ? '\n\n'
          : '\n'.repeat(Math.max(0, 2 - rightBreaks))
        const edited = applyViewEdit(view, rawFrom, rawFrom, separator, lineEnding)
        if (!edited.ok) return fail('view-edit-failed')
        markdown = view.text
        const applied = step.apply(stepDoc)
        if (applied?.failed || !applied?.doc) return fail('step-apply-failed')
        const oldTopStart = $from.before(1)
        const firstSplitBlock = applied.doc.nodeAt(oldTopStart)
        if (!firstSplitBlock) return fail('split-block-missing')
        const newBlockStart = oldTopStart + firstSplitBlock.nodeSize
        hints = hints
          .map((hint) => hint.pmBlockStart > oldTopStart
            ? {
                ...hint,
                pmBlockStart: hint.pmBlockStart + 2,
                rawStart: hint.rawStart + edited.origText.length
              }
            : hint)
          .filter((hint) => hint.pmBlockStart !== newBlockStart)
        hints.push({
          pmBlockStart: newBlockStart,
          // The new block's content starts after a complete paragraph
          // boundary (two line endings). When authored bytes already covered
          // part of that boundary, the separator was shorter; the slot still
          // points past the full two-line-ending boundary.
          rawStart: edited.origFrom + (lineEnding.length * Math.max(2, separator.length))
        })
        doc = applied.doc
        changed = true
        continue
      }
      // This equality is the byte-ownership proof. It rejects escaped syntax,
      // entities, atoms and any mapper drift instead of guessing where a PM
      // character belongs in the authored source.
      if (markdown.slice(rawFrom, rawTo) !== removed) {
        return fail('raw-range-text-mismatch')
      }

      const applied = step.apply(stepDoc)
      if (applied?.failed || !applied?.doc) return fail('step-apply-failed')
      const currentTopStart = $from.before(1)
      const nextTopBlock = applied.doc.nodeAt(currentTopStart)
      let nextTextblock = nextTopBlock?.isTextblock ? nextTopBlock : null
      try {
        const nextResolved = applied.doc.resolve(Math.min(step.from, applied.doc.content.size))
        if (nextResolved.parent?.isTextblock) nextTextblock = nextResolved.parent
      } catch {
        return fail('post-step-position-unresolvable')
      }
      if (
        $from.parent.content.size > 0 &&
        nextTextblock?.content.size === 0
      ) {
        // Emptying a textblock is commonly followed by a structural command:
        // backticks/fences in paragraphs or Enter-to-exit in list items. Until
        // each family is owned as one transaction sequence, mixing a mapped
        // empty source line with its legacy structural callback corrupts the
        // baseline. Keep the whole transition on the proven fallback path.
        return fail('textblock-emptied')
      }
      const nextBlockText = nextTextblock?.isTextblock
        ? nextTextblock.textBetween(0, nextTextblock.content.size, '', '\uFFFC')
        : null
      const hasLeadingSpaceSentinel = markdown.charAt(rawBlockStart - 1) === leadingSpaceSentinel
      const needsLeadingSpaceSentinel = typeof nextBlockText === 'string' && /^\s/u.test(nextBlockText)
      let patchFrom = rawFrom
      let patchTo = rawTo
      let replacement = inserted
      let currentHintRawStart = blockHint?.rawStart ?? null
      if (hasLeadingSpaceSentinel || needsLeadingSpaceSentinel) {
        patchFrom = rawBlockStart - (hasLeadingSpaceSentinel ? 1 : 0)
        patchTo = rawBlockEnd
        replacement = `${needsLeadingSpaceSentinel ? leadingSpaceSentinel : ''}${nextBlockText || ''}`
        currentHintRawStart = view.toRaw[patchFrom] + (needsLeadingSpaceSentinel ? leadingSpaceSentinel.length : 0)
      }
      const edited = applyViewEdit(view, patchFrom, patchTo, replacement, null)
      if (!edited.ok) return fail('view-edit-failed')
      markdown = view.text
      const pmDelta = inserted.length - (step.to - step.from)
      const rawDelta = edited.origText.length - (edited.origTo - edited.origFrom)
      if (pmDelta || rawDelta) {
        hints = hints.map((hint) => {
          if (hint.pmBlockStart === currentTopStart && currentHintRawStart != null) {
            return { ...hint, rawStart: currentHintRawStart }
          }
          if (hint.pmBlockStart > currentTopStart) {
            return {
              ...hint,
              pmBlockStart: hint.pmBlockStart + pmDelta,
              rawStart: hint.rawStart + rawDelta
            }
          }
          return hint
        })
      }
      doc = applied.doc
      changed = true
    }
  }

  if (!changed) return fail('no-document-change')
  if (!sameDocument(doc, newState?.doc)) return fail('final-document-mismatch')
  if (typeof validateMarkdown !== 'function') return fail('missing-semantic-validator')
  try {
    if (validateMarkdown(markdown, newState.doc) !== true) {
      return fail('semantic-document-mismatch')
    }
  } catch {
    return fail('semantic-validator-threw')
  }

  // The caller stores this snapshot as the authored source, so it must carry
  // the author's exact BOM/CRLF spelling. All proofs happened on the
  // normalized copy; `view.original` was edited in lockstep.
  const result = { ok: true, markdown: view.original, blockHints: hints, reason: 'plain-text-transactions' }
  diagnostic({ ok: true, reason: result.reason })
  return result
}
