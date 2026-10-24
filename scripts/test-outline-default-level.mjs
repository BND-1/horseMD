// Outline default expansion level + per-document fold memory (#122).
import assert from 'node:assert/strict'
import {
  collapseAllEntry,
  defaultCollapsedHeadings,
  expandAllEntry,
  outlineStructure,
  recordFoldEntry,
  resolveCollapsedHeadings
} from '../src/renderer/src/components/outline-model.js'

const h = (...levels) => levels.map((level, i) => ({ level, text: `h${i}` }))
const sorted = (set) => [...set].sort((a, b) => a - b)

// H1 > H2 > H3 > H4, then H2 > H3.
const deep = h(1, 2, 3, 4, 2, 3)
assert.deepEqual(sorted(defaultCollapsedHeadings(deep, 1)), [0, 1, 2, 4])
assert.deepEqual(sorted(defaultCollapsedHeadings(deep, 2)), [1, 2, 4])
assert.deepEqual(sorted(defaultCollapsedHeadings(deep)), [1, 2, 4], 'default stays two tiers')
assert.deepEqual(sorted(defaultCollapsedHeadings(deep, 3)), [2])
assert.deepEqual(sorted(defaultCollapsedHeadings(deep, 4)), [])
assert.deepEqual(sorted(defaultCollapsedHeadings(deep, 0)), [], '0 = all expanded')

// Document starting at H2: tiers follow hierarchy depth, not level numbers.
const fromH2 = h(2, 3, 4, 2, 3)
assert.deepEqual(sorted(defaultCollapsedHeadings(fromH2, 1)), [0, 1, 3])
assert.deepEqual(sorted(defaultCollapsedHeadings(fromH2, 2)), [1])
assert.deepEqual(sorted(defaultCollapsedHeadings(fromH2, 3)), [])
assert.deepEqual(sorted(defaultCollapsedHeadings(fromH2, 0)), [])

// Skipped levels: H1 > H3 > H5 is three tiers.
const skipped = h(1, 3, 5, 3)
assert.deepEqual(sorted(defaultCollapsedHeadings(skipped, 1)), [0, 1])
assert.deepEqual(sorted(defaultCollapsedHeadings(skipped, 2)), [1])
assert.deepEqual(sorted(defaultCollapsedHeadings(skipped, 3)), [])

// Flat H1 document: nothing has children, everything stays visible.
const flat = h(1, 1, 1)
for (const tiers of [1, 2, 3, 4, 0]) {
  assert.deepEqual(sorted(defaultCollapsedHeadings(flat, tiers)), [], `flat doc tiers ${tiers}`)
}
assert.deepEqual(sorted(defaultCollapsedHeadings([], 1)), [])

// Structural paths.
assert.deepEqual(outlineStructure(deep).map((item) => item.path), ['1', '1.1', '1.1.1', '1.1.1.1', '1.2', '1.2.1'])

// No memory → default level.
assert.deepEqual(sorted(resolveCollapsedHeadings(deep, null, 2)), [1, 2, 4])
assert.deepEqual(sorted(resolveCollapsedHeadings(deep, null, 0)), [])

// Expand / collapse all entries ignore the default level.
assert.deepEqual(sorted(resolveCollapsedHeadings(deep, expandAllEntry(), 1)), [])
assert.deepEqual(sorted(resolveCollapsedHeadings(deep, collapseAllEntry(), 0)), [0, 1, 2, 4])

// A manual toggle records every visible foldable heading; text edits (same
// structure) keep it.
const afterToggle = recordFoldEntry(deep, new Set([2, 4]), null)
assert.deepEqual(sorted(resolveCollapsedHeadings(deep, afterToggle, 2)), [2, 4])
const renamed = deep.map((item) => ({ ...item, text: item.text + ' edited' }))
assert.deepEqual(sorted(resolveCollapsedHeadings(renamed, afterToggle, 2)), [2, 4])

// A branch added later uses the default level; recorded branches keep their state.
const grown = h(1, 2, 3, 4, 2, 3, 2, 3)
assert.deepEqual(sorted(resolveCollapsedHeadings(grown, afterToggle, 2)), [2, 4, 6])

// After expand all, new branches stay expanded; a later toggle keeps that rest.
const expanded = recordFoldEntry(deep, new Set([1]), expandAllEntry())
assert.deepEqual(sorted(resolveCollapsedHeadings(grown, expanded, 2)), [1])
const collapsedThenOpened = recordFoldEntry(deep, new Set([0, 1, 2]), collapseAllEntry())
assert.deepEqual(sorted(resolveCollapsedHeadings(grown, collapsedThenOpened, 2)), [0, 1, 2, 6])

console.log('outline default level: ok')
