import { mapPlainTextTransactionsToSource } from '../source-transaction-sync.js'
import { provePendingTextTransactionChain } from './pending-text-transaction-chain.js'
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

export const BLOCKQUOTE_PARAGRAPH_TRANSACTION_FAMILY = 'blockquote-paragraph-text-replace'
export const BLOCKQUOTE_PARAGRAPH_TRANSACTION_BOUNDARY = 'transaction-blockquote-paragraph-text'

const rejected = (reason, {
  deferred = false,
  recognized = false,
  reset = false,
  holdJournal = false,
  proof = null
} = {}) => Object.freeze({
  ok: false,
  decision: 'rejected',
  deferred,
  recognized,
  reset,
  holdJournal,
  reason,
  proof
})

const recognizedRejection = (reason, options = {}) => rejected(reason, {
  ...options,
  recognized: true
})

const isSimpleParagraph = (node, { allowEmpty = false } = {}) => {
  if (!node?.isTextblock || node.type?.name !== 'paragraph') return false
  if (!allowEmpty && node.content?.size <= 0) return false
  let simple = true
  node.forEach?.((child) => {
    if (!child?.isText || (child.marks?.length || 0) > 0) simple = false
  })
  return simple
}

// A quote paragraph whose inline content is only text nodes — marks allowed.
// Such a paragraph cannot use the whole-text single-line splice below (its
// raw bytes carry `**`/`` ` ``/link markup or `> ` continuation prefixes), but
// an edit confined to its text can still be mapped as a localized raw patch.
// Line breaks (Milkdown's `hardbreak`, including soft breaks it marks
// `isInline`) may sit in the UNCHANGED part; the changed span itself must
// still be pure text (enforced by planInlineLocalizedPatch).
const isLineBreakNode = (node) => node?.type?.name === 'hardbreak' || node?.type?.name === 'hard_break'
const isInlineTextParagraph = (node) => {
  if (!node?.isTextblock || node.type?.name !== 'paragraph') return false
  let text = true
  node.forEach?.((child) => {
    if (!child?.isText && !isLineBreakNode(child)) text = false
  })
  return text
}

// E0 (0.13.171 trace): typing a bare block marker character-by-character
// ("1" then ".") passes through an instant where the paragraph text is
// EXACTLY a list/heading/quote marker prefix. Those bytes inside a `> ` line
// re-parse as a DIFFERENT block type (e.g. `> 1.` is an ordered list), so no
// bounded raw patch can be semantically valid at that instant. The next
// physical transaction always resolves it (the input rule converts it into a
// real list, or the next character makes it plain text), so the journal is
// HELD for that transaction instead of failing closed with a warning.
const SYNTAX_PENDING_MARKER_PREFIX = /^(?:\d{1,9}[.)]|[-*+]|#{1,6}|>)[ \t]*$/

const paragraphContentStart = (entry, paragraphIndex) => {
  let childOffset = 0
  const quote = entry?.node
  for (let index = 0; index < paragraphIndex; index += 1) {
    childOffset += quote.child(index).nodeSize
  }
  return entry.offset + 2 + childOffset
}

const lineAtOffset = (source, offset) => {
  if (!Number.isFinite(offset) || offset < 0 || offset > source.length) return null
  let start = offset
  while (start > 0 && source[start - 1] !== '\n' && source[start - 1] !== '\r') start -= 1
  let end = offset
  while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end += 1
  let eol = ''
  if (source.startsWith('\r\n', end)) eol = '\r\n'
  else if (source[end] === '\r') eol = '\r'
  else if (source[end] === '\n') eol = '\n'
  if (!eol) eol = source.match(/\r\n|\r|\n/)?.[0] || '\n'
  return Object.freeze({ start, end, eol })
}

const quoteChildren = (quote) => {
  const children = []
  quote?.forEach?.((node, offset, index) => {
    children.push(Object.freeze({ node, offset, index, type: node?.type?.name || 'unknown' }))
  })
  return children
}

const onlyQuoteChildIndexChanged = (beforeQuote, afterQuote, childIndex) => {
  const before = quoteChildren(beforeQuote)
  const after = quoteChildren(afterQuote)
  if (before.length !== after.length || !before[childIndex] || !after[childIndex]) return false
  return before.every((entry, index) =>
    index === childIndex || entry.node?.eq?.(after[index]?.node) === true
  )
}

