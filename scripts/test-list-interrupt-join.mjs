// A list that cannot interrupt a paragraph (ordered start ≠ 1, empty first
// item) is written after a blank line, so it reads back as a list (fuzz seed
// 814: `1\.` + `2. /ol` flush inside a tight item lost the nested list).
import assert from 'node:assert/strict'
import { toMarkdown } from 'mdast-util-to-markdown'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { listInterruptJoin, listCanInterruptParagraph } from '../src/renderer/src/lib/list-interrupt-join.js'

const p = (text) => ({ type: 'paragraph', children: [{ type: 'text', value: text }] })
const item = (children, spread = false) => ({ type: 'listItem', spread, children })
const list = (items, ordered = false, start = 1) => ({ type: 'list', ordered, start, spread: false, children: items })
const shape = (node) => node.type === 'text' ? node.value : { type: node.type, ...(node.type === 'list' ? { ordered: node.ordered, start: node.ordered ? node.start : undefined } : {}), children: (node.children || []).map(shape) }

const cases = [
  { name: 'ordered list starting at 2 under an item paragraph', nested: list([item([p('b')])], true, 2), blank: true },
  { name: 'empty first item under an item paragraph', nested: list([item([]), item([p('b')])]), blank: true },
  { name: 'ordered list starting at 1 stays tight', nested: list([item([p('b')])], true, 1), blank: false },
  { name: 'bullet list stays tight', nested: list([item([p('b')])]), blank: false }
]
for (const testCase of cases) {
  const tree = { type: 'root', children: [list([item([p('a'), testCase.nested])], true, 1)] }
  const markdown = toMarkdown(tree, { join: [listInterruptJoin] })
  assert.equal(/a\n\n/.test(markdown), testCase.blank, `${testCase.name}: ${JSON.stringify(markdown)}`)
  assert.deepEqual(shape(fromMarkdown(markdown)), shape(tree), `${testCase.name}: reads back: ${JSON.stringify(markdown)}`)
  // Without the rule the first two lose their list (the bug).
  if (testCase.blank) assert.notDeepEqual(shape(fromMarkdown(toMarkdown(tree))), shape(tree), `${testCase.name}: default join was expected to fail`)
}
assert.equal(listCanInterruptParagraph({ type: 'paragraph' }), true)
console.log(`PASS list interrupt join: ${cases.length} cases — lists that cannot interrupt a paragraph get a blank line and read back as lists`)
