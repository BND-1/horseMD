// Editor-only document changes: ProseMirror edits that have no Markdown
// encoding and therefore must not enter a source-sync transaction journal.
//
// Milkdown's `trailing` plugin appends an empty paragraph whenever the
// document ends with a non-paragraph block (table, list, code, quote, …),
// typically in the appendTransaction of the user's first click. Serializing
// the document yields byte-identical Markdown, but if that step sits at the
// head of the next journal every focused owner sees TWO top-level changes and
// rejects, leaving the edit to the legacy canonical-diff guess.

/**
 * True when `transactions` consist of exactly one ReplaceStep that appends a
 * single empty paragraph at the end of a document whose last block was not a
 * paragraph, leaving every existing top-level block untouched.
 */
export function isTrailingEmptyParagraphAppend(transactions, oldDoc, newDoc) {
  if (!oldDoc || !newDoc || !Array.isArray(transactions)) return false
  const steps = transactions.flatMap((transaction) => transaction?.steps || [])
  if (steps.length !== 1) return false
  const [step] = steps
  const end = oldDoc.content.size
  if (step?.constructor?.name !== 'ReplaceStep' || step.from !== end || step.to !== end) return false
  if (newDoc.childCount !== oldDoc.childCount + 1) return false
  const previousLast = oldDoc.lastChild
  if (!previousLast || previousLast.type?.name === 'paragraph') return false
  const appended = newDoc.lastChild
  if (appended?.type?.name !== 'paragraph' || appended.content.size !== 0) return false
  for (let index = 0; index < oldDoc.childCount; index += 1) {
    if (!oldDoc.child(index).eq(newDoc.child(index))) return false
  }
  return true
}



// Milkdown's syncHeadingIdPlugin recomputes every heading `id` from its text
// after a document change (skipping IME composition) and dispatches the fix as
// a SEPARATE setNodeMarkup transaction — typically riding on the user's next
// edit somewhere else. Heading ids have no Markdown encoding (the semantic
// validator already ignores them), but as journal content they made the next
// journal span two top-level blocks, which no focused owner accepts (fuzz
// 2026-10-03 seed 33: edit a heading, then type in a code block → stranded
// until Save fell into the recovery prompt).
const attrsWithoutId = (attrs) => {
  const { id, ...rest } = attrs || {}
  return JSON.stringify(rest)
}

const sameIgnoringHeadingIds = (left, right) => {
  if (left === right) return true
  // Only real ProseMirror nodes qualify; anything else stays strictly unequal.
  if (
    !left || !right ||
    typeof left.eq !== 'function' || typeof right.eq !== 'function' ||
    !left.type || !right.type
  ) return false
  if (left.eq(right)) return true
  if (left.type !== right.type) return false
  if (left.childCount !== right.childCount) return false
  // Marks count on every node: an image / formula differs by its marks
  // alone (`**![i](a.png)**`). Without this, bolding just an image read as
  // "the same document" — the serializer memo returned the old Markdown and
  // the heading-id adoption could swallow the change.
  if (left.marks.length !== right.marks.length || left.marks.some((mark, index) => !mark.eq(right.marks[index]))) return false
  if (left.type.name === 'heading') {
    return attrsWithoutId(left.attrs) === attrsWithoutId(right.attrs) && left.content.eq(right.content)
  }
  if (JSON.stringify(left.attrs) !== JSON.stringify(right.attrs)) return false
  if (left.isText || right.isText) return false
  for (let index = 0; index < left.childCount; index += 1) {
    if (!sameIgnoringHeadingIds(left.child(index), right.child(index))) return false
  }
  return true
}

/**
 * True when every step is a ReplaceAroundStep (setNodeMarkup) and the two
 * documents differ only in heading `id` attributes.
 */
export function isHeadingIdOnlyChange(transactions, oldDoc, newDoc) {
  if (!oldDoc || !newDoc || oldDoc.eq(newDoc)) return false
  const steps = (transactions || []).flatMap((transaction) => transaction?.steps || [])
  if (!steps.length || steps.some((step) => step?.constructor?.name !== 'ReplaceAroundStep')) return false
  return sameIgnoringHeadingIds(oldDoc, newDoc)
}

export { sameIgnoringHeadingIds }
