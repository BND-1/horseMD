import { createPmPosToMarkdownOffsetMapper } from './editor-source-map.js'

// A synchronous publication may ask many owners for offsets in the same
// immutable document/source pair. Reuse its prepared map within that call,
// never across callbacks, revisions, editors or changed remark settings.
export function createScopedMarkdownOffsetResolver(createMapper = createPmPosToMarkdownOffsetMapper) {
  let entries = null
  const resolve = ({ markdown, pmPos, doc, remark }) => {
    let entry = entries?.find((item) => item.markdown === markdown && item.doc === doc && item.remark === remark)
    if (!entry) {
      entry = { markdown, doc, remark, map: createMapper(markdown, doc, remark) }
      if (entries) {
        if (entries.length >= 4) entries.shift()
        entries.push(entry)
      }
    }
    return entry.map ? entry.map(pmPos) : null
  }
  const run = (operation) => {
    const previous = entries
    entries = []
    try {
      return operation()
    } finally {
      // Also release large AST/PM references when validation or serialization
      // throws. Nested synchronous publication restores its parent's scope.
      entries = previous
    }
  }
  return { resolve, run }
}
