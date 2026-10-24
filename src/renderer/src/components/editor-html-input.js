// Typing an HTML tag in the rich editor makes it HTML (Typora parity).
//
// Typed `<span style="color:red">红</span>` used to stay literal text: the
// save escaped it (`\<span …>`) so the reopened file would show the same
// characters, and it only rendered after deleting the backslashes in source
// mode. Now, when the `>` that completes a tag is typed:
//
//   - a closing tag `</name>` takes everything back to the matching
//     `<name …>` earlier in the same text block (typed text or an HTML atom);
//   - any other tag (`<br>`, `<img …>`, `<xxx>`, a lone `<span …>`) or a
//     `<!-- comment -->` is taken alone (`<br>` becomes the line break it
//     opens as — saved as a Markdown hard break);
//
// and that raw text is parsed by the editor's own Markdown pipeline and put
// in its place — so the editor holds exactly what reopening the saved file
// gives (an HTML atom, an editable `<font>`/`<span>`, …). The marks around
// the typed text (bold, a Yuque `<font>`) carry over. Left as text: inline
// code and code blocks, ranges mixing other inline nodes or different
// marks, and a block-level tag at the very start of a text block (Markdown
// would turn the whole paragraph into an HTML block).
import { Plugin } from '@milkdown/prose/state'
import { ParserState } from '@milkdown/kit/transformer'

const TAG_BEFORE = /<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:[ \t\n][^<>￼]*)?\/?$/
const COMMENT_BEFORE = /<!--(?:(?!-->)[^￼])*--$/
// CommonMark HTML block start conditions 1 and 6 (a line starting with them
// is an HTML block whatever follows).
const BLOCK_TAGS = new Set(('pre script style textarea address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '))

// Inline segments of `parent` (a text block starting at `start`) before `end`.
function segmentsBefore(parent, start, end) {
  const segments = []
  parent.forEach((node, offset) => {
    const from = start + offset
    if (from >= end) return
    const to = Math.min(end, from + node.nodeSize)
    if (node.isText) segments.push({ from, to, raw: node.text.slice(0, to - from), marks: node.marks })
    else if (node.type.name === 'html' && to === from + node.nodeSize) segments.push({ from, to, raw: node.attrs.value, marks: node.marks, atom: true })
    else segments.push({ from, to, raw: null, marks: node.marks })
  })
  return segments
}

// Raw text of [from, end) and the marks every piece shares, or null.
function rawRange(segments, from) {
  let raw = ''
  let marks = null
  for (const segment of segments) {
    if (segment.to <= from) continue
    if (segment.raw == null) return null
    if (segment.atom && segment.from < from) return null
    const piece = segment.atom ? segment.raw : segment.raw.slice(Math.max(0, from - segment.from))
    if (marks && !sameMarks(marks, segment.marks)) return null
    marks = marks || segment.marks
    if (marks.some((mark) => mark.type.spec.code)) return null
    raw += piece
  }
  return { raw, marks: marks || [] }
}
const sameMarks = (left, right) => left.length === right.length && left.every((mark, index) => mark.eq(right[index]))

// Position of the `<name …>` the closing tag at `closeFrom` belongs to.
function openerFor(segments, closeFrom, name) {
  // Flatten to a string with each character's document position.
  let text = ''
  const at = []
  for (const segment of segments) {
    if (segment.from >= closeFrom) continue
    if (segment.raw == null) {
      text += '￼'
      at.push(segment.from)
      continue
    }
    if (segment.atom) {
      for (let index = 0; index < segment.raw.length; index += 1) at.push(index === 0 ? segment.from : -1)
      text += segment.raw
    } else {
      const piece = segment.raw.slice(0, closeFrom - segment.from)
      for (let index = 0; index < piece.length; index += 1) at.push(segment.from + index)
      text += piece
    }
  }
  const opener = new RegExp(`<${name}(?=[\\s/>])[^<>\\uFFFC]*>`, 'gi')
  const closer = new RegExp(`</${name}\\s*>`, 'gi')
  let found = -1
  for (const match of text.matchAll(opener)) {
    if (/\/>$/.test(match[0])) continue
    found = match.index
  }
  if (found < 0) return null
  closer.lastIndex = found
  if (closer.exec(text)) return null // already closed before this tag
  const position = at[found]
  return position >= 0 ? position : null
}

