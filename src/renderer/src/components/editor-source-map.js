// unified/remark consumes a leading BOM before assigning AST offsets. Every
// raw range returned by this module must still address the physical authored
// Markdown, so restore that one byte centrally for blocks, text spans and atoms.
// Local value lookup below then remains exact for both empty and non-empty nodes.
const markdownAstOffset = (markdown) => String(markdown || '').charCodeAt(0) === 0xFEFF ? 1 : 0
const nodeStart = (markdown, node) => {
  const offset = node?.position?.start?.offset
  return Number.isFinite(offset) ? offset + markdownAstOffset(markdown) : offset
}
const nodeEnd = (markdown, node) => {
  const offset = node?.position?.end?.offset
  return Number.isFinite(offset) ? offset + markdownAstOffset(markdown) : offset
}

const textOf = (node) => {
  if (!node) return ''
  if (node.value != null) return String(node.value)
  if (node.alt != null) return String(node.alt)
  if (!node.children) return ''
  return node.children.map(textOf).join('')
}

// ProseMirror represents inline math, images and hard breaks as atomic inline
// nodes. Their Markdown spelling is not part of the PM paragraph's textContent,
// so it cannot participate in cross-model block identification. Keep the
// regular `text` value for source-local mapping, but compare blocks through a
// projection that omits those atoms on both sides. Otherwise one inline `$…$`
// makes an exact match fail and the old positional fallback can select a wholly
// unrelated paragraph in a chunked long document.
const comparableTextOf = (node) => {
  if (!node) return ''
  switch (node.type) {
    case 'inlineMath':
    case 'image':
    case 'imageReference':
    case 'break':
      return ''
    case 'text':
    case 'inlineCode':
    case 'code':
    case 'html':
    case 'yaml':
    case 'math':
      return node.value == null ? '' : String(node.value)
    default:
      return node.children ? node.children.map(comparableTextOf).join('') : ''
  }
}

const valueSpan = (markdown, node) => {
  const start = nodeStart(markdown, node)
  const end = nodeEnd(markdown, node)
  const value = node?.value == null ? '' : String(node.value)
  if (!Number.isFinite(start) || !Number.isFinite(end) || !value) return null
  const raw = markdown.slice(start, end)
  const idx = raw.indexOf(value)
  if (idx < 0) return { start, end, value }
  return { start: start + idx, end: start + idx + value.length, value }
}

const pushTextItems = (items, markdown, node) => {
  const span = valueSpan(markdown, node)
  if (!span) return
  for (let i = 0; i < span.value.length; i++) {
    items.push({ rawStart: span.start + i, rawEnd: span.start + i + 1 })
  }
}

const collectInlineItems = (markdown, node, items = []) => {
  if (!node) return items
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'code':
    case 'html':
    case 'yaml':
    case 'math':
      pushTextItems(items, markdown, node)
      return items
    case 'image':
    case 'imageReference':
    case 'inlineMath': {
      const start = nodeStart(markdown, node)
      const end = nodeEnd(markdown, node)
      if (Number.isFinite(start) && Number.isFinite(end)) items.push({ rawStart: start, rawEnd: end, atom: true })
      return items
    }
    case 'break': {
      const start = nodeStart(markdown, node)
      const end = nodeEnd(markdown, node)
      if (Number.isFinite(start) && Number.isFinite(end)) items.push({ rawStart: start, rawEnd: end, atom: true })
      return items
    }
    default:
      break
  }
  if (node.children) {
    for (const child of node.children) collectInlineItems(markdown, child, items)
  }
  return items
}

const mdBlock = (markdown, node, kind = node.type) => {
  const start = nodeStart(markdown, node)
  const end = nodeEnd(markdown, node)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return {
    kind,
    start,
    end,
    text: textOf(node),
    matchText: comparableTextOf(node),
    items: collectInlineItems(markdown, node)
  }
}

const collectMdBlocks = (markdown, tree) => {
  const blocks = []
  const walk = (node) => {
    if (!node) return
    if (node.type === 'paragraph') {
      const nonText = (node.children || []).filter((child) => child.type === 'image' || child.type === 'imageReference')
      const textChildren = (node.children || []).filter((child) => child.type !== 'image' && child.type !== 'imageReference')
      if (nonText.length && !textChildren.some((child) => textOf(child).trim())) {
        for (const child of nonText) {
          const b = mdBlock(markdown, child, 'image')
          if (b) blocks.push(b)
        }
        return
      }
      const b = mdBlock(markdown, node, 'paragraph')
      if (b) blocks.push(b)
      return
    }
    if (node.type === 'heading' || node.type === 'code' || node.type === 'html' || node.type === 'yaml' || node.type === 'math') {
      const b = mdBlock(markdown, node, node.type)
      if (b) blocks.push(b)
      return
    }
    if (node.type === 'thematicBreak') {
      const b = mdBlock(markdown, node, 'atom')
      if (b) blocks.push(b)
      return
    }
    if (node.type === 'tableCell') {
      const b = mdBlock(markdown, node, 'tableCell')
      if (b) blocks.push(b)
      return
    }
    if (node.children) {
      for (const child of node.children) walk(child)
    }
  }
  walk(tree)
  return blocks
}

