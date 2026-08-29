export const SOURCE_SYNC_TRANSACTION_JOURNAL_KIND = 'source-sync-transaction-journal'

const sameDocument = (left, right) => {
  if (left === right) return true
  if (!left || !right) return false
  return typeof left.eq === 'function' ? left.eq(right) : false
}

const rejected = (reason, {
  checkpoint = null,
  deferred = false,
  reset = false,
  proof = null
} = {}) => Object.freeze({
  ok: false,
  reason,
  checkpoint,
  deferred,
  reset,
  proof
})

const validSnapshot = (snapshot) => Boolean(
  snapshot &&
  Number.isInteger(snapshot.revision) &&
  snapshot.revision >= 0 &&
  typeof snapshot.source === 'string' &&
  typeof snapshot.canonical === 'string' &&
  typeof snapshot.sourceDigest === 'string' &&
  typeof snapshot.canonicalDigest === 'string' &&
  typeof snapshot.owner === 'string' &&
  typeof snapshot.family === 'string' &&
  typeof snapshot.reason === 'string'
)

const changedTransactions = (transactions) =>
  (transactions || []).filter((transaction) => transaction?.docChanged)

const stepDetail = (step) => Object.freeze({
  name: step?.constructor?.name || step?.toJSON?.()?.stepType || 'UnknownStep',
  from: Number.isFinite(step?.from) ? step.from : null,
  to: Number.isFinite(step?.to) ? step.to : null,
  structure: step?.structure === true,
  sliceSize: Number.isFinite(step?.slice?.size) ? step.slice.size : null
})

const createTransactionEntry = (transaction) => {
  const steps = Object.freeze([...(transaction?.steps || [])])
  const stepDocs = Object.freeze([...(transaction?.docs || [])])
  const stepMaps = Object.freeze([...(transaction?.mapping?.maps || [])])
  const stepDetails = Object.freeze(steps.map(stepDetail))
  return Object.freeze({
    beforeDoc: transaction?.before || null,
    afterDoc: transaction?.doc || null,
    steps,
    stepDocs,
    stepMaps,
    stepDetails,
    stepCount: steps.length,
    mapCount: stepMaps.length
  })
}

const validateTransactionChain = ({ transactions, oldDoc, newDoc }) => {
  const changed = changedTransactions(transactions)
  if (!changed.length) {
    return rejected('transaction-journal-no-document-change', { deferred: true })
  }
  if (!oldDoc || !newDoc) {
    return rejected('transaction-journal-document-missing', { reset: true })
  }

  let document = oldDoc
  const entries = []
  for (const transaction of changed) {
    if (transaction.before && !sameDocument(transaction.before, document)) {
      return rejected('transaction-journal-transaction-chain-mismatch', { reset: true })
    }
    if (!transaction.doc) {
      return rejected('transaction-journal-transaction-result-missing', { reset: true })
    }
    entries.push(createTransactionEntry(transaction))
    document = transaction.doc
  }
  if (!sameDocument(document, newDoc)) {
    return rejected('transaction-journal-batch-result-mismatch', { reset: true })
  }

  return Object.freeze({
    ok: true,
    changed,
    entries: Object.freeze(entries),
    transactionCount: changed.length,
    stepCount: entries.reduce((total, entry) => total + entry.stepCount, 0),
    mapCount: entries.reduce((total, entry) => total + entry.mapCount, 0)
  })
}

const snapshotMismatchReason = (checkpoint, snapshot) => {
  if (!validSnapshot(snapshot)) return 'transaction-journal-snapshot-missing'
  if (checkpoint.baseRevision !== snapshot.revision) {
    return 'transaction-journal-revision-stale'
  }
  if (
    checkpoint.baseSourceDigest !== snapshot.sourceDigest ||
    checkpoint.source !== snapshot.source
  ) return 'transaction-journal-source-stale'
  if (
    checkpoint.baseCanonicalDigest !== snapshot.canonicalDigest ||
    checkpoint.canonical !== snapshot.canonical
  ) return 'transaction-journal-canonical-stale'
  if (
    checkpoint.baseOwner !== snapshot.owner ||
    checkpoint.baseFamily !== snapshot.family ||
    checkpoint.baseReason !== snapshot.reason
  ) return 'transaction-journal-provenance-stale'
  return null
}

export function verifySourceSyncTransactionJournalCheckpoint({
  checkpoint,
  snapshot,
  expectedDoc = null
} = {}) {
  if (!checkpoint || checkpoint.kind !== SOURCE_SYNC_TRANSACTION_JOURNAL_KIND) {
    return rejected('transaction-journal-checkpoint-invalid', { reset: true })
  }
  const snapshotReason = snapshotMismatchReason(checkpoint, snapshot)
  if (snapshotReason) return rejected(snapshotReason, { checkpoint, reset: true })
  if (expectedDoc && !sameDocument(checkpoint.expectedDoc, expectedDoc)) {
    return rejected('transaction-journal-document-stale', { checkpoint, reset: true })
  }

  const proof = Object.freeze({
    kind: 'source-sync-transaction-journal-proof',
    journalId: checkpoint.journalId,
    baseRevision: checkpoint.baseRevision,
    baseSourceDigest: checkpoint.baseSourceDigest,
    baseCanonicalDigest: checkpoint.baseCanonicalDigest,
    baseOwner: checkpoint.baseOwner,
    baseFamily: checkpoint.baseFamily,
    baseReason: checkpoint.baseReason,
    batchCount: checkpoint.batchCount,
    transactionCount: checkpoint.transactionCount,
    stepCount: checkpoint.stepCount,
    mapCount: checkpoint.mapCount,
    stepNames: checkpoint.stepDetails.map((entry) => entry.name),
    snapshotMatched: true,
    documentMatched: expectedDoc ? true : null
  })
  return Object.freeze({ ok: true, checkpoint, proof })
}

