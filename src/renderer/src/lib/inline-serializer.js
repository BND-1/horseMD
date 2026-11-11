// Inline content → mdast, replacing Milkdown's own handling of marks.
//
// Milkdown's SerializerState (@milkdown/transformer) serializes a text block
// node by node: every text node opens its marks and closes them again, and
// each close moves blanks out of the element (`#moveSpaces`). That goes wrong
// with two marks that do not cover the same text (combination test,
// scripts/test-mark-combinations-ui.mjs):
//   - it moves the FIRST TEXT CHILD's leading blanks even when that child is
//     not the first child, and treats a blank-only child as trailing blanks:
//     bold `ad al` + a link on ` alpha` wrote `le**ad[al](u)** [pha](u)` —
//     the space jumped from before `al` to after it (text changed);
//   - a mark left on a blank only (unbold the middle of `lead `) wrote
//     `**l**ea&#x64;****`, literal asterisks;
//   - a link holding inline code and text was split in two
//     (`[\`a\`](u) [b](u)`).
//
// Here a text block's content is written as one tree: blanks move out of a
// mark only at the real edges of its run (prosemirror-markdown's
// expelEnclosingWhitespace; Markdown cannot write `~~a ~~` / `==a ==` /
// `** a**`), a run of blanks only loses the mark, and a mark stays open
// across the pieces that have it (a link stays one link around code).
// Also: line breaks leave mark edges like blanks, inline code never covers
// an image / formula, adjacent `*` runs take different markers. Each
// mark's own runner still decides its mdast node (type, value, props) — it is
// run against a recorder — and every other inline node goes through its own
// runner. Over the repo's 55 000 Markdown blocks the output equals Milkdown's
// wherever Milkdown's parsed back (the rest were improvements).
import { SerializerState } from '@milkdown/transformer'
import { BLANK_CLASS } from './markdown-blanks.js'

// Blanks: lib/markdown-blanks.js (CommonMark's Unicode whitespace —
// `**a\u3000**` does not close either), shared with the validator and the
// source reprint, which compare them without the marks they lose here.
const LEADING_BLANKS = new RegExp(`^${BLANK_CLASS}*`)
const TRAILING_BLANKS = new RegExp(`${BLANK_CLASS}*$`)
const isBreak = (child) => child?.node?.type?.name === 'hardbreak'
// Marks spelled with delimiter runs cannot open or close at a line break
// (`**  \n`, `\\\n*`): a break at their edge moves out. HTML-spelled ones
// hold it fine (Yuque `<font>  \nb</font>`, a red `<mark>`), and links keep
// theirs, as Milkdown wrote them.
const DELIMITED = (record) => record && (record.type === 'strong' || record.type === 'emphasis' || record.type === 'delete' ||
  record.type === 'subscript' || record.type === 'superscript' || (record.type === 'highlight' && (record.props?.color || 'yellow') === 'yellow'))
// HTML block start conditions 1–6 (CommonMark §4.6): these interrupt a
// paragraph when they start a line; type 7 (any other tag) does not.
const HTML_BLOCK_START = /^(?:<(?:script|pre|style|textarea)(?:[\s>]|$)|<!--|<\?|<![A-Za-z]|<!\[CDATA\[|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s/>]|$))/i
// A plain text leaf (inline code leaves hold text too, but it is content).
const isTextLeaf = (child) => child?.text != null && !child.record?.consumed

// What a mark's runner would do: `withMark(mark, type, value, props)`, and
// whether it consumes the node (inline code returns true: the text is its
// value). null when the runner does anything else — then Milkdown's own path
// serializes the block.
function recordMark(mark, node) {
  let record = null
  const recorder = {
    withMark: (_mark, type, value, props) => {
      record = { type, value, props }
      return recorder
    }
  }
  let consumed
  try {
    consumed = mark.type.spec.toMarkdown.runner(recorder, mark, node)
  } catch {
    return null
  }
  if (!record) return null
  return { ...record, consumed: Boolean(consumed) }
}