const isPmAtom = (node) => {
  if (!node || node.isText || node.isTextblock) return false
  const name = node.type?.name || ''
  const attrs = node.attrs || {}
  return node.isAtom ||
    node.isLeaf ||
    node.childCount === 0 ||
    attrs.src ||
    attrs.url ||
    /image|html|frontmatter|horizontal_rule|hard_break|thematic|rule/i.test(name)
}

const pmKind = (node) => {
  const name = node.type?.name || ''
  if (/heading/i.test(name)) return 'heading'
  if (/code/i.test(name)) return 'code'
  if (/image/i.test(name)) return 'image'
  if (/html/i.test(name)) return 'html'
  if (/frontmatter|yaml/i.test(name)) return 'yaml'
  if (/table.*cell|cell/i.test(name)) return 'tableCell'
  if (isPmAtom(node)) return 'atom'
  return 'paragraph'
}

const isInsideTableCell = (doc, pos) => {
  try {
    const $pos = doc.resolve(Math.max(0, Math.min(pos + 1, doc.content.size)))
    for (let depth = $pos.depth; depth >= 0; depth--) {
      if (/table.*cell|cell/i.test($pos.node(depth).type?.name || '')) return true
    }
  } catch {
    // Fall back to the node's own type when resolving a transient position.
  }
  return false
}

const collectPmInlineItems = (node, contentPos) => {
  const items = []
  node.descendants((child, offset) => {
    const start = contentPos + offset
    if (child.isText) {
      for (let index = 0; index < child.nodeSize; index += 1) {
        items.push({ pmStart: start + index, pmEnd: start + index + 1 })
      }
      return false
    }
    if (child.isInline && isPmAtom(child)) {
      items.push({ pmStart: start, pmEnd: start + child.nodeSize, atom: true })
      return false
    }
    return true
  })
  return items
}

const collectPmBlocks = (doc) => {
  const blocks = []
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      blocks.push({
        // ProseMirror places a paragraph inside each table_cell. The Markdown
        // side exposes the cell itself as the block, so inherit the ancestor
        // type or block occurrence matching will drift into ordinary paragraphs.
        kind: isInsideTableCell(doc, pos) ? 'tableCell' : pmKind(node),
        pos,
        contentPos: pos + 1,
        text: node.textContent || '',
        matchText: node.textContent || '',
        items: collectPmInlineItems(node, pos + 1),
        textblock: true,
        node
      })
      return false
    }
    if (isPmAtom(node)) {
      blocks.push({
        kind: pmKind(node),
        pos,
        contentPos: pos,
        text: node.textContent || '',
        matchText: node.textContent || '',
        atom: true,
        node
      })
      return false
    }
    return true
  })
  return blocks
}

const blockLocalIndex = (block, rawOffset) => {
  const items = block.items || []
  if (!items.length) return 0
  const raw = Math.max(block.start, Math.min(rawOffset || 0, block.end))
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (raw >= item.rawStart && raw < item.rawEnd) return i
    if (raw < item.rawStart) {
      if (i === 0) return 0
      const prev = items[i - 1]
      return raw - prev.rawEnd <= item.rawStart - raw ? i - 1 : i
    }
  }
  return items.length
}

const nearestMdBlockIndex = (blocks, rawOffset) => {
  if (!blocks.length) return -1
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (rawOffset >= b.start && rawOffset <= b.end) return i
    if (rawOffset < b.start) {
      if (i === 0) return 0
      const prev = blocks[i - 1]
      return rawOffset - prev.end <= b.start - rawOffset ? i - 1 : i
    }
  }
  return blocks.length - 1
}

const sameKind = (mdKind, pmKindValue) => {
  if (mdKind === pmKindValue) return true
  if (mdKind === 'paragraph' && pmKindValue === 'paragraph') return true
  if (mdKind === 'math' && pmKindValue === 'code') return true
  if (mdKind === 'yaml' && pmKindValue === 'yaml') return true
  if (mdKind === 'atom' && pmKindValue === 'atom') return true
  return false
}

const normText = (text) => String(text || '').replace(/\s+/g, ' ').trim()

