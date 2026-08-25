import assert from 'node:assert/strict'
import {
  TRANSACTION_FIRST_FAMILIES,
  TRANSACTION_FIRST_MODES,
  selectTransactionFirstPublication
} from '../src/renderer/src/lib/transaction-first-source-sync.js'

const family = TRANSACTION_FIRST_FAMILIES.PLAIN_PARAGRAPH_INLINE_REPLACE
const transaction = {
  ok: true,
  markdown: 'transaction-bytes',
  reason: 'plain-text-transactions',
  family
}
const legacy = { markdown: 'legacy-bytes', reason: 'legacy-fixture' }
const allowedFamilies = [family]

const decision = (overrides = {}) => selectTransactionFirstPublication({
  mode: TRANSACTION_FIRST_MODES.AUTHORITATIVE,
  snapshotMatched: true,
  transaction,
  family,
  allowedFamilies,
  legacyResult: legacy,
  fallbackSource: 'source-checkpoint',
  ...overrides
})

const owned = decision()
assert.equal(owned.authorityEligible, true)
assert.equal(owned.decisionReason, 'authority-owned')
assert.deepEqual(owned.publication, {
  owner: 'transaction',
  markdown: 'transaction-bytes',
  reason: 'plain-text-transactions'
})

for (const mode of [TRANSACTION_FIRST_MODES.SHADOW, TRANSACTION_FIRST_MODES.OBSERVE]) {
  const result = decision({ mode })
  assert.equal(result.authorityEligible, false)
  assert.equal(result.decisionReason, 'authority-disabled')
  assert.equal(result.publication.owner, 'legacy')
  assert.equal(result.publication.markdown, 'legacy-bytes')
}

const stale = decision({ snapshotMatched: false })
assert.equal(stale.decisionReason, 'authority-snapshot-stale')
assert.equal(stale.publication.owner, 'legacy')

const rejected = decision({
  transaction: { ...transaction, ok: false, reason: 'syntax-sensitive-insert' }
})
assert.equal(rejected.decisionReason, 'authority-transaction-rejected')
assert.equal(rejected.publication.owner, 'legacy')

const missingFamily = decision({ family: null })
assert.equal(missingFamily.decisionReason, 'authority-family-missing')
assert.equal(missingFamily.publication.owner, 'legacy')

const mismatchedFamily = decision({
  family: 'different-chain-family',
  allowedFamilies: [family, 'different-chain-family']
})
assert.equal(mismatchedFamily.decisionReason, 'authority-family-mismatch')
assert.equal(mismatchedFamily.publication.owner, 'legacy')

const unallowed = decision({ allowedFamilies: [] })
assert.equal(unallowed.decisionReason, 'authority-family-not-allowed')
assert.equal(unallowed.publication.owner, 'legacy')

const noLegacy = decision({ snapshotMatched: false, legacyResult: null })
assert.equal(noLegacy.decisionReason, 'authority-snapshot-stale')
assert.deepEqual(noLegacy.publication, {
  owner: 'source-checkpoint',
  markdown: 'source-checkpoint',
  reason: 'no-legacy-candidate'
})

const stringLegacy = decision({
  mode: TRANSACTION_FIRST_MODES.SHADOW,
  legacyResult: 'legacy-string-bytes'
})
assert.equal(stringLegacy.publication.owner, 'legacy')
assert.equal(stringLegacy.publication.markdown, 'legacy-string-bytes')
assert.equal(stringLegacy.publication.reason, 'legacy-string')

console.log('PASS transaction-first authority policy: explicit family allowlist owns; every missing proof falls back')
