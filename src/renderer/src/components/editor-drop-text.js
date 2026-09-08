// Plain-text drop interception (trace-61614 incident, `<br />` drop).
//
// prosemirror-view's native drop prefers the text/html flavor and parses it
// into BLOCK content; inserting that at an inline drop point splits the host
// textblock from its start (a list item became [empty paragraph, full-text
// paragraph]) and spawns stray empty blocks — a PM shape Markdown cannot
// round-trip, which then trips the source-sync integrity warning.
//
// Our paste pipeline intercepts 'paste' in the capture phase; this mirrors it
// for 'drop': text-first payloads (no files, no structured web HTML) are
// inserted as literal text at the drop point, replacing the pre-drag
// selection when the drop lands outside it. Structured HTML drops and file /
// image drops keep their existing handlers (image pipeline, ProseMirror).
import { Fragment } from '@milkdown/prose/model'
import { TextSelection } from '@milkdown/prose/state'
import { hasStructuredWebHtml } from './editor-web-paste.js'

const hasFilePayload = (dataTransfer) =>
  !!(dataTransfer && (dataTransfer.files?.length ||
    [...(dataTransfer.items || [])].some((item) => item.kind === 'file')))

// Inline insertion fragment for possibly multi-line plain text: lines joined
// by hardbreak nodes (a text node can't carry newlines outside code blocks).
const inlineTextFragment = (schema, text) => {
  const hardbreak = schema.nodes.hardbreak || schema.nodes.hard_break
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const nodes = []
  lines.forEach((line, index) => {
    if (index) {
      if (hardbreak) nodes.push(hardbreak.create())
      else nodes.push(schema.text('\n'))
    }
    if (line) nodes.push(schema.text(line))
  })
  return Fragment.fromArray(nodes)
}

export function attachPlainTextDropHandler(view, markUserEdit) {
  const onDrop = (event) => {
    const dataTransfer = event.dataTransfer
    if (!dataTransfer || hasFilePayload(dataTransfer)) return

    const text = dataTransfer.getData('text/plain')
    const html = dataTransfer.getData('text/html')
    if (!text) return // html-only drops keep ProseMirror's handling
    // Rich web fragments (headings/lists/images in the html flavor) keep
    // ProseMirror's slice insertion; layout-junk html like `<br>` is NOT
    // structured, so text/plain wins and lands as literal text.
    if (hasStructuredWebHtml(html)) return

    const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
    const dropPos = Number.isInteger(coords?.pos) ? coords.pos : null
    // Code blocks keep CodeMirror/ProseMirror text-drop semantics (raw text,
    // newlines included) — don't take them over.
    if (dropPos != null && view.state.doc.resolve(dropPos).parent.type.name === 'code_block') return
    if (dropPos == null && view.state.selection.$from.parent.type.name === 'code_block') return

    const fragment = inlineTextFragment(view.state.schema, text)
    if (!fragment.size) return

    event.preventDefault()
    event.stopImmediatePropagation()
    markUserEdit?.()

    const tr = view.state.tr
    const { from, to } = view.state.selection
    let insertFrom = dropPos ?? view.state.selection.head
    let insertTo = insertFrom
    if (from !== to) {
      if (insertFrom >= from && insertFrom <= to) {
        // Drop lands inside the dragged selection: replace it.
        insertFrom = from
        insertTo = to
      } else {
        // Drag onto another spot: delete the dragged selection first.
        tr.delete(from, to)
        if (insertFrom > to) insertFrom = insertTo = tr.mapping.map(insertFrom)
      }
    }
    tr.replaceWith(insertFrom, insertTo, fragment)
    // replaceWith maps the pre-drag selection onto the INSERTED fragment (a
    // range covering it). Left alone, a later drop would mistake that range
    // for a dragged selection and delete the just-inserted text — collapse
    // to a caret at the insertion end, like insertText does.
    tr.setSelection(TextSelection.create(tr.doc, Math.min(insertFrom + fragment.size, tr.doc.content.size)))
    tr.scrollIntoView()
    tr.setMeta('addToHistory', true)
    view.dispatch(tr)
  }
  // Capture so we run BEFORE prosemirror-view's own drop handler.
  view.dom.addEventListener('drop', onDrop, true)
  return () => view.dom.removeEventListener('drop', onDrop, true)
}