const classifyBlockquoteParagraphJournal = ({ journal, expectedDoc }) => {
  const classification = classifySingleAnchoredSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'blockquote',
    reasonPrefix: 'blockquote-paragraph'
  })
  if (!classification.ok) return classification

  const previousQuote = classification.previousEntry.node
  const nextQuote = classification.nextEntry.node
  if (!sourceSyncAttrsEqual(previousQuote.attrs, nextQuote.attrs)) {
    return rejected('blockquote-paragraph-quote-attrs-changed')
  }
  const beforeChildren = quoteChildren(previousQuote)
  const afterChildren = quoteChildren(nextQuote)
  if (beforeChildren.length !== afterChildren.length) {
    return rejected('blockquote-paragraph-child-count-changed')
  }
  const changed = beforeChildren.filter((entry, index) =>
    entry.node?.eq?.(afterChildren[index]?.node) !== true
  )
  if (changed.length !== 1) {
    return rejected('blockquote-paragraph-change-count')
  }
  const paragraphIndex = changed[0].index
  const previousParagraph = beforeChildren[paragraphIndex]?.node
  const nextParagraph = afterChildren[paragraphIndex]?.node
  // 0.13.235: marked text (bold/italic/code/link) is owned through the
  // localized inline patch in plan(); every other non-plain shape keeps the
  // original fail-closed / not-this-family split below.
  const inlineRich =
    !(isSimpleParagraph(previousParagraph) && isSimpleParagraph(nextParagraph, { allowEmpty: true })) &&
    isInlineTextParagraph(previousParagraph) &&
    isInlineTextParagraph(nextParagraph) &&
    previousParagraph.content.size > 0
  if (
    !inlineRich && (
      !isSimpleParagraph(previousParagraph) ||
      !isSimpleParagraph(nextParagraph, { allowEmpty: true })
    )
  ) {
    // A NONEMPTY paragraph whose content carries marks (e.g. Milkdown's
    // input rule converted `*e*` into emphasis) is still this family's shape
    // — text in the quote paragraph — so it must fail CLOSED (recognized):
    // the retired legacy branch may not guess a raw mapping for marked bytes.
    // An EMPTY previous paragraph (filling the published transient) belongs
    // to the legacy fill path, and a non-paragraph child (list/heading/code)
    // is another family's shape; both stay available to the next owner.
    const paragraphShaped = (node) =>
      node?.isTextblock && node.type?.name === 'paragraph'
    if (
      paragraphShaped(previousParagraph) &&
      paragraphShaped(nextParagraph) &&
      previousParagraph.content.size > 0
    ) {
      return recognizedRejection('blockquote-paragraph-not-simple-plain')
    }
    return rejected('blockquote-paragraph-not-simple-plain')
  }
  if (!sourceSyncAttrsEqual(previousParagraph.attrs, nextParagraph.attrs)) {
    return rejected('blockquote-paragraph-attrs-changed')
  }
  if (previousParagraph.textContent === nextParagraph.textContent) {
    // A pure mark toggle on a quote paragraph (Mod+B) stays fail-closed as
    // before: the localized patch below only rewrites text bytes.
    if (inlineRich) return recognizedRejection('blockquote-paragraph-not-simple-plain')
    return rejected('blockquote-paragraph-text-unchanged')
  }

  // Deleting the paragraph's last character (0.13.169 `> ‘` + Backspace) is
  // still THIS family's bounded text delete — but an authored bare `>` line
  // cannot encode an empty quote paragraph at an arbitrary position:
  // CommonMark reads separator `>` lines as paragraph boundaries, not as empty
  // paragraphs. Only exactly one TRAILING empty paragraph after a nonempty
  // sibling can enter the path-scoped semantic transient. A SINGLE-child quote
  // emptied is NOT recognized here: the legacy paragraph-emptied path has
  // owned that shape correctly for years (`>\n>\n` publication), so it stays
  // available. Any other emptied topology has no provable raw/semantic
  // contract, and this legacy-retired family must fail closed rather than let
  // a generic mapper guess the slot.
  if (nextParagraph.content.size === 0) {
    if (beforeChildren.length < 2) {
      return rejected('blockquote-paragraph-emptied-single-child')
    }
    if (paragraphIndex !== beforeChildren.length - 1) {
      return recognizedRejection('blockquote-paragraph-emptied-not-trailing')
    }
  }

  const paragraphContract = (node, options) =>
    inlineRich ? isInlineTextParagraph(node) : isSimpleParagraph(node, options)
  const chain = provePendingTextTransactionChain({
    journal,
    expectedDoc,
    reasonPrefix: 'blockquote-paragraph',
    allowInlineMarks: inlineRich,
    validateTextChain: ({ textSteps }) => {
      if (!textSteps.length) return { ok: false, reason: 'blockquote-paragraph-step-count' }
      for (const textStep of textSteps) {
        const { step, stepDoc, appliedDoc } = textStep
        let $from
        let $to
        try {
          $from = stepDoc.resolve(step.from)
          $to = stepDoc.resolve(step.to)
        } catch {
          return { ok: false, reason: 'blockquote-paragraph-step-range-unresolvable' }
        }
        if (!$from?.sameParent?.($to)) {
          return { ok: false, reason: 'blockquote-paragraph-cross-parent-range' }
        }
        const beforeEntry = sourceSyncNodeEntryAtPath(stepDoc, classification.nodePath)
        const quoteDepth = classification.targetDepth
        if (
          !beforeEntry ||
          beforeEntry.type !== 'blockquote' ||
          $from.depth !== quoteDepth + 1 ||
          $from.parent?.type?.name !== 'paragraph' ||
          $from.node(quoteDepth)?.type?.name !== 'blockquote' ||
          $from.before(quoteDepth) !== beforeEntry.offset ||
          !sourceSyncResolvedPositionMatchesPath($from, classification.nodePath) ||
          !sourceSyncResolvedPositionMatchesPath($to, classification.nodePath) ||
          $from.index(quoteDepth) !== paragraphIndex ||
          $to.index(quoteDepth) !== paragraphIndex
        ) return { ok: false, reason: 'blockquote-paragraph-step-outside-owned-paragraph' }
        const beforeQuote = beforeEntry.node
        const beforeParagraph = quoteChildren(beforeQuote)[paragraphIndex]?.node
        if (
          !sourceSyncAttrsEqual(beforeQuote.attrs, previousQuote.attrs) ||
          !paragraphContract(beforeParagraph, { allowEmpty: true }) ||
          !sourceSyncAttrsEqual(beforeParagraph.attrs, previousParagraph.attrs)
        ) return { ok: false, reason: 'blockquote-paragraph-step-baseline-mismatch' }
        if (!onlySourceSyncNodePathChanged(
          stepDoc,
          appliedDoc,
          classification.nodePath
        )) return { ok: false, reason: 'blockquote-paragraph-neighbour-changed' }
        const afterQuote = sourceSyncNodeEntryAtPath(appliedDoc, classification.nodePath)?.node
        if (
          afterQuote?.type?.name !== 'blockquote' ||
          !sourceSyncAttrsEqual(afterQuote.attrs, previousQuote.attrs) ||
          !onlyQuoteChildIndexChanged(beforeQuote, afterQuote, paragraphIndex)
        ) return { ok: false, reason: 'blockquote-paragraph-quote-structure-changed' }
        const afterParagraph = quoteChildren(afterQuote)[paragraphIndex]?.node
        if (
          !paragraphContract(afterParagraph, { allowEmpty: true }) ||
          !sourceSyncAttrsEqual(afterParagraph.attrs, previousParagraph.attrs)
        ) return { ok: false, reason: 'blockquote-paragraph-result-not-simple-plain' }
        if (beforeParagraph.eq?.(afterParagraph) === true) {
          return { ok: false, reason: 'blockquote-paragraph-step-unchanged' }
        }
      }
      return { ok: true, proof: { nodePath: classification.nodePath, paragraphIndex } }
    }
  })
  if (!chain.ok) return rejected(chain.reason, { proof: chain.proof })

  return Object.freeze({
    ...classification,
    previousQuote,
    nextQuote,
    paragraphIndex,
    previousParagraph,
    nextParagraph,
    inlineRich,
    transactionChain: chain
  })
}

