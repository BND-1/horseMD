// Caret mapping through an external rewrite (#158): before / after / inside
// the changed region.
import assert from 'node:assert/strict'
import { mapOffsetThroughChange as map } from '../src/renderer/src/lib/offset-through-change.js'

const a = 'aaa\nBBB\nccc\n'
const b = 'aaa\nXXXXX\nccc\n'
assert.equal(map(a, b, 2), 2, 'before the change')
assert.equal(map(a, b, 10), 12, 'after the change: shifted by +2')
assert.equal(map(a, b, a.length), b.length, 'end of document')
assert.equal(map(a, b, 5), 5, 'inside the change keeps its distance')
assert.equal(map('xyz', 'x', 2), 1, 'inside a deletion clamps to the region')
assert.equal(map(a, a, 7), 7, 'unchanged')
assert.equal(map(a, b, null), null)
assert.equal(map(a, b, 999), b.length, 'clamped')
// Insertion before the caret line.
assert.equal(map('l1\nl2\nl3', 'l0\nl1\nl2\nl3', 6), 9)
console.log('PASS offset through change')