// The same mark, `marker` aside: `*a*` and `_a_` are one italic (spelling),
// so a run does not end where the spelling changes — the `_` this file writes
// between two `*` runs reads back as a separate mark otherwise, and saving
// again nested it differently.
const sameMark = (a, b) => {
  if (a === b || a.eq(b)) return true
  if (a.type !== b.type || !a.attrs || !('marker' in a.attrs)) return false
  return Object.keys(a.attrs).every((key) => key === 'marker' || a.attrs[key] === b.attrs[key])
}
const hasMark = (marks, mark) => marks.some((m) => sameMark(m, mark))

// Pieces of the block: text (possibly split) or another inline node, each
// with its own mark list. Inline code holds text only: on an image / formula
// it is dropped (its runner would replace the node by an empty code span —
// the image was lost; editor-inline-code-atoms.js keeps it off them).
function piecesOf(fragment) {
  const pieces = []
  fragment.forEach((node) => {
    pieces.push(node.isText ? { text: node.text, marks: node.marks.slice(), node } : { node, marks: node.marks.filter((m) => !m.type.spec.code) })
  })
  return pieces
}

// Phase 1, before the tree: blanks (and breaks) at both edges of every run of
// a mark lose that mark, so which marks are open no longer depends on a
// blank before them (`~~**tail**~~` after ` ` and `**~~tail~~**` without it
// made saving twice write two spellings). Inline code is never trimmed.
function expelRunEdges(pieces, mark, isConsuming, delimited) {
  const blankEdge = (piece, leading) => {
    if (piece.node && piece.text == null) return delimited && piece.node.type.name === 'hardbreak' ? 'all' : null
    if (piece.marks.some(isConsuming)) return null
    const length = piece.text.match(leading ? LEADING_BLANKS : TRAILING_BLANKS)[0].length
    return length === piece.text.length ? 'all' : length || null
  }
  const drop = (piece) => { piece.marks = piece.marks.filter((m) => !sameMark(m, mark)) }
  for (let index = 0; index < pieces.length; index += 1) {
    if (!hasMark(pieces[index].marks, mark)) continue
    let end = index
    while (end + 1 < pieces.length && hasMark(pieces[end + 1].marks, mark)) end += 1
    for (let at = index; at <= end; at += 1) {
      const edge = blankEdge(pieces[at], true)
      if (!edge) break
      if (edge === 'all') { drop(pieces[at]); continue }
      const piece = pieces[at]
      pieces.splice(at, 1, { text: piece.text.slice(0, edge), marks: piece.marks.slice() }, { text: piece.text.slice(edge), marks: piece.marks.slice() })
      end += 1
      drop(pieces[at])
      break
    }
    for (let back = end; back >= index && hasMark(pieces[back].marks, mark); back -= 1) {
      const edge = blankEdge(pieces[back], false)
      if (!edge) break
      if (edge === 'all') { drop(pieces[back]); continue }
      const piece = pieces[back]
      const cut = piece.text.length - edge
      pieces.splice(back, 1, { text: piece.text.slice(0, cut), marks: piece.marks.slice() }, { text: piece.text.slice(cut), marks: piece.marks.slice() })
      end += 1
      drop(pieces[back + 1])
      break
    }
    index = end
  }
}