// Backslash-escapes ASCII punctuation that could start inline/block syntax.
// Used only as a second candidate: the semantic validator picks whichever
// spelling re-parses to the user's document.
const escapeInlineMarkdown = (text) => text.replace(/[\\`*_[\]<>!|~=$#]/g, (character) => `\\${character}`)

const uniqueNumbers = (values) => [...new Set(values.filter(Number.isFinite))]

// Markdown delimiters for marks that wrap plain text symmetrically. Links need
// a URL and have no symmetric spelling, so a linked insertion is never wrapped.
const MARK_DELIMITERS = Object.freeze({
  inlineCode: '`',
  emphasis: '*',
  strong: '**',
  strike_through: '~~',
  highlight: '=='
})
const MARK_WRAP_ORDER = ['inlineCode', 'highlight', 'strike_through', 'emphasis', 'strong']

// Spelling of the inserted slice with each text node wrapped in the
// delimiters of the marks it carries but `contextMarks` lacks (marks inherited
// from the surrounding run are already open in the raw bytes). Returns null if
// any such mark has no symmetric spelling.
const wrappedSpelling = (fragment, contextMarks = []) => {
  const inherited = new Set(contextMarks.map((mark) => mark.type?.name))
  let output = ''
  let ok = true
  fragment.forEach((node) => {
    if (!node.isText) { ok = false; return }
    const added = node.marks.map((mark) => mark.type?.name).filter((name) => !inherited.has(name))
    if (added.some((name) => !MARK_DELIMITERS[name])) { ok = false; return }
    let text = node.text
    for (const name of MARK_WRAP_ORDER) {
      if (added.includes(name)) text = `${MARK_DELIMITERS[name]}${text}${MARK_DELIMITERS[name]}`
    }
    output += text
  })
  return ok ? output : null
}

