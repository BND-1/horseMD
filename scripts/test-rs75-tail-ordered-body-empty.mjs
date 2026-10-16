import assert from 'node:assert/strict'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'

const source = '# t\n\n- authored-divergence\n\n1. \n\n1) 测试\n'
const previous = '# t\n\n* canonical-divergence\n\n1. <br />\n\n1) 测试\n\n'

const bodyEmptied = preserveRichMarkdownSource(
  source,
  previous,
  '# t\n\n* canonical-divergence\n\n1. <br />\n\n1) <br />\n\n'
)
assert.equal(bodyEmptied.preserved, true)
assert.equal(
  bodyEmptied.markdown,
  '# t\n\n- authored-divergence\n\n1. \n\n1) \n',
  'emptying the final ordered item body must preserve both adjacent empty ordered slots'
)
assert.equal(
  bodyEmptied.reason,
  'diverged-nested-list-change',
  'same-slot body empty must fall through to the existing list mapper instead of whole-row delete'
)

const rowDeleted = preserveRichMarkdownSource(
  source,
  previous,
  '# t\n\n* canonical-divergence\n\n1. <br />\n\n'
)
assert.equal(rowDeleted.preserved, true)
assert.equal(
  rowDeleted.markdown,
  '# t\n\n- authored-divergence\n\n1. \n',
  'a genuine final ordered-row deletion must still remove that authored row'
)
assert.equal(
  rowDeleted.reason,
  'diverged-tail-line-delete',
  'the RS-75 veto must not steal genuine whole-row deletion'
)

console.log('PASS RS-75: adjacent empty ordered slots distinguish body-empty from whole-row delete')