// Blanks move out of every mark element at its edges, deepest first, so they
// bubble out as far as needed: a crossing pair (bold `ad al` over italic
// `lead`) re-opens the inner mark at a blank, and `** al**` would not parse —
// it is written `**ad** **al**` (the blank loses only the re-opened mark).
// A mark element that holds blanks only goes away.
function expelBlanks(element) {
  for (const child of element.children) if (child.children) expelBlanks(child)
  const out = []
  for (const child of element.children) {
    if (!child.children || child.record.consumed) { out.push(child); continue }
    const kids = child.children
    const before = []
    const after = []
    // A line break at the edge goes too for delimiter marks: `**  \n` /
    // `\\\n*` cannot open / close, and a mark on a break shows nothing.
    const breaks = DELIMITED(child.record)
    while (kids.length && (isTextLeaf(kids[0]) || (breaks && isBreak(kids[0])))) {
      if (isBreak(kids[0])) { before.push(kids.shift()); continue }
      const lead = kids[0].text.match(LEADING_BLANKS)[0].length
      if (!lead) break
      before.push({ text: kids[0].text.slice(0, lead) })
      if (lead < kids[0].text.length) { kids[0] = { text: kids[0].text.slice(lead) }; break }
      kids.shift()
    }
    while (kids.length && (isTextLeaf(kids[kids.length - 1]) || (breaks && isBreak(kids[kids.length - 1])))) {
      if (isBreak(kids[kids.length - 1])) { after.unshift(kids.pop()); continue }
      const last = kids[kids.length - 1]
      const trail = last.text.match(TRAILING_BLANKS)[0].length
      if (!trail) break
      after.unshift({ text: last.text.slice(last.text.length - trail) })
      if (trail < last.text.length) { kids[kids.length - 1] = { text: last.text.slice(0, last.text.length - trail) }; break }
      kids.pop()
    }
    out.push(...before)
    if (kids.length) out.push(child)
    out.push(...after)
  }
  element.children = out
}

// Two attention runs next to each other with the same marker merge into one
// delimiter run: crossing italic / bold write `*字**123***` + `**😀**`, and
// `*字**123*****😀**` does not parse. The second one takes the other marker
// (`__😀__`); the strong / emphasis handlers encode a neighbour where `_`
// needs it.
const ATTENTION = new Set(['strong', 'emphasis'])
function separateAttentionRuns(element) {
  const kids = element.children || []
  kids.forEach((child, index) => {
    if (child.children) separateAttentionRuns(child)
    const previous = kids[index - 1]
    if (!previous?.children || !child.children) return
    if (!ATTENTION.has(previous.record.type) || !ATTENTION.has(child.record.type)) return
    const marker = (record) => record.props?.marker || '*'
    if (marker(previous.record) !== marker(child.record)) return
    child.record = { ...child.record, props: { ...child.record.props, marker: marker(child.record) === '*' ? '_' : '*' } }
  })
}

// The lines at the start and end of a text block that hold only line breaks
// and blanks show nothing and have no Markdown (CommonMark: a break at the
// end of a block is no break, blanks around a line ending are stripped, a
// leading empty line is not part of the paragraph). They are not written —
// spelled (`&#x20;`), a paragraph of spaces read back as a paragraph of
// text, and every such line had its own exception in the comparisons.
// Blanks that lead into text on the first line are text (`&#x20; a`).
const isBreakNode = (node) => /^hard_?break$/.test(node.type.name)
const isBlankTextNode = (node) => node.isText && /^[ \t]*$/.test(node.text) && !node.marks.some((mark) => mark.type.spec.code)
export const trimEdgeLines = (nodes) => {
  let start = 0
  for (;;) {
    let at = start
    while (at < nodes.length && isBlankTextNode(nodes[at])) at += 1
    if (at < nodes.length && isBreakNode(nodes[at])) { start = at + 1; continue }
    if (at === nodes.length) start = at
    break
  }
  let end = nodes.length
  while (end > start && (isBreakNode(nodes[end - 1]) || isBlankTextNode(nodes[end - 1]))) end -= 1
  return start === 0 && end === nodes.length ? nodes : nodes.slice(start, end)
}