// Quote markers plus the paragraph-line leading whitespace CommonMark strips.
const QUOTE_PREFIX = /^(?: {0,3}>[ \t]*)+/
const INLINE_MARKUP = new Set(['*', '_', '`', '~', '=', '[', ']', '<', '>'])

// The paragraph's raw lines with their quote prefixes removed. `anchor` is a
// raw offset on the paragraph's FIRST line; one raw line per PM line break.
const quoteParagraphSegments = (source, anchor, lineCount) => {
  if (!Number.isFinite(anchor) || anchor < 0 || anchor > source.length) return null
  let cursor = anchor
  while (cursor > 0 && source[cursor - 1] !== '\n' && source[cursor - 1] !== '\r') cursor -= 1
  const firstPrefix = source.slice(cursor).match(QUOTE_PREFIX)?.[0]
  if (!firstPrefix) return null
  const depth = (firstPrefix.match(/>/g) || []).length
  const continuationPrefix = new RegExp(`^(?: {0,3}>[ \\t]*){${depth}}|^[ \\t]+`)
  const segments = []
  for (let index = 0; index < lineCount; index += 1) {
    if (cursor > source.length) return null
    let end = cursor
    while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end += 1
    const line = source.slice(cursor, end)
    // Later lines may be lazy continuations (no `>`), which CommonMark allows.
    const prefix = index === 0 ? firstPrefix : (line.match(continuationPrefix)?.[0] || '')
    segments.push({ rawStart: cursor + prefix.length, text: line.slice(prefix.length) })
    if (index === 0 && anchor > end) return null
    cursor = source.startsWith('\r\n', end) ? end + 2 : end + 1
  }
  return segments
}