// Parse `raw` as it sits inside a line: a letter on each side, cut off
// afterwards. Alone, `<br>` would be a line of HTML that Milkdown drops as an
// empty-line marker, and a tag alone on a line would be an HTML block.
function parseInline(raw, remark, schema) {
  const markdown = `a${raw}a`
  const tree = remark.runSync(remark.parse(markdown), markdown)
  const state = new ParserState(schema)
  state.next(tree)
  const doc = state.toDoc()
  if (doc.childCount !== 1 || !doc.firstChild.isTextblock || doc.firstChild.type.name !== 'paragraph') return null
  const paragraph = doc.firstChild.content
  const first = paragraph.firstChild
  const last = paragraph.lastChild
  if (!first?.isText || !first.text.startsWith('a') || first.marks.length) return null
  if (!last?.isText || !last.text.endsWith('a') || last.marks.length) return null
  const content = paragraph.cut(1, paragraph.size - 1)
  let html = false
  content.forEach((node) => {
    // `<br>` parses to a line break (brToBreakRemarkPlugin), as on reopen.
    if (node.type.name === 'html' || /^hard_?break$/.test(node.type.name) || node.marks.some((mark) => mark.type.name === 'html_span')) html = true
  })
  return html ? content : null
}

/**
 * Raw ProseMirror plugin (prosePluginsCtx). `getRemark` / `getSchema` read
 * the editor's ctx when a tag completes.
 */
export function createHtmlTagInputPlugin({ getRemark, getSchema }) {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== '>' || from !== to) return false
        const { state } = view
        const $from = state.doc.resolve(from)
        const parent = $from.parent
        if (!parent.isTextblock || parent.type.spec.code || !state.schema.nodes.html) return false
        if ($from.marks().some((mark) => mark.type.spec.code)) return false
        const start = $from.start()
        const before = parent.textBetween(0, $from.parentOffset, null, '￼')
        // An unclosed backtick before the caret: inline code is being typed
        // (`` `<i>` ``); its closing backtick makes the code, not HTML.
        if ((before.match(/`/g) || []).length % 2 === 1) return false
        let rangeFrom
        let blockName = null
        const comment = COMMENT_BEFORE.exec(before)
        const tag = comment ? null : TAG_BEFORE.exec(before)
        if (comment) rangeFrom = from - comment[0].length
        else if (tag) {
          rangeFrom = from - tag[0].length
          const name = tag[2].toLowerCase()
          if (tag[1] === '/') {
            const opener = openerFor(segmentsBefore(parent, start, from), rangeFrom, name)
            if (opener != null) rangeFrom = opener
          } else blockName = name
        } else return false
        if (blockName && BLOCK_TAGS.has(blockName) && rangeFrom === start) return false
        // A text block of only `<br>` reopens as an empty paragraph.
        if (blockName === 'br' && rangeFrom === start && $from.parentOffset === parent.content.size) return false
        let parsed
        let range
        try {
          range = rawRange(segmentsBefore(parent, start, from), rangeFrom)
          if (!range) return false
          // The opener of a closing tag may itself be a block tag at the
          // block start (`<div>…</div>` typed as the whole paragraph).
          const lead = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(range.raw)
          if (rangeFrom === start && lead && BLOCK_TAGS.has(lead[1].toLowerCase())) return false
          parsed = parseInline(range.raw + '>', getRemark(), getSchema())
        } catch {
          return false
        }
        if (!parsed) return false
        const nodes = []
        parsed.forEach((node) => {
          let marks = node.marks
          for (const mark of range.marks) marks = mark.addToSet(marks)
          nodes.push(node.mark(marks))
        })
        // Typing after a completed tag continues outside it (an editable
        // <span>/<font> mark is inclusive, which would pull the next
        // characters inside the tag the user just closed).
        view.dispatch(state.tr.replaceWith(rangeFrom, from, nodes).setStoredMarks(range.marks).scrollIntoView())
        return true
      }
    }
  })
}