// A cell's lines are `<br>`-separated: blank-only text at its edges or next
// to a break shows nothing (HTML) and GFM trims the edges.
// In a table cell, blanks at the cell's edges and next to a `<br>` are not
// written — all of them, whether a text of only blanks or the first / last
// characters of a longer text: GFM trims the edges, and a space at a line
// start after `<br>` shows nothing. Trimming only blank-only texts made the
// serializer write the same cell two ways (` **alp` from a bold " alp",
// `**alp` once read back as " " + bold "alp"), so a reprint verified by
// writing both sides never matched (fuzz seed 5344, Windows). A line's
// edge is wherever its visible content starts / ends, across text nodes:
// `<br>` + "       " + struck " note" kept the struck space (written
// `<br> ~~note~~`, then `<br>~~note~~` once read back; seed 6057).
const trimCellEdgeBlanks = (nodes) => {
  // Inline code keeps its blanks: they are its content (and it is visible).
  const texts = nodes.map((node) => (node.isText && !node.marks.some((mark) => mark.type.spec.code) ? node.text : null))
  let edge = true
  for (let index = 0; index < nodes.length; index += 1) {
    if (isBreakNode(nodes[index])) { edge = true; continue }
    if (texts[index] == null) { edge = false; continue }
    if (edge) texts[index] = texts[index].replace(/^[ \t]+/, '')
    if (texts[index]) edge = false
  }
  edge = true
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (isBreakNode(nodes[index])) { edge = true; continue }
    if (texts[index] == null) { edge = false; continue }
    if (edge) texts[index] = texts[index].replace(/[ \t]+$/, '')
    if (texts[index]) edge = false
  }
  let changed = false
  const out = []
  nodes.forEach((node, index) => {
    const text = texts[index]
    if (text == null || text === node.text) { out.push(node); return }
    changed = true
    if (text) out.push(node.type.schema.text(text, node.marks))
  })
  return changed ? out : nodes
}

