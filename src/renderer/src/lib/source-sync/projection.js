// The Markdown meaning of an editor document, by one definition
// (docs/reprint-root-cause-plan.md, P2):
//
//   project(doc) = parse(serialize(doc)), without the attributes that exist
//   only in the editor.
//
// Whatever Markdown cannot hold (blanks before a break, empty paragraphs,
// edge breaks, adjacent lists that read as one, cell edge blanks…) is gone
// after the round trip, so no list of exceptions is needed. A serializer bug
// would make the projection wrong too, so a guard compares the projection
// with the document: same block skeleton, same non-blank text. A difference
// is reported as `serializer-changed-meaning`, never accepted.
//
// Shadow mode first: `recordProjectionShadow` runs it next to the existing
// comparison and keeps the cases where the two disagree.

const EDITOR_ONLY_ATTRS = {
  heading: ['id'],
  bullet_list: ['spread'],
  ordered_list: ['spread'],
  list_item: ['label', 'listType', 'spread'],
  table_cell: ['colwidth'],
  table_header: ['colwidth']
}
const MARK_EDITOR_ONLY_ATTRS = { strong: ['marker'], emphasis: ['marker'] }
const BLANK = /[\s​]/g
const TEXTBLOCKS = new Set(['paragraph', 'heading', 'code_block'])
const CONTAINERS = new Set(['doc', 'blockquote', 'bullet_list', 'ordered_list', 'list_item', 'table', 'table_row', 'table_header_row', 'table_cell', 'table_header'])

const projectors = new WeakMap()

// The editor registers its parser and serializer per schema (a closed editor's
// schema is unreachable, so its entry goes with it).
export const registerProjector = (schema, projector) => {
  if (schema && projector?.parse && projector?.serialize) projectors.set(schema, projector)
}

const stripAttrs = (json) => {
  if (!json || typeof json !== 'object') return json
  const out = { ...json }
  const drop = EDITOR_ONLY_ATTRS[out.type]
  if (out.attrs) {
    const attrs = { ...out.attrs }
    for (const key of drop || []) delete attrs[key]
    if (attrs.title === '') attrs.title = null
    out.attrs = attrs
  }
  // A line break shows nothing of its marks (bold around a break or closed
  // before it read the same).
  if (/^hard_?break$/.test(out.type)) delete out.marks
  if (Array.isArray(out.marks)) {
    out.marks = out.marks.map((mark) => {
      const keys = MARK_EDITOR_ONLY_ATTRS[mark.type]
      if (!keys || !mark.attrs) return mark
      const attrs = { ...mark.attrs }
      for (const key of keys) delete attrs[key]
      return { ...mark, attrs }
    })
  }
  if (Array.isArray(out.content)) out.content = out.content.map(stripAttrs)
  // A table's short rows read as padded (fixTables does the same in the view).
  if (out.type === 'table' && Array.isArray(out.content)) {
    const width = Math.max(...out.content.map((row) => row.content?.length || 0))
    out.content = out.content.map((row, index) => {
      const cells = row.content || []
      if (cells.length >= width) return row
      const type = index === 0 ? 'table_header' : 'table_cell'
      const pad = Array.from({ length: width - cells.length }, () => ({ type, attrs: { ...(cells[0]?.attrs || {}), alignment: null }, content: [{ type: 'paragraph' }] }))
      return { ...row, content: [...cells, ...pad] }
    })
  }
  return out
}

const isAutolinkLiteral = (text, href) => {
  const value = String(text || '')
  const target = String(href || '')
  return (/^https?:\/\/\S+$/i.test(value) && target === value) ||
    (/^www\.\S+$/i.test(value) && target === `http://${value}`) ||
    (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) && target === `mailto:${value}`)
}

