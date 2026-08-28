const rejected = (reason, proof = null) => Object.freeze({
  ok: false,
  reason,
  proof
})

export const sameSourceSyncDocument = (left, right) => {
  if (left === right) return true
  if (!left || !right) return false
  return typeof left.eq === 'function' ? left.eq(right) : false
}

export const stableSourceSyncAttrs = (attrs) => Object.fromEntries(
  Object.entries(attrs || {})
    .filter(([, value]) => value != null)
    .sort(([left], [right]) => left.localeCompare(right))
)

export const sourceSyncAttrsEqual = (left, right) =>
  JSON.stringify(stableSourceSyncAttrs(left)) ===
  JSON.stringify(stableSourceSyncAttrs(right))

export const topLevelSourceSyncEntries = (doc) => {
  const entries = []
  doc?.forEach?.((node, offset, index) => {
    entries.push(Object.freeze({
      node,
      offset,
      index,
      type: node?.type?.name || 'unknown'
    }))
  })
  return entries
}

export const onlyTopLevelSourceSyncIndexChanged = (beforeDoc, afterDoc, index) => {
  const before = topLevelSourceSyncEntries(beforeDoc)
  const after = topLevelSourceSyncEntries(afterDoc)
  if (before.length !== after.length || !before[index] || !after[index]) return false
  return before.every((entry, candidateIndex) =>
    candidateIndex === index || entry.node?.eq?.(after[candidateIndex]?.node) === true
  )
}

export function classifySingleTopLevelSubtreeChange({
  oldDoc,
  newDoc,
  expectedType = null,
  reasonPrefix = 'top-level-subtree'
} = {}) {
  if (!oldDoc || !newDoc) return rejected(`${reasonPrefix}-document-missing`)
  const before = topLevelSourceSyncEntries(oldDoc)
  const after = topLevelSourceSyncEntries(newDoc)
  let prefix = 0
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix].node?.eq?.(after[prefix].node) === true
  ) prefix += 1

  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix].node?.eq?.(
      after[after.length - 1 - suffix].node
    ) === true
  ) suffix += 1

  const beforeChanged = before.length - prefix - suffix
  const afterChanged = after.length - prefix - suffix
  if (beforeChanged !== 1 || afterChanged !== 1) {
    return rejected(`${reasonPrefix}-top-level-change-count`, {
      prefix,
      suffix,
      beforeChanged,
      afterChanged
    })
  }

  const previousEntry = before[prefix]
  const nextEntry = after[prefix]
  if (previousEntry.type !== nextEntry.type) {
    return rejected(`${reasonPrefix}-node-type-changed`, {
      previousType: previousEntry.type,
      nextType: nextEntry.type
    })
  }
  if (expectedType && previousEntry.type !== expectedType) {
    return rejected(`${reasonPrefix}-top-level-node-type`, {
      expectedType,
      actualType: previousEntry.type
    })
  }

  return Object.freeze({
    ok: true,
    topLevelIndex: prefix,
    previousEntry,
    nextEntry,
    unchangedPrefix: prefix,
    unchangedSuffix: suffix
  })
}
