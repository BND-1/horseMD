// Prototype: transaction-step -> source mapper.
//
// Goal (verification): reconstruct the authored Markdown source by applying
// ProseMirror transactions' raw steps directly, WITHOUT Milkdown's
// whole-document serialization. The source stays the single source of truth;
// this mapper is a pure, fail-closed adapter that either produces a confident
// source edit or leaves the source untouched.
//
// HARD CONTRACT: this module must never modify user content when it cannot
// map a step with confidence. Every apply() returns { ok } and only advances
// its own internal source state when ok === true.

const isBlockType = (type) =>
  type === 'paragraph' ||
  type === 'heading' ||
  type === 'blockquote' ||
  type === 'bullet_list' ||
  type === 'ordered_list' ||
  type === 'list_item' ||
  type === 'code_block' ||
  type === 'math_block'

// Strip Markdown block syntax from a source line so it can be compared with
// the PM node's textContent (which excludes markers).
const stripBlockPrefix = (line) => line
  .replace(/^#{1,6}[ \t]+/, '')
  .replace(/^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/, '')
  .replace(/^[ \t]*>[ \t]?/, '')

const blockPrefixLength = (line) => {
  const m = line.match(/^(?:#{1,6}[ \t]+|[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+|[ \t]*>[ \t]?)/)
  return m ? m[0].length : 0
}

// Split authored source into block regions at blank-line boundaries.
// Returns [{ start, end, text }] where text is the block's visible text
// (line breaks preserved, trailing whitespace trimmed per line).
const splitSourceBlocks = (source) => {
  const lines = source.split('\n')
  const blocks = []
  let startLine = 0
  // raw offset of the start of each line
  const lineStart = []
  let pos = 0
  for (const line of lines) {
    lineStart.push(pos)
    pos += line.length + 1
  }
  for (let i = 0; i <= lines.length; i++) {
    const isBlank = i === lines.length || lines[i].trim() === ''
    if (isBlank) {
      if (i > startLine) {
        const blockLines = lines.slice(startLine, i)
        const text = blockLines.join('\n').replace(/[ \t]+$/gm, '').trim()
        if (text) {
          // skip leading blank lines inside the candidate region
          let first = startLine
          while (first < i && lines[first].trim() === '') first += 1
          let last = i - 1
          while (last >= first && lines[last].trim() === '') last -= 1
          blocks.push({
            start: lineStart[first],
            end: lineStart[last] + lines[last].length,
            text,
            textStart: lineStart[first] + blockPrefixLength(lines[first])
          })
        }
      }
      startLine = i + 1
    }
  }
  return blocks
}

export class StepSourceMapper {
  constructor() {
    this.source = ''
    this.blocks = [] // { type, pmStart, pmEnd, rawStart, rawEnd, ok }
    this.ready = false
    this.originalTrailingNewlines = 0
  }

  // Bootstrap from an existing authored source and the PM doc's top-level
  // block list [{ type, pmStart, pmEnd, text }]. Blocks are aligned by
  // ordinal and visible-text equality; any mismatch fails closed.
  bootstrap(source, docBlocks) {
    this.source = String(source || '')
    this.originalTrailingNewlines = (this.source.match(/\n*$/) || [''])[0].length
    this.blocks = []
    const sourceBlocks = splitSourceBlocks(this.source)
    if (docBlocks.length !== sourceBlocks.length) {
      this.ready = false
      return { ok: false, reason: 'block-count-mismatch' }
    }
    for (let i = 0; i < docBlocks.length; i++) {
      const db = docBlocks[i]
      const sb = sourceBlocks[i]
      const sbVisible = sb.text.split('\n').map(stripBlockPrefix).join('\n').trim()
      if (db.text.trim() !== sbVisible) {
        this.ready = false
        return { ok: false, reason: `block-${i}-text-mismatch` }
      }
      this.blocks.push({
        type: db.type,
        pmStart: db.pmStart,
        pmEnd: db.pmEnd,
        rawStart: sb.textStart,
        rawEnd: sb.end
      })
    }
    this.ready = true
    return { ok: true }
  }

  // Bootstrap a brand-new document from an empty source and the initial
  // skeleton block list. The empty-title skeleton contributes no authored
  // bytes; later typing in the title establishes the `# ` prefix lazily.
  bootstrapNew(docBlocks) {
    this.source = ''
    this.blocks = docBlocks.map((db) => ({
      type: db.type,
      pmStart: db.pmStart,
      pmEnd: db.pmEnd,
      rawStart: 0,
      rawEnd: 0,
      pending: true // no authored bytes yet
    }))
    this.ready = true
    return { ok: true }
  }

  blockAt(pmPos) {
    for (const b of this.blocks) {
      if (pmPos >= b.pmStart && pmPos <= b.pmEnd) return b
    }
    return null
  }

  // Map a PM position to a raw source offset. Within a plain text block the
  // mapping is linear. Blocks without authored bytes yet (pending) map to the
  // source length. Unmapped positions fail closed.
  pmToRaw(pmPos) {
    const b = this.blockAt(pmPos)
    if (!b) return null
    if (b.pending) return this.source.length
    return b.rawStart + (pmPos - b.pmStart)
  }

  // Apply a single step. Returns { ok } and advances internal state only on
  // success. Unknown / unmapped steps never touch the source.
  applyStep(step) {
    if (!this.ready) return { ok: false, reason: 'not-ready' }
    if (step.kind !== 'ReplaceStep') {
      return { ok: false, reason: `unsupported-step-${step.kind}` }
    }
    const fromBlock = this.blockAt(step.from)
    const toBlock = this.blockAt(step.to)
    if (!fromBlock || !toBlock) return { ok: false, reason: 'unmapped-block' }

    const rawFrom = this.pmToRaw(step.from)
    const rawTo = this.pmToRaw(step.to)
    if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo)) {
      return { ok: false, reason: 'unmapped-offset' }
    }
    const from = Math.min(rawFrom, rawTo)
    const to = Math.max(rawFrom, rawTo)

    const text = step.text || ''
    const insertingBlock = isBlockType(step.blockType)

    if (insertingBlock && text === '') {
      // Block split (Enter): insert one separator newline at the caret so the
      // existing trailing newline completes the two-newline block boundary.
      const delta = 1
      const pmDelta = 2 // an empty block node occupies 2 PM positions
      this.source = this.source.slice(0, from) + '\n' + this.source.slice(from)
      this.blocks = this.blocks.map((b) => {
        if (b.rawStart >= from) {
          return { ...b, rawStart: b.rawStart + delta, rawEnd: b.rawEnd + delta, pmStart: b.pmStart + pmDelta, pmEnd: b.pmEnd + pmDelta }
        }
        return b
      })
      // register the new empty block (pending until it receives text)
      this.blocks.push({
        type: step.blockType,
        // the new node spans [from, from + 2); the caret lands at content start.
        // pmStart/pmEnd are re-anchored to the caret when the first text arrives.
        pmStart: step.from,
        pmEnd: step.from + 2,
        rawStart: from + delta,
        rawEnd: from + delta,
        pending: true
      })
      this.blocks.sort((a, b) => a.pmStart - b.pmStart)
      return { ok: true, edit: 'block-split' }
    }

    // Pure text insertion / deletion (possibly with a block boundary passing
    // through the deleted range).
    const targetBlock = fromBlock
    if (targetBlock.pending) {
      // First text in a pending (Enter-created) block: establish its raw span.
      // The block's own line terminator is added once, after the first text.
      targetBlock.pending = false
      targetBlock.rawStart = from
      targetBlock.pmStart = step.from
      this.source = this.source.slice(0, from) + text + this.source.slice(to)
      const terminatorAt = from + text.length
      if (this.source.length === terminatorAt && this.source[terminatorAt - 1] !== '\n') {
        this.source += '\n'
      }
      targetBlock.rawEnd = from + text.length + 1
      targetBlock.pmEnd = targetBlock.pmEnd + text.length
      // blocks after the new paragraph shift by the inserted text length
      const pmTextDelta = text.length
      this.blocks = this.blocks.map((b) => {
        if (b !== targetBlock && b.pmStart >= targetBlock.pmStart) {
          return { ...b, pmStart: b.pmStart + pmTextDelta, pmEnd: b.pmEnd + pmTextDelta }
        }
        return b
      })
      return { ok: true, edit: 'text-first-in-block' }
    }
    const delta = text.length - (to - from)
    const pmDelta = text.length - (step.to - step.from)
    this.source = this.source.slice(0, from) + text + this.source.slice(to)
    this.blocks = this.blocks.map((b) => {
      if (b.pending) return b
      if (b.rawStart >= to) {
        // entirely after the edit: shift
        return { ...b, rawStart: b.rawStart + delta, rawEnd: b.rawEnd + delta, pmStart: b.pmStart + pmDelta, pmEnd: b.pmEnd + pmDelta }
      }
      if (b.rawEnd < from) return b
      if (b.rawEnd === from && to === from) {
        // zero-width insert exactly at this block's end: the block grows
        return { ...b, rawEnd: b.rawEnd + delta, pmEnd: b.pmEnd + pmDelta }
      }
      // spans the edit: keep the before-part, the inserted text, and the after-part
      const before = Math.max(0, from - b.rawStart)
      const after = Math.max(0, b.rawEnd - to)
      return {
        ...b,
        rawEnd: b.rawStart + before + text.length + after,
        pmEnd: b.pmEnd + pmDelta
      }
    })
    // If the edit emptied a block's text, its line terminator becomes a stray
    // blank line. A trailing paragraph that is empty again collapses back to
    // the separator (matching how the editor represents an empty trailing
    // paragraph) and returns to the pending state.
    const lastBlock = this.blocks[this.blocks.length - 1]
    if (
      !lastBlock.pending &&
      lastBlock.rawEnd - lastBlock.rawStart <= 1 &&
      this.source.slice(lastBlock.rawStart) === '\n'
    ) {
      // trailing paragraph emptied again: collapse to the separator and return
      // the block to the pending state (it can receive text again on Enter).
      this.source = this.source.slice(0, lastBlock.rawStart)
      // the file's terminal line-ending run is authored formatting: cap to the
      // original trailing-newline count instead of leaving the emptied
      // paragraph's blank line behind.
      const sourceTrailing = (this.source.match(/\n*$/) || [''])[0].length
      if (sourceTrailing > this.originalTrailingNewlines) {
        this.source = this.source.slice(0, this.source.length - sourceTrailing) +
          '\n'.repeat(this.originalTrailingNewlines)
      }
      lastBlock.rawStart = this.source.length
      lastBlock.rawEnd = this.source.length
      lastBlock.pending = true
      lastBlock.pmEnd = lastBlock.pmStart
    }
    return { ok: true, edit: 'text' }
  }

  getSource() {
    return this.source
  }
}