// Block skeleton + non-blank text of every text block that has any: what a
// projection may never change.
const skeleton = (json, path = [], out = []) => {
  if (!json || typeof json !== 'object') return out
  const here = [...path, json.type]
  const children = json.content || []
  // A paragraph holding only one image IS an image block in Markdown (the
  // parser makes `![a](u)` alone on its lines an image-block): same entry.
  if (json.type === 'paragraph') {
    const visible = children.filter((child) => !(child.type === 'text' && !String(child.text || '').replace(BLANK, '')) && !/^hard_?break$/.test(child.type))
    if (visible.length === 1 && visible[0].type === 'image' && !visible[0].marks?.length) {
      out.push(`${path.join('>')}${path.length ? '>' : ''}image-block:<atom>`)
      return out
    }
  }
  if (TEXTBLOCKS.has(json.type)) {
    // Text with its marks (blanks dropped: a mark on a blank shows nothing),
    // and every inline atom but a line break (an edge break has no Markdown).
    // Runs of the same marks are merged: text nodes may split differently.
    // A line break between visible content keeps its kind: soft and hard
    // are both Markdown, so a projection that turns one into the other is a
    // serializer bug (blanks left before a soft break). In a table cell
    // every break is `<br>`.
    const inCell = path.includes('table_cell') || path.includes('table_header')
    let text = ''
    let open = null
    let breaks = ''
    const flush = () => {
      if (breaks && text) text += `<br:${breaks}>`
      breaks = ''
    }
    for (const child of children) {
      if (child.type !== 'text') {
        if (/^hard_?break$/.test(child.type)) {
          breaks += inCell ? 'b' : child.attrs?.isInline === true ? 's' : 'h'
          continue
        }
        flush()
        text += `<${child.type}>`
        open = null
        continue
      }
      const visible = (child.text || '').replace(BLANK, '')
      if (!visible) continue
      flush()
      // A GFM autolink literal (`https://a.com`, `www.a.com`, `a@b.cn`) is
      // text while typed and a link once read (design §5): not a change.
      const marks = (child.marks || []).filter((mark) => !(mark.type === 'link' && isAutolinkLiteral(child.text, mark.attrs?.href))).map((mark) => mark.type).sort().join(',')
      if (marks !== open) text += marks ? `{${marks}}` : '{}'
      open = marks
      text += visible
    }
    text = text.replace(/^\{\}/, '')
    if (text) out.push(`${here.filter((type) => type !== 'paragraph').join('>')}:${text}`)
    return out
  }
  // A block atom (image block, divider, HTML block, formula): its kind.
  if (!children.length && !CONTAINERS.has(json.type)) {
    out.push(`${here.join('>')}:<atom>`)
    return out
  }
  // A table's rows, empty ones included: an empty row has no text, so only
  // its count shows a row the serializer lost (a header row without cells
  // made the first body row the header: fuzz seed 5619).
  if (json.type === 'table') out.push(`${here.join('>')}:rows=${children.length}`)
  for (const child of children) skeleton(child, here, out)
  return out
}

export const projectDocument = (doc) => {
  const projector = projectors.get(doc?.type?.schema)
  if (!projector) return { ok: false, reason: 'no-projector' }
  let markdown
  let reparsed
  try {
    markdown = projector.serialize(doc)
    reparsed = projector.parse(markdown)
  } catch (error) {
    return { ok: false, reason: 'projection-threw', error: String(error).slice(0, 200) }
  }
  const projected = stripAttrs(reparsed.toJSON())
  const original = doc.toJSON()
  const a = skeleton(original)
  const b = skeleton(projected)
  if (a.length !== b.length || a.some((entry, index) => entry !== b[index])) {
    const at = a.findIndex((entry, index) => entry !== b[index])
    return { ok: false, reason: 'serializer-changed-meaning', at, before: a[at]?.slice(0, 160), after: b[at]?.slice(0, 160) }
  }
  return { ok: true, json: projected }
}

// Where two JSON trees first differ (diagnostics only).
const firstDifference = (a, b, path = '') => {
  if (JSON.stringify(a) === JSON.stringify(b)) return null
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return { path, a: JSON.stringify(a)?.slice(0, 200), b: JSON.stringify(b)?.slice(0, 200) }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      const found = firstDifference(a[index], b[index], `${path}[${index}]`)
      if (found) return found
    }
    return { path: `${path}.length`, a: a.length, b: b.length, extra: JSON.stringify((a.length > b.length ? a : b)[Math.min(a.length, b.length)])?.slice(0, 200) }
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const found = firstDifference(a[key], b[key], `${path}.${key}`)
    if (found) return found
  }
  return null
}