const correspondingPmBlock = (mdBlocks, pmBlocks, mdIndex) => {
  if (!pmBlocks.length || mdIndex < 0) return null
  const md = mdBlocks[mdIndex]
  const targetText = normText(md.matchText ?? md.text)
  if (targetText) {
    const sameTextBefore = mdBlocks
      .slice(0, mdIndex)
      .filter((b) => sameKind(b.kind, md.kind) && normText(b.matchText ?? b.text) === targetText)
      .length
    const exact = pmBlocks.filter((b) => sameKind(md.kind, b.kind) && normText(b.matchText ?? b.text) === targetText)
    if (exact.length) return exact[Math.min(sameTextBefore, exact.length - 1)]
    const contains = pmBlocks.filter((b) => {
      if (!sameKind(md.kind, b.kind)) return false
      const text = normText(b.matchText ?? b.text)
      return text && (text.includes(targetText) || targetText.includes(text))
    })
    if (contains.length) return contains[Math.min(sameTextBefore, contains.length - 1)]
  }
  if (pmBlocks[mdIndex] && sameKind(mdBlocks[mdIndex].kind, pmBlocks[mdIndex].kind)) return pmBlocks[mdIndex]
  const targetKind = md.kind
  const beforeSameKind = mdBlocks.slice(0, mdIndex).filter((b) => sameKind(b.kind, targetKind)).length
  const sameKindPm = pmBlocks.filter((b) => sameKind(targetKind, b.kind))
  if (sameKindPm[beforeSameKind]) return sameKindPm[beforeSameKind]
  return pmBlocks[Math.max(0, Math.min(pmBlocks.length - 1, mdIndex))]
}

const correspondingMdBlock = (mdBlocks, pmBlocks, pmIndex) => {
  if (!mdBlocks.length || pmIndex < 0) return null
  const pm = pmBlocks[pmIndex]
  // An empty paragraph exists in ProseMirror but has no authored block in the
  // source (empty paragraphs are blank-line separators, not markdown blocks).
  // Map its caret to the blank-line gap after the previous authored block;
  // ordinal alignment must NOT drift into the following block.
  if (pm.kind === 'paragraph' && pm.textblock && !normText(pm.matchText ?? pm.text)) {
    let prevMd = null
    for (let i = pmIndex - 1; i >= 0; i--) {
      const neighbor = pmBlocks[i]
      if (!neighbor.textblock) continue
      if (!normText(neighbor.matchText ?? neighbor.text)) continue // another empty: skip
      const candidate = correspondingMdBlock(mdBlocks, pmBlocks, i)
      if (candidate && !candidate.gap) { prevMd = candidate; break }
    }
    let nextMdStart = null
    for (let i = pmIndex + 1; i < pmBlocks.length; i++) {
      const neighbor = pmBlocks[i]
      if (!neighbor.textblock) continue
      if (!normText(neighbor.matchText ?? neighbor.text)) continue // another empty: skip
      const candidate = correspondingMdBlock(mdBlocks, pmBlocks, i)
      if (candidate && !candidate.gap) { nextMdStart = candidate.start; break }
    }
    const afterPrev = prevMd ? prevMd.end + 1 : 0
    return {
      gap: true,
      gapOffset: nextMdStart != null ? Math.min(afterPrev, nextMdStart) : afterPrev
    }
  }
  const targetText = normText(pm.matchText ?? pm.text)
  if (targetText) {
    const sameTextBefore = pmBlocks
      .slice(0, pmIndex)
      .filter((b) => sameKind(b.kind, pm.kind) && normText(b.matchText ?? b.text) === targetText)
      .length
    const exact = mdBlocks.filter((b) => sameKind(b.kind, pm.kind) && normText(b.matchText ?? b.text) === targetText)
    if (exact.length) return exact[Math.min(sameTextBefore, exact.length - 1)]
    const contains = mdBlocks.filter((b) => {
      if (!sameKind(b.kind, pm.kind)) return false
      const text = normText(b.matchText ?? b.text)
      return text && (text.includes(targetText) || targetText.includes(text))
    })
    if (contains.length) return contains[Math.min(sameTextBefore, contains.length - 1)]
  }
  if (mdBlocks[pmIndex] && sameKind(mdBlocks[pmIndex].kind, pmBlocks[pmIndex].kind)) return mdBlocks[pmIndex]
  const beforeSameKind = pmBlocks.slice(0, pmIndex).filter((b) => sameKind(b.kind, pm.kind)).length
  const sameKindMd = mdBlocks.filter((b) => sameKind(b.kind, pm.kind))
  if (sameKindMd[beforeSameKind]) return sameKindMd[beforeSameKind]
  return mdBlocks[Math.max(0, Math.min(mdBlocks.length - 1, pmIndex))]
}

const pmBlockEnd = (block) => {
  if (!block?.textblock) return (block?.pos || 0) + 1
  const items = block.items || []
  return items.length
    ? items[items.length - 1].pmEnd
    : block.contentPos
}

