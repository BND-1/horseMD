// Visible unit ↔ source offset mapping for one text block (source reprint R1,
// docs/source-reprint-architecture.md §3.2).
//
// A ProseMirror text block's inline content is a sequence of UNITS: every
// UTF-16 code unit of every text node, plus one unit per inline leaf
// (hardbreak, inline image/html/math). The mdast for the same block yields the
// same sequence in document order. This module walks the mdast inline tree
// with a cursor over the raw source and records, for each unit, the raw range
// that spells it — skipping delimiters, backslash escapes, entities, the
// U+200B leading-space sentinel and container prefixes after line breaks.
//
// mdast nodes created by remark plugins can lack `position` (the soft-break
// split, merged inline HTML, highlight); positioned nodes re-anchor the
// cursor, unpositioned ones are scanned sequentially. Any disagreement returns
// null: the caller then reprints the whole block instead of guessing.

const SENTINEL = '​'
const ENTITY = /^&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const PUNCT = /[!-/:-@[-`{-~]/

const decodeEntity = (raw, index) => {
  const match = ENTITY.exec(raw.slice(index, index + 40))
  if (!match) return null
  let text = null
  if (match[1]) text = String.fromCodePoint(parseInt(match[1], 16))
  else if (match[2]) text = String.fromCodePoint(parseInt(match[2], 10))
  else if (NAMED[match[3]]) text = NAMED[match[3]]
  return text == null ? null : { text, length: match[0].length }
}

const startOf = (node) => node?.position?.start?.offset
const endOf = (node) => node?.position?.end?.offset

// Units of a ProseMirror text block, in order.
export function pmInlineUnits(textblock) {
  const units = []
  textblock.forEach((child) => {
    if (child.isText) {
      for (let index = 0; index < child.text.length; index += 1) {
        units.push({ kind: 'char', char: child.text[index], marks: child.marks })
      }
    } else {
      units.push({ kind: 'leaf', node: child, marks: child.marks })
    }
  })
  return units
}

/**
 * @param {object} options
 * @param {string} options.source  full source (BOM already removed)
 * @param {object} options.block   mdast paragraph / heading / tableCell
 * @param {number} options.quoteDepth  blockquote nesting of the block
 * @returns {null | {units: {from:number,to:number,top:number}[], tops: {from:number,to:number}[]}}
 *   `top` is the index of the block's top-level inline child holding the unit;
 *   `tops` are those children's raw ranges (for segment reprint).
 */
export function buildInlineMap({ source, block, quoteDepth = 0 }) {
  const units = []
  const tops = []
  let cursor = startOf(block)
  const blockEnd = endOf(block)
  if (!Number.isInteger(cursor) || !Number.isInteger(blockEnd)) return null
  let failed = false
  let top = -1

  // Skip a heading's `#` run or a cell's leading pipe spacing: the first child
  // anchors via its position when present; otherwise skip ATX markers.
  // A table cell's position starts at its leading pipe.
  if (block.type === 'tableCell') {
    const lead = /^\|?[ \t]*/.exec(source.slice(cursor, blockEnd))
    if (lead) cursor += lead[0].length
  }
  if (block.type === 'heading') {
    const atx = /^[ \t]{0,3}#{1,6}(?:[ \t]+|(?=[\r\n]|$))/.exec(source.slice(cursor, blockEnd))
    if (atx) cursor += atx[0].length
  }

  // After a line break inside the block: optional indentation and up to
  // `quoteDepth` quote markers (lazy continuation lines may omit them).
  const skipContinuationPrefix = (index) => {
    let at = index
    while (source[at] === ' ' || source[at] === '\t') at += 1
    for (let depth = 0; depth < quoteDepth && source[at] === '>'; depth += 1) {
      at += 1
      if (source[at] === ' ' || source[at] === '\t') at += 1
      while (source[at] === ' ' || source[at] === '\t') at += 1
    }
    return at
  }

  const skipLineBreak = (index) => {
    let at = index
    if (source[at] === '\r') at += 1
    if (source[at] !== '\n') return -1
    return skipContinuationPrefix(at + 1)
  }

  const anchor = (node) => {
    const start = startOf(node)
    if (Number.isInteger(start)) {
      if (start < cursor) { failed = true; return false }
      cursor = start
    }
    return true
  }

  const scanText = (value, limit) => {
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index]
      if (cursor >= limit) { failed = true; return }
      if (source[cursor] === SENTINEL && char !== SENTINEL) cursor += 1
      const from = cursor
      if (char === '\n') {
        // Soft line break kept inside a text value: trailing spaces + EOL + prefix.
        let at = cursor
        while (source[at] === ' ' || source[at] === '\t') at += 1
        const next = skipLineBreak(at)
        if (next < 0) { failed = true; return }
        cursor = next
        units.push({ from, to: cursor, top })
        continue
      }
      // A backslash escape wins over a literal match: in `\\` the value's
      // single `\` is spelled by both characters.
      if (source[cursor] === '\\' && source[cursor + 1] === char && PUNCT.test(char)) {
        cursor += 2
      } else if (source[cursor] === char) {
        cursor += 1
      } else if (source[cursor] === '&') {
        const entity = decodeEntity(source, cursor)
        if (!entity || entity.text[0] !== char) { failed = true; return }
        // Astral code points span two UTF-16 units in value.
        if (entity.text.length === 2) {
          if (value[index + 1] !== entity.text[1]) { failed = true; return }
          units.push({ from, to: cursor + entity.length, top })
          index += 1
        }
        cursor += entity.length
      } else {
        failed = true
        return
      }
      units.push({ from, to: cursor, top })
    }
  }

  const visit = (node, limit) => {
    if (failed) return
    if (!anchor(node)) return
    const nodeEnd = endOf(node)
    const bound = Number.isInteger(nodeEnd) ? nodeEnd : limit
    switch (node.type) {
      case 'text':
        scanText(node.value, bound)
        break
      case 'inlineCode': {
        const run = /^`+/.exec(source.slice(cursor, bound))
        if (!run) { failed = true; return }
        const close = Number.isInteger(nodeEnd) ? nodeEnd - run[0].length : source.indexOf(run[0], cursor + run[0].length)
        if (close < 0) { failed = true; return }
        let contentFrom = cursor + run[0].length
        let contentTo = close
        const inner = source.slice(contentFrom, contentTo)
        if (inner.length >= 2 && /^[ \r\n]/.test(inner) && /[ \r\n]$/.test(inner) && inner.trim() !== '' &&
          node.value.length === inner.replace(/\r?\n[ \t>]*/g, ' ').length - 2) {
          contentFrom += 1
          contentTo -= 1
        }
        cursor = contentFrom
        for (let index = 0; index < node.value.length; index += 1) {
          const from = cursor
          if (/[\r\n]/.test(source[cursor] || '') && node.value[index] === ' ') {
            const next = skipLineBreak(cursor)
            if (next < 0) { failed = true; return }
            cursor = next
          } else if (source[cursor] === node.value[index]) {
            cursor += 1
          } else { failed = true; return }
          units.push({ from, to: cursor, top })
        }
        if (cursor !== contentTo) { failed = true; return }
        cursor = close + run[0].length
        break
      }
      case 'break': {
        const from = cursor
        const br = /^<br\s*\/?>/i.exec(source.slice(cursor, bound))
        if (br) {
          cursor += br[0].length
        } else {
          let at = cursor
          if (source[at] === '\\') at += 1
          while (source[at] === ' ' || source[at] === '\t') at += 1
          const next = skipLineBreak(at)
          if (next < 0) { failed = true; return }
          cursor = next
        }
        units.push({ from, to: cursor, top })
        break
      }
      case 'image':
      case 'html':
      case 'inlineMath':
      case 'footnoteReference': {
        const from = cursor
        if (Number.isInteger(nodeEnd)) cursor = nodeEnd
        else if (typeof node.value === 'string' && source.startsWith(node.value, cursor)) cursor += node.value.length
        else { failed = true; return }
        units.push({ from, to: cursor, top })
        break
      }
      case 'strong':
      case 'emphasis':
      case 'delete':
      case 'highlight':
      case 'subscript':
      case 'superscript':
      case 'link':
      case 'linkReference': {
        // Opening syntax: skip to the first child's position when known,
        // otherwise skip the delimiter run.
        const first = node.children?.[0]
        if (Number.isInteger(startOf(first))) {
          cursor = startOf(first)
        } else {
          const open = /^(?:\*{1,3}|_{1,3}|~{1,2}|\^|={2}|\[|<mark\b[^>]*>)/.exec(source.slice(cursor, bound))
          if (open) cursor += open[0].length
        }
        for (const child of node.children || []) visit(child, bound)
        if (Number.isInteger(nodeEnd)) cursor = nodeEnd
        else {
          // Inline `](url "t")`, full `][ref]`, collapsed `[]` / shortcut `]`.
          const close = /^(?:\*{1,3}|_{1,3}|~{1,2}|\^|={2}|<\/mark>|\]\((?:[^()\n]|\([^()\n]*\))*\)|\]\[[^\]\n]*\]|\])/.exec(source.slice(cursor, bound))
          if (close) cursor += close[0].length
        }
        break
      }
      case 'hmHtmlSpan': {
        // Editable <font>/<span>: skip the authored open tag, map the
        // content, skip the close tag.
        const first = node.children?.[0]
        const open = /^<(?:font|span)(?=[\s>])[^>]*>/i.exec(source.slice(cursor, bound))
        if (Number.isInteger(startOf(first))) cursor = startOf(first)
        else if (open) cursor += open[0].length
        else { failed = true; return }
        for (const child of node.children || []) visit(child, bound)
        if (failed) return
        if (Number.isInteger(nodeEnd)) cursor = nodeEnd
        else {
          const close = /^<\/(?:font|span)\s*>/i.exec(source.slice(cursor, bound))
          if (!close) { failed = true; return }
          cursor += close[0].length
        }
        break
      }
      default:
        failed = true
    }
  }

  const children = block.children || []
  for (let index = 0; index < children.length && !failed; index += 1) {
    top = index
    const child = children[index]
    const from = Number.isInteger(startOf(child)) ? startOf(child) : cursor
    visit(child, blockEnd)
    tops.push({ from: Math.min(from, cursor), to: cursor })
  }
  if (failed) return null
  return { units, tops }
}