export function transactionsFromSourceSyncTransactionJournal(checkpoint) {
  if (!checkpoint || checkpoint.kind !== SOURCE_SYNC_TRANSACTION_JOURNAL_KIND) {
    return Object.freeze([])
  }
  return Object.freeze((checkpoint.entries || []).map((entry) => Object.freeze({
    docChanged: true,
    before: entry.beforeDoc,
    doc: entry.afterDoc,
    steps: entry.steps,
    docs: entry.stepDocs,
    mapping: Object.freeze({ maps: entry.stepMaps })
  })))
}

export function mapPositionThroughSourceSyncTransactionJournal(
  checkpoint,
  position,
  assoc = 1
) {
  if (
    !checkpoint ||
    checkpoint.kind !== SOURCE_SYNC_TRANSACTION_JOURNAL_KIND ||
    !Number.isFinite(position)
  ) return null

  let mapped = position
  try {
    for (const entry of checkpoint.entries || []) {
      for (const stepMap of entry.stepMaps || []) {
        if (typeof stepMap?.map !== 'function') return null
        mapped = stepMap.map(mapped, assoc)
      }
    }
  } catch {
    return null
  }
  return mapped
}

export function createSourceSyncTransactionJournal({
  maxTransactions = 128,
  maxSteps = 512,
  maxMaps = 512
} = {}) {
  let sequence = 0

  const captureOrAdvance = ({
    checkpoint = null,
    snapshot,
    transactions,
    oldDoc,
    newDoc
  } = {}) => {
    if (!validSnapshot(snapshot)) {
      return rejected('transaction-journal-snapshot-missing', { checkpoint, reset: true })
    }

    if (checkpoint) {
      const verified = verifySourceSyncTransactionJournalCheckpoint({
        checkpoint,
        snapshot,
        expectedDoc: oldDoc
      })
      if (!verified.ok) return verified
    }

    const chain = validateTransactionChain({ transactions, oldDoc, newDoc })
    if (!chain.ok) {
      if (chain.deferred && checkpoint) {
        return Object.freeze({ ok: true, checkpoint })
      }
      return rejected(chain.reason, {
        checkpoint,
        deferred: chain.deferred,
        reset: chain.reset
      })
    }

    const transactionCount = (checkpoint?.transactionCount || 0) + chain.transactionCount
    const stepCount = (checkpoint?.stepCount || 0) + chain.stepCount
    const mapCount = (checkpoint?.mapCount || 0) + chain.mapCount
    if (
      transactionCount > maxTransactions ||
      stepCount > maxSteps ||
      mapCount > maxMaps
    ) {
      return rejected('transaction-journal-capacity-exceeded', {
        checkpoint,
        reset: true,
        proof: { transactionCount, stepCount, mapCount }
      })
    }

    const entries = Object.freeze([
      ...(checkpoint?.entries || []),
      ...chain.entries
    ])
    const stepDetails = Object.freeze([
      ...(checkpoint?.stepDetails || []),
      ...chain.entries.flatMap((entry) => entry.stepDetails)
    ])
    const batches = Object.freeze([
      ...(checkpoint?.batches || []),
      Object.freeze({
        transactionCount: chain.transactionCount,
        stepCount: chain.stepCount,
        mapCount: chain.mapCount,
        stepNames: Object.freeze(
          chain.entries.flatMap((entry) => entry.stepDetails.map((detail) => detail.name))
        )
      })
    ])

    const nextCheckpoint = Object.freeze({
      kind: SOURCE_SYNC_TRANSACTION_JOURNAL_KIND,
      journalId: checkpoint?.journalId || `source-sync-journal-${++sequence}`,
      baseRevision: checkpoint?.baseRevision ?? snapshot.revision,
      baseSourceDigest: checkpoint?.baseSourceDigest || snapshot.sourceDigest,
      baseCanonicalDigest: checkpoint?.baseCanonicalDigest || snapshot.canonicalDigest,
      baseOwner: checkpoint?.baseOwner ?? snapshot.owner,
      baseFamily: checkpoint?.baseFamily ?? snapshot.family,
      baseReason: checkpoint?.baseReason ?? snapshot.reason,
      source: checkpoint?.source ?? snapshot.source,
      canonical: checkpoint?.canonical ?? snapshot.canonical,
      oldDoc: checkpoint?.oldDoc || oldDoc,
      expectedDoc: newDoc,
      batchCount: (checkpoint?.batchCount || 0) + 1,
      transactionCount,
      chainLength: transactionCount,
      stepCount,
      mapCount,
      entries,
      stepDetails,
      batches
    })
    return Object.freeze({ ok: true, checkpoint: nextCheckpoint })
  }

  return Object.freeze({
    captureOrAdvance,
    verify: (options) => verifySourceSyncTransactionJournalCheckpoint(options),
    mapPosition: (checkpoint, position, assoc = 1) =>
      mapPositionThroughSourceSyncTransactionJournal(checkpoint, position, assoc)
  })
}
