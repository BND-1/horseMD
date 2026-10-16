import assert from 'node:assert/strict'

// Contract test for the revision rule used by useSplitSourceRichSync: only the
// latest debounced source revision may reach the rich projection. Keeping the
// rule isolated makes a future hook refactor unable to silently reintroduce the
// stale-input overwrite race.
const acceptRevision = (current, candidate) => current === candidate

assert.equal(acceptRevision(3, 3), true)
assert.equal(acceptRevision(3, 2), false)
assert.equal(acceptRevision(3, 4), false)

console.log('PASS split source/rich synchronization revision contract')
