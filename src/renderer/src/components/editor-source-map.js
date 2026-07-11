const nodeStart = (node) => node?.position?.start?.offset
const nodeEnd = (node) => node?.position?.end?.offset

const textOf = (node) => {
  if (!node) return ''
  if (node.value != null) return String(node.value)
  if (node.alt != null) return String(node.alt)
  if (!node.children) return ''
  return node.children.map(textOf).join('')
}

const valueSpan = (markdown, node) => {
  const start = nodeStart(node)
  const end = nodeEnd(node)
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
    case 'inlineMath':
      pushTextItems(items, markdown, node)
      return items
    case 'image':
    case 'imageReference': {
      const start = nodeStart(node)
      const end = nodeEnd(node)
      if (Number.isFinite(start) && Number.isFinite(end)) items.push({ rawStart: start, rawEnd: end, atom: true })
      return items
    }
    case 'break': {
      const start = nodeStart(node)
      const end = nodeEnd(node)
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
  const start = nodeStart(node)
  const end = nodeEnd(node)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return {
    kind,
    start,
    end,
    text: textOf(node),
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
  if (!node || node.isText) return false
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
  const targetText = normText(md.text)
  if (targetText) {
    const sameTextBefore = mdBlocks
      .slice(0, mdIndex)
      .filter((b) => sameKind(b.kind, md.kind) && normText(b.text) === targetText)
      .length
    const exact = pmBlocks.filter((b) => sameKind(md.kind, b.kind) && normText(b.text) === targetText)
    if (exact.length) return exact[Math.min(sameTextBefore, exact.length - 1)]
    const contains = pmBlocks.filter((b) => {
      if (!sameKind(md.kind, b.kind)) return false
      const text = normText(b.text)
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
  const targetText = normText(pm.text)
  if (targetText) {
    const sameTextBefore = pmBlocks
      .slice(0, pmIndex)
      .filter((b) => sameKind(b.kind, pm.kind) && normText(b.text) === targetText)
      .length
    const exact = mdBlocks.filter((b) => sameKind(b.kind, pm.kind) && normText(b.text) === targetText)
    if (exact.length) return exact[Math.min(sameTextBefore, exact.length - 1)]
    const contains = mdBlocks.filter((b) => {
      if (!sameKind(b.kind, pm.kind)) return false
      const text = normText(b.text)
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

const pmBlockIndexAtPos = (blocks, pmPos) => {
  if (!blocks.length) return -1
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const textEnd = b.textblock ? b.contentPos + (b.text?.length || 0) : b.pos + 1
    if (pmPos >= b.pos && pmPos <= textEnd) return i
    if (pmPos < b.pos) {
      if (i === 0) return 0
      const prev = blocks[i - 1]
      const prevEnd = prev.textblock ? prev.contentPos + (prev.text?.length || 0) : prev.pos + 1
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

export function pmPosToMarkdownOffset(markdown, pmPos, doc, remark) {
  if (!markdown || !doc || !remark) return null
  let tree
  try {
    tree = remark.runSync(remark.parse(markdown), markdown)
  } catch {
    return null
  }
  const mdBlocks = collectMdBlocks(markdown, tree)
  const pmBlocks = collectPmBlocks(doc)
  const pmIndex = pmBlockIndexAtPos(pmBlocks, pmPos)
  if (pmIndex < 0) return null
  const pm = pmBlocks[pmIndex]
  const md = correspondingMdBlock(mdBlocks, pmBlocks, pmIndex)
  if (!md) return null
  if (pm.atom) return md.start
  const local = Math.max(0, Math.min((pmPos || 0) - pm.contentPos, pm.text?.length || 0))
  return rawOffsetFromBlockLocal(md, local)
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
  if (pm.atom) return { pos: pm.pos, atom: true }
  const local = blockLocalIndex(md, rawOffset)
  return { pos: pm.contentPos + Math.max(0, Math.min(local, pm.text.length)), atom: false }
}
