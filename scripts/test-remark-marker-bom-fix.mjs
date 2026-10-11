// BOM files used to give every emphasis/strong mark a wrong `marker` (the
// character left of the delimiter), so canonical serialization replaced
// delimiters with spaces. remarkFixMarkerOffsetForBom must correct the marker
// whether it runs before or after Milkdown's remarkMarker transformer.
import assert from 'node:assert/strict'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { remarkFixMarkerOffsetForBom } from '../src/renderer/src/lib/remark-marker-bom-fix.js'

// Same logic as @milkdown/preset-commonmark's remarkMarker.
function milkdownRemarkMarker() {
  return (tree, file) => {
    const walk = (node) => {
      if (node.type === 'strong' || node.type === 'emphasis') {
        node.marker = file.value.charAt(node.position.start.offset)
      }
      for (const child of node.children || []) walk(child)
    }
    walk(tree)
  }
}

const markers = (tree) => {
  const out = []
  const walk = (node) => {
    if (node.type === 'strong' || node.type === 'emphasis') out.push(`${node.type}:${node.marker}`)
    for (const child of node.children || []) walk(child)
  }
  walk(tree)
  return out
}

const expected = ['emphasis:*', 'strong:*', 'emphasis:_']
for (const source of [
  '﻿title\n\nsome *ital* and **bold** and _und_ end\n',
  '﻿title\r\n\r\nsome *ital* and **bold** and _und_ end\r\n',
  'title\n\nsome *ital* and **bold** and _und_ end\n'
]) {
  for (const order of ['fix-first', 'fix-last']) {
    const processor = unified().use(remarkParse)
    if (order === 'fix-first') processor.use(remarkFixMarkerOffsetForBom).use(milkdownRemarkMarker)
    else processor.use(milkdownRemarkMarker).use(remarkFixMarkerOffsetForBom)
    // Milkdown's parser: runSync(parse(text), text) — the transform phase sees
    // the ORIGINAL text, BOM included.
    const tree = processor.runSync(processor.parse(source), source)
    assert.deepEqual(markers(tree), expected, `${order} ${JSON.stringify(source.slice(0, 8))}`)
  }
}

// Without the fix the bug reproduces (guards against the test going vacuous).
{
  const processor = unified().use(remarkParse).use(milkdownRemarkMarker)
  const source = '﻿some *ital* end\n'
  const tree = processor.runSync(processor.parse(source), source)
  assert.deepEqual(markers(tree), ['emphasis: '])
}

console.log('PASS remark marker BOM fix: emphasis/strong markers stay * / _ in BOM (LF and CRLF) files regardless of transformer order; unfixed BOM still reproduces the space marker')
