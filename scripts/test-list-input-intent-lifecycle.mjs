import assert from 'node:assert/strict'
import {
  hasBlockingSourceSyncListInputIntent,
  isSourceSyncListInputIntentActive,
  sourceSyncListInputIntentBlocksStructuralJournal
} from '../src/renderer/src/lib/source-sync/list-input-intent-lifecycle.js'

const now = 10_000
const active = { type: 'ordered-list', marker: '1.', at: 9_000, batchUntil: 12_000 }
assert.equal(isSourceSyncListInputIntentActive(active, now), true)
assert.equal(sourceSyncListInputIntentBlocksStructuralJournal(active, now), true)

assert.equal(sourceSyncListInputIntentBlocksStructuralJournal(active, 12_001), false,
  'expired intent must not block journal')
assert.equal(sourceSyncListInputIntentBlocksStructuralJournal({ type: 'other', at: 9_000 }, now), false)
assert.equal(sourceSyncListInputIntentBlocksStructuralJournal(null, now), false)

const expired = { type: 'bullet-list', marker: '-', at: 5_000, batchUntil: 6_000 }
const olderActive = { type: 'bullet-list', marker: '-', at: 9_500, batchUntil: 10_500 }
assert.equal(hasBlockingSourceSyncListInputIntent([olderActive], expired, now), true,
  'an earlier active intent in the same batch must still block')
assert.equal(hasBlockingSourceSyncListInputIntent([expired], expired, now), false,
  'a duplicate expired current intent must not block')
assert.equal(hasBlockingSourceSyncListInputIntent([], expired, now), false)
assert.equal(hasBlockingSourceSyncListInputIntent([], active, now), true)

console.log('PASS list input intent lifecycle: active intents block structural journal, expired and non-list intents do not, while any active intent in the batch still blocks')