// The projection of one top-level block on its own (cached per node). A
// block's Markdown meaning does not depend on its neighbours; what does —
// two lists next to each other reading as one, a paragraph swallowing the
// next line — is the top-level sequence, which the comparison keeps: the
// candidate's side is a real parse.
const blockCache = new WeakMap()
const projectBlock = (node) => {
  if (blockCache.has(node)) return blockCache.get(node)
  const schema = node.type.schema
  let result
  try {
    result = projectDocument(schema.topNodeType.create(null, node))
  } catch (error) {
    result = { ok: false, reason: 'projection-threw', error: String(error).slice(0, 200) }
  }
  // An empty paragraph has no Markdown (a document of nothing reads back as
  // one: ProseMirror fills it).
  const value = result.ok ? { ok: true, json: (result.json.content || []).filter((json) => !(json.type === 'paragraph' && !json.content?.length)) } : result
  blockCache.set(node, value)
  return value
}
const isEmptyParagraph = (node) => node.type.name === 'paragraph' && node.content.size === 0
const isListJSON = (json) => json?.type === 'bullet_list' || json?.type === 'ordered_list'
// The top-level sequence as the whole document reads back: a block with no
// Markdown (an empty paragraph) is gone, and two lists of one kind with only
// such blocks between them are one list (CommonMark; the serializer writes
// them with one marker — RS-86). Directly adjacent lists stay two: the
// serializer alternates their markers.
const projectBlocks = (doc) => {
  const out = []
  let dropped = false
  for (let index = 0; index < doc.childCount; index += 1) {
    const block = projectBlock(doc.child(index))
    if (!block.ok) return { ...block, at: index }
    if (!block.json.length) { dropped = true; continue }
    for (const json of block.json) {
      const previous = out[out.length - 1]
      if (dropped && isListJSON(json) && previous?.type === json.type) {
        out[out.length - 1] = { ...previous, content: [...(previous.content || []), ...(json.content || [])] }
      } else {
        out.push(json)
      }
      dropped = false
    }
  }
  return { ok: true, json: out }
}
// Top-level blocks without the empty paragraphs; null when one of those sat
// between two lists of one kind (they read back as one: no pairing).
const pairableBlocks = (doc) => {
  const kept = []
  let gap = false
  let unpairable = false
  doc.forEach((node) => {
    if (isEmptyParagraph(node)) { gap = true; return }
    const previous = kept[kept.length - 1]
    if (gap && previous && previous.type === node.type && /^(bullet|ordered)_list$/.test(node.type.name)) unpairable = true
    kept.push(node)
    gap = false
  })
  return unpairable ? null : kept
}

export const areDocumentsEquivalentByProjection = (parsed, expected) => {
  // Fast: the same blocks pair up and each pair is identical or projects
  // the same; only blocks that differ are projected.
  const a = pairableBlocks(parsed)
  const b = pairableBlocks(expected)
  if (a && b && a.length === b.length) {
    let same = true
    for (let index = 0; same && index < a.length; index += 1) {
      if (a[index] === b[index] || a[index].eq(b[index])) continue
      const left = projectBlock(a[index])
      const right = projectBlock(b[index])
      same = left.ok && right.ok && JSON.stringify(left.json) === JSON.stringify(right.json)
    }
    if (same) return { equal: true }
  }
  const left = projectBlocks(parsed)
  const right = projectBlocks(expected)
  if (!left.ok) return { equal: false, reason: `candidate:${left.reason}`, detail: left }
  if (!right.ok) return { equal: false, reason: `editor:${right.reason}`, detail: right }
  const equal = JSON.stringify(left.json) === JSON.stringify(right.json)
  return equal ? { equal } : { equal, reason: 'differs', detail: firstDifference(left.json, right.json) }
}

// Option A (user decision 2026-10-10): bold / italic that Markdown cannot
// delimit may be written as literal `*` / `_`. The only allowed difference:
// with strong / emphasis marks and the `*` `_` characters left out, the two
// projections are identical (structure, all other text and marks).
const withoutEmphasis = (json) => {
  if (Array.isArray(json)) {
    const out = []
    for (const item of json.map(withoutEmphasis)) {
      if (item == null) continue
      const previous = out[out.length - 1]
      if (item.type === 'text' && previous?.type === 'text' && JSON.stringify(previous.marks || []) === JSON.stringify(item.marks || [])) previous.text += item.text
      else out.push(item)
    }
    return out
  }
  if (!json || typeof json !== 'object') return json
  const out = { ...json }
  if (out.type === 'text') {
    out.text = String(out.text || '').replace(/[*_]/g, '')
    if (!out.text) return null
  }
  if (Array.isArray(out.marks)) {
    out.marks = out.marks.filter((mark) => mark.type !== 'strong' && mark.type !== 'emphasis')
    if (!out.marks.length) delete out.marks
  }
  if (Array.isArray(out.content)) out.content = withoutEmphasis(out.content)
  return out
}
export const literalEmphasisOnly = (parsed, expected) => {
  const left = projectBlocks(parsed)
  const right = projectBlocks(expected)
  return left.ok && right.ok && JSON.stringify(withoutEmphasis(left.json)) === JSON.stringify(withoutEmphasis(right.json))
}

