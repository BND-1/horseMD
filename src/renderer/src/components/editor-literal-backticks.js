const rawSlice = (source, position) => {
  const start = position?.start?.offset
  const end = position?.end?.offset
  if (
    typeof source !== 'string' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 || end <= start || end > source.length
  ) return null
  return source.slice(start, end)
}

const isExactTripleBacktickSpan = (raw) => Boolean(
  typeof raw === 'string' &&
  raw.length > 6 &&
  !raw.includes('\n') &&
  !raw.includes('\r') &&
  raw.startsWith('```') &&
  raw.endsWith('```') &&
  raw[3] !== '`' &&
  raw[raw.length - 4] !== '`'
)

const isBareTripleBacktickFence = (node, raw) => Boolean(
  node?.type === 'code' &&
  node.lang == null &&
  node.meta == null &&
  node.value === '' &&
  /^```(?:\r\n|\n|\r)?$/.test(raw || '')
)

const literalBacktickPosition = (position) => {
  const start = position?.start
  if (!Number.isInteger(start?.offset)) return position
  return {
    start: { ...start },
    end: {
      line: start.line,
      column: start.column + 3,
      offset: start.offset + 3
    }
  }
}

// HorseMD's incremental input contract deliberately keeps a whole-line
// ` ```content``` ` run as literal prose. CommonMark reparses the same bytes as
// an inline-code span, so save/reopen otherwise changes the visible document.
// Restore only the exact shapes produced by that contract: a paragraph/heading
// containing one triple-delimited inlineCode child, or the intermediate bare
// ` ``` ` line that CommonMark represents as an unterminated empty fence.
// Embedded spans, single/double/four-backtick code, fences with info/content,
// closed fences, and tilde fences are untouched.
export function normalizeLiteralTripleBacktickTextBlocks(tree, source) {
  if (!tree || typeof tree !== 'object' || typeof source !== 'string') return tree

  const visit = (node) => {
    if (!node || typeof node !== 'object') return

    const nodeRaw = rawSlice(source, node.position)
    if (isBareTripleBacktickFence(node, nodeRaw)) {
      const position = literalBacktickPosition(node.position)
      node.type = 'paragraph'
      node.children = [{ type: 'text', value: '```', position }]
      node.position = position
      delete node.lang
      delete node.meta
      delete node.value
    }

    if (
      (node.type === 'paragraph' || node.type === 'heading') &&
      Array.isArray(node.children) &&
      node.children.length === 1 &&
      node.children[0]?.type === 'inlineCode'
    ) {
      const child = node.children[0]
      const raw = rawSlice(source, child.position)
      if (isExactTripleBacktickSpan(raw)) {
        node.children = [{
          type: 'text',
          value: raw,
          position: child.position
        }]
      }
    }
    if (Array.isArray(node.children)) node.children.forEach(visit)
  }

  visit(tree)
  return tree
}

const sourceFromVFile = (file) => {
  if (typeof file?.value === 'string') return file.value
  if (typeof file?.toString === 'function') {
    const source = file.toString()
    if (typeof source === 'string') return source
  }
  return ''
}

export function remarkPreserveLiteralTripleBacktickTextBlocks() {
  return (tree, file) => {
    const source = sourceFromVFile(file)
    const result = normalizeLiteralTripleBacktickTextBlocks(tree, source)
    if (Array.isArray(globalThis.__hmLiteralBacktickParserTrace)) {
      const textblock = result?.children?.find?.((node) =>
        node?.type === 'paragraph' || node?.type === 'heading'
      )
      globalThis.__hmLiteralBacktickParserTrace.push({
        valueType: typeof file?.value,
        fileType: file?.constructor?.name || null,
        sourceLength: source.length,
        source: source.length <= 200 ? source : null,
        firstTextblockType: textblock?.type || null,
        firstTextblockChildType: textblock?.children?.[0]?.type || null,
        firstTextblockChildValue: textblock?.children?.[0]?.value || null
      })
      if (globalThis.__hmLiteralBacktickParserTrace.length > 50) {
        globalThis.__hmLiteralBacktickParserTrace.shift()
      }
    }
    return result
  }
}
