import assert from 'node:assert/strict'
import { publishPendingSourceSyncJournalForFlush } from '../src/renderer/src/lib/source-sync/index.js'

const doc = Object.freeze({ id: 'live-doc' })

{
  const calls = []
  const result = publishPendingSourceSyncJournalForFlush({
    generatedScratch: false,
    canonical: 'same-canonical\n',
    expectedDoc: doc,
    publishPendingTransactionJournal: (input) => {
      calls.push(input)
      return {
        attempted: true,
        ok: true,
        markdown: 'same-source\n',
        family: 'table-column-width',
        reason: 'table-column-width-changed'
      }
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.markdown, 'same-source\n')
  assert.deepEqual(calls, [{
    canonical: 'same-canonical\n',
    expectedDoc: doc,
    notifyChange: false
  }])
}

{
  let calls = 0
  const result = publishPendingSourceSyncJournalForFlush({
    generatedScratch: true,
    canonical: 'scratch\n',
    expectedDoc: doc,
    publishPendingTransactionJournal: () => {
      calls += 1
      return { attempted: true, ok: true, markdown: 'wrong\n' }
    }
  })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'generated-scratch-authority')
  assert.equal(calls, 0, 'generated scratch must not delegate source authority')
}

{
  const result = publishPendingSourceSyncJournalForFlush({
    canonical: 'same\n',
    expectedDoc: doc
  })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'pending-transaction-journal-unavailable')
}

{
  const result = publishPendingSourceSyncJournalForFlush({
    canonical: 'same\n',
    expectedDoc: doc,
    publishPendingTransactionJournal: () => ({ attempted: false, ok: false })
  })
  assert.deepEqual(result, { attempted: false, ok: false })
}

{
  const result = publishPendingSourceSyncJournalForFlush({
    canonical: 'same\n',
    expectedDoc: doc,
    publishPendingTransactionJournal: () => null
  })
  assert.equal(result.attempted, true)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'pending-transaction-journal-invalid-result')
}

console.log('PASS editor-api transaction flush policy: canonical-unchanged PM metadata delegates to the shared journal before committed-baseline handling, while generated scratch and missing publishers stay isolated')