// The meaning of one text block (paragraph / heading), the same definition
// applied to the block alone: its projection as a top-level block, or — in a
// table cell, where GFM trims the edges — as the cell of a one-cell table.
// A key string; equal keys = the same Markdown meaning. Null when no
// projector is registered for the schema or the block cannot be projected.
// Nodes are immutable, so the key is cached per node.
const meaningCache = { flow: new WeakMap(), table_cell: new WeakMap(), table_header: new WeakMap() }
// `cell`: false, or the cell's node type name (`table_cell` / `table_header`:
// GFM treats a header cell and a body cell alike, the editor's `<br>`
// handling does not).
export const textblockMeaning = (node, { cell = false } = {}) => {
  if (!node?.isTextblock || node.type.spec.code) return null
  const cellType = cell === true ? 'table_cell' : cell
  const cache = cellType ? meaningCache[cellType] : meaningCache.flow
  if (!cache) return null
  if (cache.has(node)) return cache.get(node)
  const schema = node.type.schema
  const projector = projectors.get(schema)
  let key = null
  if (projector) {
    try {
      if (cellType) {
        const { table, table_header_row: headerRow, table_row: row, table_header: header, table_cell: body, paragraph } = schema.nodes
        const rows = cellType === 'table_header'
          ? [headerRow.create(null, header.create(null, node))]
          : [headerRow.create(null, header.create(null, paragraph.create())), row.create(null, body.create(null, node))]
        const projected = projectDocument(schema.topNodeType.create(null, table.create(null, rows)))
        if (projected.ok) key = JSON.stringify(projected.json.content || [])
      } else {
        const projected = projectBlock(node)
        if (projected.ok) key = JSON.stringify(projected.json)
      }
    } catch {
      key = null
    }
  }
  cache.set(node, key)
  return key
}

// Shadow: record where the projection and the existing comparison disagree.
const SHADOW_LIMIT = 50
const SHADOW_MAX_SIZE = 200000
export const recordProjectionShadow = (parsed, expected, existingVerdict, options = {}) => {
  if (globalThis.__hmProjectionShadow !== true) return
  if (!parsed?.content || !expected?.content) return
  if (parsed.content.size > SHADOW_MAX_SIZE || expected.content.size > SHADOW_MAX_SIZE) return
  const log = (globalThis.__hmProjectionShadowLog ||= { agree: 0, disagree: 0, entries: [] })
  let verdict
  try {
    verdict = areDocumentsEquivalentByProjection(parsed, expected)
  } catch (error) {
    verdict = { equal: false, reason: 'threw', detail: String(error).slice(0, 200) }
  }
  const flags = Object.keys(options || {}).filter((key) => options[key] && key !== 'recordDifference').sort().join(',') || '-'
  log.byOptions ||= {}
  const bucket = (log.byOptions[flags] ||= { agree: 0, disagree: 0 })
  if (verdict.equal === existingVerdict) { log.agree += 1; bucket.agree += 1; return }
  log.disagree += 1
  bucket.disagree += 1
  if (log.entries.length >= SHADOW_LIMIT) return
  log.entries.push({
    at: Date.now(),
    existing: existingVerdict,
    options: flags,
    projection: verdict.equal,
    reason: verdict.reason || null,
    detail: verdict.detail ? JSON.stringify(verdict.detail).slice(0, 400)
      // Only the existing comparison refuses: what differs before projecting.
      : JSON.stringify(firstDifference(stripAttrs(parsed.toJSON()), stripAttrs(expected.toJSON())) || null).slice(0, 400),
    parsed: JSON.stringify(parsed.toJSON()).slice(0, 1500),
    expected: JSON.stringify(expected.toJSON()).slice(0, 1500)
  })
}
