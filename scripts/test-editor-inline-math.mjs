import assert from 'node:assert/strict'
import {
  findInlineMathSpans,
  inlineMathAtCaret
} from '../src/renderer/src/components/editor-inline-math.js'

assert.deepEqual(findInlineMathSpans('abc$1^2$def'), [
  { from: 3, to: 8, value: '1^2' }
])
assert.equal(inlineMathAtCaret('abc$123$def', 6)?.value, '123')
assert.equal(inlineMathAtCaret('abc$1^2$def', 3), null)
assert.equal(inlineMathAtCaret('abc$1^2$def', 8), null)
assert.deepEqual(findInlineMathSpans('$$x^2$$'), [])
assert.deepEqual(findInlineMathSpans('cost \\$5 and $$'), [])
assert.deepEqual(findInlineMathSpans('$a$ and $b_2$'), [
  { from: 0, to: 3, value: 'a' },
  { from: 8, to: 13, value: 'b_2' }
])

console.log('PASS inline math: complete pairs, digits, escapes, display math, and caret bounds')
