// Inline math in table cells (lib/remark-table-math-pipes.js): `\|` reads as
// `|` (GitHub, markdown-it), `|` is written `\|`, the formula's own `\|` is
// written `\Vert`; every result reads back to the same formula and the table
// keeps its columns.
import assert from 'node:assert/strict'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { cellMathValue, inlineMathStringifyHandler, remarkTableMathPipes } from '../src/renderer/src/lib/remark-table-math-pipes.js'

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkTableMathPipes)
  .use(remarkStringify, { handlers: { inlineMath: inlineMathStringifyHandler } })
const parse = (md) => processor.runSync(processor.parse(md))
const maths = (tree) => {
  const out = []
  const walk = (n) => { if (n.type === 'inlineMath') out.push(n.value); (n.children || []).forEach(walk) }
  walk(tree)
  return out
}
const cells = (tree) => tree.children.find((n) => n.type === 'table')?.children.map((row) => row.children.length)

const table = (cell) => `| a | b |\n|---|---|\n| x | ${cell} |\n`

// Read.
assert.deepEqual(maths(parse(table('$\\left\\| x \\right\\|$'))), ['\\left| x \\right|'])
assert.deepEqual(maths(parse(table('$a \\\\ b$'))), ['a \\\\ b'], '\\\\ stays')
assert.deepEqual(maths(parse('$\\|x\\|$\n')), ['\\|x\\|'], 'outside a table nothing changes')

// Write and read back.
const cases = ['|x|', '\\left| x \\right|', '\\|x\\|', '\\|a', 'a \\\\ |b|', '\\{ x \\mid x > 0 \\}', '\\Vert x \\Vert']
for (const value of cases) {
  const tree = parse(table('$y$'))
  const cell = tree.children[0].children[1].children[1]
  cell.children = [{ type: 'inlineMath', value }]
  const md = processor.stringify(tree)
  const back = parse(md)
  assert.deepEqual(cells(back), [2, 2], `table split for ${value}: ${md}`)
  const read = maths(back)[0]
  assert.equal(read.replace(/\\Vert ?/g, '\\|'), value.replace(/\\Vert ?/g, '\\|'), `${value} → ${md} → ${read}`)
}
assert.equal(cellMathValue('\\|a'), '\\Vert a')
assert.equal(cellMathValue('\\|1'), '\\Vert1')

// Unchanged formulas are written with the same bytes (the table padding is
// remark's own; the editor's reprint keeps the authored row).
for (const math of ['$\\left\\| x \\right\\|$', '$\\{ x \\mid x > 0 \\}$']) {
  assert.ok(processor.stringify(parse(table(math))).includes(`| ${math} |`), math)
}
assert.equal(processor.stringify(parse('$\\|x\\|$\n')), '$\\|x\\|$\n')
console.log(`PASS table math pipes: read like GitHub / markdown-it, ${cases.length} formulas written and read back with the table intact`)
