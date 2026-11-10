

// Crepe serializes a newly-created, still-empty list item as `- <br />`.
// That `<br />` is an editor placeholder, not authored Markdown.  Unlike a
// line break inside a populated list item, it carries no user content and must
// never become part of the source snapshot: after the next keystroke it makes
// the visible source stream diverge from Crepe's list node and the text can be
// mapped back into the preceding paragraph.
//
// Keep the marker plus its following whitespace so the source remains a valid
// empty list item while the caret is there.  Do not touch `text<br>text`, which
// is a real hard break authored inside a list item.
export const normalizeEmptyListItems = (markdown) => String(markdown || '')
  .replace(
    /^([ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)[ \t]*<br\s*\/?>[ \t]*$/gim,
    '$1'
  )
  // A deleted list row leaves a standalone `<br />` placeholder in canonical
  // (Crepe keeps an empty item until the next Backspace). Its indentation can
  // shift (`   <br />` -> `      <br />`), so both sides of the delta must
  // normalize the indentation before visible-stream comparison — otherwise
  // deleting a typed row fails closed and "resurrects" in source mode. Keep
  // the `<br />` token itself so the dedicated empty-block mappers still
  // recognize the placeholder.
  .replace(/^[ \t]*<br\s*\/?>[ \t]*$/gim, '<br />')

// Rich-text-created documents have no authored list spacing to preserve yet.
// Crepe can transiently serialize a newly indented NON-EMPTY item as a loose
// list (`2. item\n\n   1. child`) when several keyboard transactions are
// batched. Generate the compact Markdown users expect from incremental typing.
//
// An EMPTY nested item is different: `1. parent\n   1. ` is not parsed back as
// a nested ordered list by remark; it becomes a hard break plus literal `1.` in
// the parent paragraph. Crepe serializes that editor state as
// `1. parent\n\n   1. <br />`. After normalizeEmptyListItems removes the
// editor-only `<br />`, the blank line is still structural authored Markdown and
// must remain. Only preserve that separator when the next row is both deeper
// and empty; same-level empty rows and non-empty nested rows remain compact.
export const compactGeneratedListSpacing = (markdown) => String(markdown || '')
  .replace(
    /(^([ \t]*)(?:[-+*]|\d{1,9}[.)])[ \t]+[^\n]*)\n(?:[ \t]*\n)+(?=([ \t]*)(?:[-+*]|\d{1,9}[.)])([ \t]+)([^\n]*))/gm,
    (match, currentLine, currentIndent, nextIndent, _markerSpacing, nextBody) => {
      const nestedEmptyItem =
        nextIndent.length > currentIndent.length &&
        String(nextBody || '').trim() === ''
      return nestedEmptyItem ? match : `${currentLine}\n`
    }
  )

// An empty item cannot start a list right after paragraph text (CommonMark:
// an empty list item cannot interrupt a paragraph): `- a\n  -` reads as a
// setext heading and `- a\n  1.` as text. Crepe writes a tight nested empty
// item exactly that way (`- a\n  - <br />`), so once its `<br />` is gone
// the generated source failed validation and the raw canonical, `<br />`
// and all, became the source. A blank line before it keeps the item (the
// source reprint spells it the same way). Siblings of a list item at the
// same indent and items after an empty one are left alone.
export const separateEmptyListStarts = (markdown) => {
  const itemIndent = /^([ \t]*)(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/
  const emptyItem = /^([ \t]*)(?:[-+*]|\d{1,9}[.)])[ \t]*$/
  const out = []
  for (const line of String(markdown || '').split('\n')) {
    const empty = emptyItem.exec(line)
    const prev = out.length ? out[out.length - 1] : null
    if (empty && prev != null && prev.trim() !== '' && !emptyItem.test(prev)) {
      const prevItem = itemIndent.exec(prev)
      if (!prevItem || prevItem[1].length < empty[1].length) out.push('')
    }
    out.push(line)
  }
  return out.join('\n')
}

