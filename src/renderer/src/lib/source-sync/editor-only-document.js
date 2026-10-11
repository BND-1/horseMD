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

/**
 * Inclusive range of top-level child indexes (in `newDoc`) that differ between
 * two documents, found by trimming identical leading and trailing children.
 * Returns null when the documents are identical.
 */
export function changedTopLevelRange(oldDoc, newDoc) {
  if (!oldDoc || !newDoc) return null
  let from = 0
  const oldCount = oldDoc.childCount
  const newCount = newDoc.childCount
  const same = (left, right) => sameIgnoringHeadingIds(left, right)
  while (from < oldCount && from < newCount && same(oldDoc.child(from), newDoc.child(from))) from += 1
  if (from === oldCount && from === newCount) return null
  let oldTail = oldCount - 1
  let newTail = newCount - 1
  while (oldTail >= from && newTail >= from && same(oldDoc.child(oldTail), newDoc.child(newTail))) {
    oldTail -= 1
    newTail -= 1
  }
  return { from, to: Math.max(from, newTail) }
}

/**
 * Inclusive range of top-level child indexes of `doc` touched by the first
 * step of each transaction (positions resolved in the document each step was
 * applied to, which for the first changed step is `doc`). Returns null if no
 * step can be resolved.
 */
export function transactionTopLevelRange(transactions, doc) {
  let from = Infinity
  let to = -Infinity
  for (const transaction of transactions || []) {
    const step = transaction?.steps?.[0]
    const stepDoc = transaction?.docs?.[0]
    if (!step || !stepDoc || stepDoc !== doc) continue
    try {
      const start = stepDoc.resolve(Math.min(step.from, stepDoc.content.size))
      const end = stepDoc.resolve(Math.min(step.to ?? step.from, stepDoc.content.size))
      from = Math.min(from, start.index(0))
      to = Math.max(to, end.depth === 0 ? Math.max(0, end.index(0) - 1) : end.index(0))
    } catch {
      return null
    }
  }
  return Number.isFinite(from) ? { from, to: Math.max(from, to) } : null
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