const pmBlockIndexAtPos = (blocks, pmPos) => {
  if (!blocks.length) return -1
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const textEnd = pmBlockEnd(b)
    if (pmPos >= b.pos && pmPos <= textEnd) return i
    if (pmPos < b.pos) {
      if (i === 0) return 0
      const prev = blocks[i - 1]
      const prevEnd = pmBlockEnd(prev)
      return pmPos - prevEnd <= b.pos - pmPos ? i - 1 : i
    }
  }
  return blocks.length - 1
}

const rawOffsetFromBlockLocal = (block, local) => {
  const items = block.items || []
  if (!items.length) return block.start
  const idx = Math.max(0, Math.min(Math.round(local || 0), items.length))
  if (idx >= items.length) return items[items.length - 1].rawEnd
  return items[idx].rawStart
}

const pmItemIndexAtPos = (block, pmPos) => {
  const items = block.items || []
  if (!items.length) return 0
  const pos = Math.max(block.contentPos, Number(pmPos) || 0)
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (pos >= item.pmStart && pos < item.pmEnd) return index
    if (pos < item.pmStart) {
      if (index === 0) return 0
      const previous = items[index - 1]
      return pos - previous.pmEnd <= item.pmStart - pos ? index - 1 : index
    }
  }
  return items.length
}

const pmPosFromItemIndex = (block, index) => {
  const items = block.items || []
  if (!items.length) return block.contentPos
  const safe = Math.max(0, Math.min(Math.round(index || 0), items.length))
  if (safe >= items.length) return items[items.length - 1].pmEnd
  return items[safe].pmStart
}

// Prepare one immutable PM→Markdown mapping snapshot for callers that need to
// resolve many positions against the same source/doc pair. The scalar helper
// below historically reparsed and recollected the complete document on every
// call; SourceRangeMap construction asks for two offsets per paragraph, which
// makes that scalar shape prohibitively expensive on long documents.
//
// Keep all block correspondence rules centralized here: this is a cache of the
// existing mapping model, not a second mapping algorithm.
export function createPmPosToMarkdownOffsetMapper(markdown, doc, remark) {
  if (!markdown || !doc || !remark) return null
  let tree
  try {
    tree = remark.runSync(remark.parse(markdown), markdown)
  } catch {
    return null
  }
  const mdBlocks = collectMdBlocks(markdown, tree)
  const pmBlocks = collectPmBlocks(doc)
  const mdByPmIndex = new Map()

  return (pmPos) => {
    const pmIndex = pmBlockIndexAtPos(pmBlocks, pmPos)
    if (pmIndex < 0) return null
    const pm = pmBlocks[pmIndex]
    let md = mdByPmIndex.get(pmIndex)
    if (md === undefined) {
      md = correspondingMdBlock(mdBlocks, pmBlocks, pmIndex) || null
      mdByPmIndex.set(pmIndex, md)
    }
    if (!md) return null
    if (md.gap) return md.gapOffset
    if (pm.atom) return md.start
    const local = pmItemIndexAtPos(pm, pmPos)
    return rawOffsetFromBlockLocal(md, local)
  }
}

export function pmPosToMarkdownOffset(markdown, pmPos, doc, remark) {
  const mapPosition = createPmPosToMarkdownOffsetMapper(markdown, doc, remark)
  return mapPosition ? mapPosition(pmPos) : null
}

export function markdownOffsetToPmPos(markdown, rawOffset, doc, remark) {
  if (!markdown || !doc || !remark) return null
  let tree
  try {
    tree = remark.runSync(remark.parse(markdown), markdown)
  } catch {
    return null
  }
  const mdBlocks = collectMdBlocks(markdown, tree)
  const pmBlocks = collectPmBlocks(doc)
  const mdIndex = nearestMdBlockIndex(mdBlocks, rawOffset)
  if (mdIndex < 0) return null
  const md = mdBlocks[mdIndex]
  const pm = correspondingPmBlock(mdBlocks, pmBlocks, mdIndex)
  if (!pm) return null
  // A caret on the blank line between two authored blocks belongs to the empty
  // paragraph that ProseMirror keeps there (absent from the source).
  const inGapAfter = rawOffset > md.end &&
    (mdIndex + 1 >= mdBlocks.length || rawOffset < mdBlocks[mdIndex + 1].start)
  if (inGapAfter) {
    const pmIndex = pmBlocks.indexOf(pm)
    for (let i = pmIndex + 1; i < pmBlocks.length; i++) {
      const candidate = pmBlocks[i]
      if (candidate.textblock && !normText(candidate.matchText ?? candidate.text)) {
        return { pos: candidate.contentPos, atom: false }
      }
      break
    }
  }
  if (pm.atom) return { pos: pm.pos, atom: true }
  const local = blockLocalIndex(md, rawOffset)
  return { pos: pmPosFromItemIndex(pm, local), atom: false }
}
