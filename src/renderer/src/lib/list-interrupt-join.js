// A list can start right below a paragraph line only when it is allowed to
// interrupt the paragraph (CommonMark 5.2): not an ordered list starting at
// another number than 1, and not one whose first item is empty. Otherwise its
// marker line reads back as paragraph text and the list is lost. Inside a
// tight list item Milkdown wrote them flush (`1\.` + `2. x`; fuzz seed 814),
// so such a pair always gets a blank line.
export const listCanInterruptParagraph = (list) => {
  if (list?.type !== 'list') return true
  if (list.ordered && (list.start ?? 1) !== 1) return false
  const first = list.children?.[0]
  return Boolean(first?.children?.length)
}

// mdast-util-to-markdown `join` rule: runs before the defaults (they are
// tried last to first), 1 = one blank line.
export const listInterruptJoin = (left, right) =>
  left?.type === 'paragraph' && right?.type === 'list' && !listCanInterruptParagraph(right) ? 1 : undefined
