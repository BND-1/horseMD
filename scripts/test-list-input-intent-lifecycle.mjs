import assert from 'node:assert/strict'
import {
  hasBlockingSourceSyncListInputIntent,
  isSourceSyncListInputIntentActive,
  markSourceSyncListInputIntentConsumed,
  sourceSyncListInputIntentBlocksStructuralJournal
} from '../src/renderer/src/lib/source-sync/list-input-intent-lifecycle.js'

const now = 10_000
const active = { type: 'ordered-list', marker: '1.', at: 9_000, batchUntil: 12_000 }
assert.equal(isSourceSyncListInputIntentActive(active, now), true)
assert.equal(sourceSyncListInputIntentBlocksStructuralJournal(active, now), true)

const consumed = markSourceSyncListInputIntentConsumed(active, 10_750)
assert.equal(consumed.consumed, true)
assert.equal(consumed.batchUntil, 10_750)
assert.equal(isSourceSyncListInputIntentActive(consumed, now), true)
assert.equal(sourceSyncListInputIntentBlocksStructuralJournal(consumed, now), false,
  'consumed callback-tail intent must not own a later structural transaction')

assert.equal(sourceSyncListInputIntentBlocksStructuralJournal(active, 12_001), false,
  'expired intent must not block journal')
assert.equal(sourceSyncListInputIntentBlocksStructuralJournal({ type: 'other', at: 9_000 }, now), false)
assert.equal(sourceSyncListInputIntentBlocksStructuralJournal(null, now), false)

const olderUnconsumed = { type: 'bullet-list', marker: '-', at: 9_500, batchUntil: 10_500 }
assert.equal(hasBlockingSourceSyncListInputIntent([olderUnconsumed], consumed, now), true,
  'an earlier unconsumed intent in the same batch must still block')
assert.equal(hasBlockingSourceSyncListInputIntent([consumed], consumed, now), false,
  'duplicate consumed current intent must not block')
assert.equal(hasBlockingSourceSyncListInputIntent([], consumed, now), false)
assert.equal(hasBlockingSourceSyncListInputIntent([], active, now), true)

console.log('PASS list input intent lifecycle: active unconsumed intents block structural journal, consumed callback-tail and expired intents do not, while any unconsumed intent in the batch still blocks')