// Aligns every PM content offset of an inline-text paragraph with a raw
// offset, skipping inline markup. Returns positions[i] = raw offset of the PM
// unit at content offset i (a character, or the newline of a line break), or
// null when the bytes cannot be explained by the paragraph's content.
const alignInlineParagraph = (paragraph, segments) => {
  const stripped = segments.map((segment) => segment.text).join('\n')
  const rawAt = (index) => {
    let offset = index
    for (let line = 0; line < segments.length; line += 1) {
      const length = segments[line].text.length
      if (offset <= length) return segments[line].rawStart + offset
      offset -= length + 1
    }
    return null
  }
  const positions = []
  let j = 0
  const skipMarkup = () => {
    if (stripped[j] === ']' && stripped[j + 1] === '(') {
      const close = stripped.indexOf(')', j + 2)
      if (close < 0) return false
      j = close + 1
      return true
    }
    if (INLINE_MARKUP.has(stripped[j])) {
      j += 1
      return true
    }
    return false
  }
  let failed = false
  paragraph.forEach((child) => {
    if (failed) return
    if (child.isText) {
      for (const character of child.text) {
        for (const unit of character) {
          while (j < stripped.length && stripped[j] !== unit) {
            if (stripped[j] === '\\' && stripped[j + 1] === unit) { j += 1; break }
            if (!skipMarkup()) { failed = true; return }
          }
          if (j >= stripped.length || stripped[j] !== unit) { failed = true; return }
          positions.push(rawAt(j))
          j += 1
        }
      }
      return
    }
    if (isLineBreakNode(child)) {
      // Closing delimiters / hard-break spelling ("  ", "\\") precede the newline.
      while (j < stripped.length && stripped[j] !== '\n') {
        if (stripped[j] === ' ' || stripped[j] === '\\' || INLINE_MARKUP.has(stripped[j])) j += 1
        else { failed = true; return }
      }
      if (stripped[j] !== '\n') { failed = true; return }
      positions.push(rawAt(j))
      j += 1
      return
    }
    failed = true
  })
  if (failed) return null
  // Only closing markup / trailing spaces may remain on the last line.
  while (j < stripped.length) {
    if (stripped[j] === ' ' || stripped[j] === '\t' || INLINE_MARKUP.has(stripped[j])) j += 1
    else if (stripped[j] === ']' || stripped[j] === ')') j += 1
    else return null
  }
  return positions.some((value) => value == null) ? null : positions
}

/**
 * Localized raw patch for a text edit inside a quote paragraph that the
 * whole-line splice cannot own: marked text, or a paragraph spanning several
 * `> ` lines. The PM diff is reduced to one contiguous text change; its ends
 * are mapped to raw offsets through the character on either side, so a mark
 * boundary yields both "inside the delimiter" and "outside the delimiter"
 * candidates. A deletion must cover raw bytes identical to the deleted text
 * (no markup, no line prefix inside it). Every candidate is then proven by
 * the semantic validator; the first that re-parses to expectedDoc wins.
 */