function serializeInline(state, fragment, runPlain) {
  const schema = state.schema
  const all = []
  fragment.forEach((node) => all.push(node))
  // A table cell is one line: a `<br>` at its edge is an empty line in the
  // cell, which GFM keeps (written `<br>`).
  // Its edge blanks are trimmed (GFM): blank-only text there is not written
  // (a cell of one space was written `&#x20;` and read back as a space).
  const inCell = (state.elements || []).some((element) => element?.type === 'tableCell')
  const kept = inCell ? trimCellEdgeBlanks(all) : trimEdgeLines(all)
  if (!kept.length) return true
  if (kept !== all) fragment = fragment.constructor.fromArray(kept)
  const pieces = piecesOf(fragment)
  // Records per mark (wrapper marks do not depend on the node; consuming
  // marks are recorded again per piece).
  const records = []
  const recordOf = (mark) => records.find((entry) => sameMark(entry.mark, mark))?.record || null
  for (const piece of pieces) {
    for (const mark of piece.marks) {
      if (recordOf(mark)) continue
      const record = recordMark(mark, piece.node || schema.text(piece.text || ' '))
      if (!record) return false
      records.push({ mark, record })
    }
  }

  for (const { mark, record } of records) {
    if (!record.consumed) expelRunEdges(pieces, mark, (m) => recordOf(m)?.consumed, DELIMITED(record))
  }

  // 1. The tree. A mark already open stays open while the next piece has
  // it. Marks opening together: the one that goes on longer outside (a link
  // stays one link), so the nesting does not depend on what came before.
  // HTML spans (<font>, <kbd>…) go inside (`**<font>a</font>**<font>b</font>`,
  // as Yuque writes and Milkdown wrote). Ties: Milkdown's order (priority,
  // then schema rank). Milkdown's merge of adjacent same-kind mark nodes
  // (closeNode) runs as before.
  const priority = (mark) => mark.type.spec.priority ?? 50
  const isSpan = (mark) => recordOf(mark).type === 'hmHtmlSpan'
  const build = (list) => {
    // Characters from piece `index` on that carry `mark` (an atom counts 1).
    const extent = (index, mark) => {
      let length = 0
      for (let at = index; at < list.length && hasMark(list[at].marks, mark); at += 1) length += list[at].text?.length ?? 1
      return length
    }
    const root = { children: [] }
    const stack = []
    const top = () => stack[stack.length - 1]?.element || root
    list.forEach((piece, index) => {
      if (piece.text === '') return
      const wrapperMarks = piece.marks.filter((mark) => !recordOf(mark).consumed)
      const consuming = piece.marks.find((mark) => recordOf(mark).consumed)
      let keep = 0
      while (keep < stack.length && hasMark(wrapperMarks, stack[keep].mark)) keep += 1
      stack.length = keep
      const opening = wrapperMarks
        .filter((mark) => !stack.some((open) => sameMark(open.mark, mark)))
        .map((mark, order) => ({ mark, order, span: isSpan(mark), length: extent(index, mark) }))
        .sort((x, y) => x.span - y.span || y.length - x.length || priority(x.mark) - priority(y.mark) || x.order - y.order)
      for (const { mark } of opening) {
        // Its own record: the marker of the piece the run starts with.
        const element = { mark, record: recordMark(mark, piece.node || schema.text(piece.text || ' ')) || recordOf(mark), children: [] }
        top().children.push(element)
        stack.push({ mark, element })
      }
      if (consuming) {
        const node = piece.text == null ? piece.node : schema.text(piece.text)
        top().children.push({ mark: consuming, text: piece.text, record: { ...recordMark(consuming, node), consumed: true } })
      } else if (piece.text != null) top().children.push({ text: piece.text })
      else top().children.push({ node: piece.node.mark([]) })
    })
    return root
  }
  // The pieces a tree writes (what the Markdown reads back as).
  const flatten = (root) => {
    const out = []
    const walk = (element, marks) => {
      for (const child of element.children) {
        if (child.children) walk(child, [...marks, child.mark])
        else {
          const own = child.record?.consumed ? [...marks, child.mark] : marks
          const piece = child.node ? { node: child.node, marks: own } : { text: child.text, marks: own }
          piece.marks = piece.marks.slice().sort((x, y) => x.type.rank - y.type.rank)
          const previous = out[out.length - 1]
          if (piece.text != null && previous?.text != null && previous.marks.length === piece.marks.length && previous.marks.every((m, i) => sameMark(m, piece.marks[i]))) previous.text += piece.text
          else out.push(piece)
        }
      }
    }
    walk(root, [])
    return out
  }
  const samePieces = (x, y) => x.length === y.length && x.every((piece, i) =>
    piece.text === y[i].text && (piece.node || null) === (y[i].node || null) &&
    piece.marks.length === y[i].marks.length && piece.marks.every((m) => hasMark(y[i].marks, m)))

  // 2. Blanks (and breaks) out of the mark elements' edges: crossing marks
  // re-open one at a blank inside its run. That changes the marks of those
  // blanks, and with them which marks open together — so build again from
  // what the tree writes until nothing changes: the nesting is then the one
  // a reopened file gets (saving twice writes the same bytes).
  let current = pieces
  let root = null
  for (let round = 0; round < 8; round += 1) {
    root = build(current)
    expelBlanks(root)
    const written = flatten(root)
    const settled = samePieces(written, current.filter((piece) => piece.text !== ''))
    current = written
    if (settled) break
  }
  // No two runs of the same marker side by side.
  separateAttentionRuns(root)

  // 3. Write it through the state (closeNode, not closeMark: no #moveSpaces).
  // A line break right before inline HTML: mdast-util-to-markdown replaces
  // that line ending with a space (HTML at a line start might be read as an
  // HTML block — its issue #15), which joins the lines (CommonMark spec
  // example 148). The break goes INTO the HTML node's value instead; a tag
  // that could start a paragraph-interrupting HTML block (types 1–6) is
  // indented 4 spaces — a continuation line, its indentation stripped.
  // The break goes into one node with what follows it; the compiler spells
  // it (serializer-style.js `hmLineBreakRun`: the document's hard-break style,
  // decided from the real character before it).
  const htmlAfterBreak = (breakNode, htmlNode) => {
    const value = String(htmlNode.attrs?.value ?? '')
    const indent = HTML_BLOCK_START.test(value) ? '    ' : ''
    return { hard: !breakNode.attrs?.isInline, tail: indent + value, marks: htmlNode.marks }
  }
  const writeAll = (children, top = false) => {
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]
      const next = children[index + 1]
      // Two soft breaks in a row (`foo&#10;&#10;bar`) written as two line
      // endings would be a blank line — a new paragraph: the second is
      // `&#10;` (CommonMark spec 39).
      const soft = (entry) => isBreak(entry) && entry.node.attrs?.isInline
      if (soft(child) && soft(next)) {
        let run = 1
        while (soft(children[index + run])) run += 1
        // At the start or end of the block a line break has no spelling
        // (the validator drops edge breaks): `\n&#10; x` would read back as
        // text starting with a newline. Write one break, as for a single
        // edge break (fuzz UI seed 368: text deleted before two breaks).
        if (top && (index === 0 || index + run === children.length)) {
          write(child)
          index += run - 1
          continue
        }
        // One HTML value holding the first line ending too (a line ending
        // right before an HTML node would become a space).
        state.addNode('hmLineBreakRun', undefined, undefined, { hard: false, tail: '&#10;'.repeat(run - 1) })
        index += run - 1
        continue
      }
      // Same after a HARD break: its line ending and a soft break's would be
      // a blank line (`a  \n\nb`, two paragraphs; fuzz seed 3788: Shift+Enter
      // then Enter in a paragraph). The soft breaks are `&#10;`, in one HTML
      // value with the break (a line ending right before HTML would become
      // a space).
      if (isBreak(child) && !soft(child) && soft(next)) {
        let run = 0
        while (soft(children[index + 1 + run])) run += 1
        if (top && index + 1 + run === children.length) {
          write(child)
          index += run
          continue
        }
        state.addNode('hmLineBreakRun', undefined, undefined, { hard: true, tail: '&#10;'.repeat(run) })
        index += run
        continue
      }
      // Text right before a soft break is written together with its line
      // ending, so the text handler sees the newline after it: a trailing
      // backslash there is escaped (`\` + newline is a HARD break — LaTeX
      // `\\` joined into a paragraph, fuzz seed 18).
      if (isTextLeaf(child) && soft(next) && !child.text.includes('\n') && !soft(children[index + 2]) && children[index + 2]?.node?.type?.name !== 'html') {
        runPlain(schema.text(child.text + '\n'))
        index += 1
        continue
      }
      if (isBreak(child) && next?.node?.type?.name === 'html' && next.node.isInline) {
        const { hard, tail, marks } = htmlAfterBreak(child.node, next.node)
        if (marks?.length) runPlain(next.node.type.create({ ...next.node.attrs, value: (hard ? '\\\n' : '\n') + tail }, null, marks))
        else state.addNode('hmLineBreakRun', undefined, undefined, { hard, tail })
        index += 1
        continue
      }
      write(child)
    }
  }
  const write = (child) => {
    if (child.record?.consumed) {
      const { type, value, props } = child.record
      return state.addNode(type, undefined, value, { ...props, isMark: true })
    }
    if (child.text != null) {
      // A line break INSIDE text (from `&#10;` — the editor's own breaks are
      // hardbreak nodes) written raw would end the paragraph: encode it.
      if (!child.text.includes('\n')) return runPlain(schema.text(child.text))
      child.text.split('\n').forEach((part, index) => {
        if (index) state.addNode('html', undefined, '&#10;')
        if (part) runPlain(schema.text(part))
      })
      return
    }
    if (child.node) return runPlain(child.node)
    const { type, value, props } = child.record
    state.openNode(type, value, { ...props, isMark: true })
    writeAll(child.children)
    state.closeNode()
  }
  writeAll(root.children, true)
  return true
}

const isFragment = (value) => value && Object.prototype.hasOwnProperty.call(value, 'size')

// Every SerializerState Milkdown creates (core's serializerCtx) writes inline
// content through serializeInline. Idempotent.
let installed = false
export function installInlineSerializer() {
  if (installed) return
  installed = true
  const create = SerializerState.create
  SerializerState.create = function createWithInlineSerializer(schema, remark) {
    const state = new this(schema)
    const next = state.next
    state.next = (nodes) => {
      if (isFragment(nodes) && nodes.childCount && nodes.firstChild.isInline) {
        let inline = true
        nodes.forEach((node) => { if (!node.isInline) inline = false })
        if (inline && serializeInline(state, nodes, (node) => next(node))) return state
      }
      return next(nodes)
    }
    return (content) => {
      state.run(content)
      return state.toString(remark)
    }
  }
  SerializerState.create.original = create
}

// Test harness only: Milkdown's own serializer (no inline rewrite), to check
// that text it already wrote correctly comes out byte for byte the same.
export function createMilkdownSerializer(schema, remark) {
  return (SerializerState.create.original || SerializerState.create).call(SerializerState, schema, remark)
}
