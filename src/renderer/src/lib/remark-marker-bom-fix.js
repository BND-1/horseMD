// Milkdown's `remarkMarker` stores the emphasis/strong delimiter as
// `file.value.charAt(node.position.start.offset)`. micromark's offsets do not
// count a leading U+FEFF BOM, but Milkdown's parser hands the ORIGINAL text
// (BOM included) to the transform phase, so every marker in a BOM file read the
// character one to the left — usually a space. The live document then carried
// `marker: " "`, and the canonical serializer printed `some  ital  and   bold`
// (delimiters replaced by spaces): every comparison against canonical saw a
// diverged document, and any canonical write would drop the formatting.
//
// This transformer is order-independent: it strips the BOM from `file.value`
// (so a later remarkMarker reads aligned offsets) AND recomputes the marker
// from the BOM-free text (so an earlier remarkMarker's result is corrected).
// Only `*` / `_` are accepted; anything else keeps the existing attribute.

const DELIMITERS = new Set(['*', '_'])

const visit = (node, callback) => {
  callback(node)
  if (Array.isArray(node?.children)) {
    for (const child of node.children) visit(child, callback)
  }
}

export function remarkFixMarkerOffsetForBom() {
  return (tree, file) => {
    const raw = typeof file?.value === 'string' ? file.value : String(file?.value ?? '')
    if (!raw.startsWith('﻿')) return
    const value = raw.slice(1)
    if (file) file.value = value
    visit(tree, (node) => {
      if (node?.type !== 'strong' && node?.type !== 'emphasis') return
      const offset = node.position?.start?.offset
      if (!Number.isInteger(offset)) return
      const marker = value.charAt(offset)
      if (DELIMITERS.has(marker)) node.marker = marker
    })
  }
}