const planInlineLocalizedPatch = ({
  source,
  oldDoc,
  textStart,
  previousParagraph,
  nextParagraph,
  resolveMarkdownOffset,
  validateMarkdown,
  expectedDoc,
  mapperArgs
}) => {
  const before = previousParagraph.content
  const after = nextParagraph.content
  const start = before.findDiffStart(after)
  if (start == null) return { ok: false, reason: 'blockquote-paragraph-inline-no-diff' }
  const end = before.findDiffEnd(after)
  if (!end) return { ok: false, reason: 'blockquote-paragraph-inline-no-diff' }
  let endA = end.a
  let endB = end.b
  // Repeated characters can make the two scans overlap; clamp like
  // prosemirror-view's own DOM-change reader.
  if (endA < start) { endB += start - endA; endA = start }
  if (endB < start) { endA += start - endB; endB = start }

  const textOf = (fragment) => {
    let value = ''
    let ok = true
    fragment.forEach((node) => {
      if (!node.isText) ok = false
      else value += node.text
    })
    return ok ? value : null
  }
  const deletedText = textOf(before.cut(start, endA))
  const insertedText = textOf(after.cut(start, endB))
  if (deletedText == null || insertedText == null) {
    return { ok: false, reason: 'blockquote-paragraph-inline-non-text-change' }
  }
  if (/[\r\n]/.test(insertedText) || /[\r\n]/.test(deletedText)) {
    return { ok: false, reason: 'blockquote-paragraph-inline-line-break-change' }
  }

  // Character at a PM offset inside the paragraph (break nodes read as U+FFFC,
  // which never matches a source byte, so no boundary is anchored on them).
  const charAt = (offset) => previousParagraph.textBetween(offset, offset + 1, '', '\uFFFC')
  const contentSize = previousParagraph.content.size
  const rawOf = (pmOffset) => {
    try {
      const value = resolveMarkdownOffset({ ...mapperArgs, markdown: source, pmPos: textStart + pmOffset, doc: oldDoc })
      return Number.isFinite(value) ? value : null
    } catch {
      return null
    }
  }
  // Raw offsets for a PM text boundary: just after the previous character and
  // just before the next one (they differ across a markup delimiter).
  let boundaryCandidates = (offset) => {
    const values = []
    if (offset > 0) {
      const raw = rawOf(offset - 1)
      if (raw != null && source[raw] === charAt(offset - 1)) values.push(raw + 1)
    }
    if (offset < contentSize) {
      const raw = rawOf(offset)
      if (raw != null && source[raw] === charAt(offset)) values.push(raw)
    }
    return uniqueNumbers(values)
  }
  // Primary anchoring: align the whole paragraph against its own raw lines
  // (the shared PM→raw mapper ignores `> ` continuation prefixes and can
  // collapse to the block start inside soft-wrapped quote paragraphs).
  let lineCount = 1
  previousParagraph.forEach((child) => { if (isLineBreakNode(child)) lineCount += 1 })
  const segments = quoteParagraphSegments(source, rawOf(0), lineCount)
  const aligned = segments ? alignInlineParagraph(previousParagraph, segments) : null
  if (aligned) {
    const alignedBoundary = (offset) => uniqueNumbers([
      offset > 0 ? aligned[offset - 1] + 1 : null,
      offset < aligned.length ? aligned[offset] : null
    ])
    const original = boundaryCandidates
    boundaryCandidates = (offset) => uniqueNumbers([...alignedBoundary(offset), ...original(offset)])
  }
  const startCandidates = boundaryCandidates(start)
  if (!startCandidates.length) return { ok: false, reason: 'blockquote-paragraph-inline-range-unmapped' }
  const ranges = []
  if (endA === start) {
    for (const rawStart of startCandidates) ranges.push([rawStart, rawStart])
  } else {
    const endCandidates = boundaryCandidates(endA)
    for (const rawStart of startCandidates) {
      for (const rawEnd of endCandidates) {
        if (rawEnd >= rawStart && source.slice(rawStart, rawEnd) === deletedText) ranges.push([rawStart, rawEnd])
      }
    }
    if (!ranges.length) return { ok: false, reason: 'blockquote-paragraph-inline-raw-text-mismatch' }
  }

  // Candidate spellings, most literal first: as typed, backslash-escaped, then
  // wrapped in the delimiters of marks the insertion added (e.g. Milkdown's
  // `*e*` input rule leaves an emphasised "e": its authored bytes are `*e*`).
  const insertedFragment = after.cut(start, endB)
  const leftMarks = start > 0 ? (before.cut(start - 1, start).firstChild?.marks || []) : []
  const spellings = insertedText
    ? [...new Set([
        insertedText,
        escapeInlineMarkdown(insertedText),
        wrappedSpelling(insertedFragment, []),
        wrappedSpelling(insertedFragment, leftMarks)
      ].filter((value) => typeof value === 'string'))]
    : ['']
  for (const spelling of spellings) {
    for (const [rawStart, rawEnd] of ranges) {
      const markdown = source.slice(0, rawStart) + spelling + source.slice(rawEnd)
      let semanticOk = false
      try {
        // Validate the BOM-less, LF-normalized spelling (as the shared
        // plain-text mapper does): Milkdown derives mark attrs such as the
        // emphasis `marker` from character offsets, which a BOM or CR shifts.
        // The returned candidate keeps the author's exact bytes.
        const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
        semanticOk = validateMarkdown({ markdown: normalized, expectedDoc, semanticOptions: {} }) === true
      } catch {
        return { ok: false, reason: 'blockquote-paragraph-semantic-validator-threw' }
      }
      if (semanticOk) {
        return {
          ok: true,
          markdown,
          proof: { start, endA, endB, rawStart, rawEnd, deletedText, insertedText, spelling }
        }
      }
    }
  }
  return { ok: false, reason: 'blockquote-paragraph-semantic-document-mismatch' }
}

const createOwnedPlan = ({
  boundary,
  markdown,
  canonical,
  expectedDoc,
  proof,
  reason = 'blockquote-paragraph-text-change'
}) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason,
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: BLOCKQUOTE_PARAGRAPH_TRANSACTION_FAMILY,
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

export function createBlockquoteParagraphTransactionSourceSyncOwner({
  mapTransactions = mapPlainTextTransactionsToSource,
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof mapTransactions !== 'function') {
    throw new TypeError('blockquote paragraph owner requires mapTransactions')
  }
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('blockquote paragraph owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('blockquote paragraph owner requires validateMarkdown')
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
    boundary = BLOCKQUOTE_PARAGRAPH_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('blockquote-paragraph-journal-stale', { reset: true })
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
    ) return rejected('blockquote-paragraph-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('blockquote-paragraph-live-snapshot-stale', { reset: true })
    }

    const classification = classifyBlockquoteParagraphJournal({ journal, expectedDoc })
    if (!classification.ok) {
      return rejected(classification.reason, {
        proof: classification.proof,
        // Classification rejections normally mean "not this family's shape".
        // The emptied-topology rejections are different: the journal IS a
        // quote-paragraph text edit this legacy-retired family matched, but no
        // provable raw/semantic contract exists — they must stay fail-closed.
        recognized: classification.recognized === true
      })
    }
    const transactions = transactionsFromSourceSyncTransactionJournal(journal)
    if (!transactions.length) return recognizedRejection('blockquote-paragraph-step-count')
    if (SYNTAX_PENDING_MARKER_PREFIX.test(classification.nextParagraph.textContent)) {
      return rejected('blockquote-paragraph-syntax-pending', {
        deferred: true,
        holdJournal: true
      })
    }

    // Map the OWNED paragraph's ORIGINAL text span — published plain text is
    // unambiguous — and splice the FINAL text in place: the same bounded raw
    // patch shape the split family uses. Per-step view evolution is avoided
    // deliberately: an intermediate state can be unrepresentable as authored
    // bytes (the instant a paragraph reads exactly "1.") without invalidating
    // the FINAL mapping. Syntax safety is enforced by the semantic validator
    // on the final candidate, which fails closed on any text that would
    // change block type or acquire marks on re-parse.
    const previousText = classification.previousParagraph.textContent
    const nextText = classification.nextParagraph.textContent
    const textStart = paragraphContentStart(
      classification.previousEntry,
      classification.paragraphIndex
    )
    const buildProof = (markdown, extra = {}) => Object.freeze({
      kind: 'transaction-blockquote-paragraph-proof',
      journalId: journal.journalId,
      family: BLOCKQUOTE_PARAGRAPH_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      nodePath: classification.nodePath,
      paragraphIndex: classification.paragraphIndex,
      unchangedPrefix: classification.unchangedPrefix,
      unchangedSuffix: classification.unchangedSuffix,
      previousText: classification.previousParagraph.textContent,
      nextText: classification.nextParagraph.textContent,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(markdown),
      mapperReason: 'bounded-final-text-patch',
      emptiedParagraph: classification.nextParagraph.content.size === 0,
      transientBlockquotePath: classification.nextParagraph.content.size === 0
        ? classification.nodePath
        : null,
      pendingTextChain: Object.freeze({
        textStepCount: classification.transactionChain.textStepCount,
        textReplacementStepCount: classification.transactionChain.textReplacementStepCount,
        textTransactionCount: classification.transactionChain.textTransactionCount
      }),
      callbackDocumentEquivalent: callbackDocumentEquivalent === true,
      snapshotMatched: true,
      documentMatched: true,
      ...extra
    })
    const planInline = () => {
      // An emptied paragraph keeps the original transient contract only on
      // the single-line plain path.
      if (classification.nextParagraph.content.size === 0) {
        return recognizedRejection('blockquote-paragraph-inline-emptied')
      }
      const patched = planInlineLocalizedPatch({
        source: journal.source,
        oldDoc: journal.oldDoc,
        textStart,
        previousParagraph: classification.previousParagraph,
        nextParagraph: classification.nextParagraph,
        resolveMarkdownOffset,
        validateMarkdown,
        expectedDoc,
        mapperArgs: {
          topLevelIndex: classification.topLevelIndex,
          paragraphIndex: classification.paragraphIndex
        }
      })
      if (!patched.ok) return recognizedRejection(patched.reason)
      const proof = buildProof(patched.markdown, {
        mapperReason: 'bounded-inline-localized-patch',
        inlinePatch: Object.freeze({ ...patched.proof })
      })
      return createOwnedPlan({
        boundary,
        markdown: patched.markdown,
        canonical,
        expectedDoc,
        proof,
        reason: 'blockquote-paragraph-text-change'
      })
    }
    if (classification.inlineRich) return planInline()

    let rawStart
    let rawEnd
    try {
      rawStart = resolveMarkdownOffset({
        markdown: journal.source,
        pmPos: textStart,
        doc: journal.oldDoc,
        topLevelIndex: classification.topLevelIndex,
        paragraphIndex: classification.paragraphIndex
      })
      rawEnd = resolveMarkdownOffset({
        markdown: journal.source,
        pmPos: textStart + previousText.length,
        doc: journal.oldDoc,
        topLevelIndex: classification.topLevelIndex,
        paragraphIndex: classification.paragraphIndex
      })
    } catch {
      return recognizedRejection('blockquote-paragraph-range-mapper-threw')
    }
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd < rawStart) {
      return planInline()
    }
    // The whole-text splice needs the paragraph's raw bytes to equal its
    // text; continuation `> ` prefixes (soft breaks) or escapes break that, so
    // fall back to the localized patch, which maps only the changed span.
    if (journal.source.slice(rawStart, rawEnd) !== previousText) {
      return planInline()
    }
    const line = lineAtOffset(journal.source, rawStart)
    if (!line || rawEnd !== line.end) {
      // A plain paragraph spanning several `> ` lines (soft breaks).
      return planInline()
    }
    const prefix = journal.source.slice(line.start, rawStart)
    if (!/^ {0,3}>[ \t]*$/.test(prefix)) {
      return recognizedRejection('blockquote-paragraph-prefix-unowned')
    }
    const markdown = journal.source.slice(0, line.start) +
      prefix + nextText +
      journal.source.slice(line.end)
    const emptied = nextText.length === 0
    let semanticOk = false
    try {
      semanticOk = validateMarkdown({
        markdown,
        expectedDoc,
        semanticOptions: emptied
          ? { ignoreTrailingEmptyBlockquoteParagraphPaths: [classification.nodePath] }
          : {}
      }) === true
    } catch {
      return recognizedRejection('blockquote-paragraph-semantic-validator-threw')
    }
    if (!semanticOk) {
      return recognizedRejection('blockquote-paragraph-semantic-document-mismatch')
    }

    const proof = Object.freeze({
      kind: 'transaction-blockquote-paragraph-proof',
      journalId: journal.journalId,
      family: BLOCKQUOTE_PARAGRAPH_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      nodePath: classification.nodePath,
      paragraphIndex: classification.paragraphIndex,
      unchangedPrefix: classification.unchangedPrefix,
      unchangedSuffix: classification.unchangedSuffix,
      previousText: classification.previousParagraph.textContent,
      nextText: classification.nextParagraph.textContent,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(markdown),
      mapperReason: 'bounded-final-text-patch',
      emptiedParagraph: classification.nextParagraph.content.size === 0,
      transientBlockquotePath: classification.nextParagraph.content.size === 0
        ? classification.nodePath
        : null,
      pendingTextChain: Object.freeze({
        textStepCount: classification.transactionChain.textStepCount,
        textReplacementStepCount: classification.transactionChain.textReplacementStepCount,
        textTransactionCount: classification.transactionChain.textTransactionCount
      }),
      callbackDocumentEquivalent: callbackDocumentEquivalent === true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({
      boundary,
      markdown,
      canonical,
      expectedDoc,
      proof,
      reason: proof.emptiedParagraph
        ? 'blockquote-paragraph-emptied'
        : 'blockquote-paragraph-text-change'
    })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: BLOCKQUOTE_PARAGRAPH_TRANSACTION_FAMILY,
    boundary: BLOCKQUOTE_PARAGRAPH_TRANSACTION_BOUNDARY,
    plan
  })
}
