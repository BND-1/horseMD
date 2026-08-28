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
      beforePos: offset,
      contentStart: offset + 1,
      path: Object.freeze([index]),
      depth: 1,
      index,
      topLevelIndex: index,
      type: node?.type?.name || 'unknown'
    }))
  })
  return entries
}

const childOffsetAt = (node, targetIndex) => {
  let offset = 0
  for (let index = 0; index < targetIndex; index += 1) {
    offset += node.child(index).nodeSize
  }
  return offset
}

export const sourceSyncNodeEntryAtPath = (doc, path) => {
  if (!doc || !Array.isArray(path) || path.length === 0) return null
  let parent = doc
  let beforePos = 0
  for (let depth = 0; depth < path.length; depth += 1) {
    const index = path[depth]
    if (!Number.isInteger(index) || index < 0 || index >= parent.childCount) return null
    const childOffset = childOffsetAt(parent, index)
    beforePos = depth === 0
      ? childOffset
      : beforePos + 1 + childOffset
    parent = parent.child(index)
  }
  const frozenPath = Object.freeze([...path])
  return Object.freeze({
    node: parent,
    offset: beforePos,
    beforePos,
    contentStart: beforePos + 1,
    path: frozenPath,
    depth: frozenPath.length,
    index: frozenPath.at(-1),
    topLevelIndex: frozenPath[0],
    type: parent?.type?.name || 'unknown'
  })
}

export const sourceSyncResolvedPositionMatchesPath = ($position, path) => {
  if (
    !$position ||
    !Array.isArray(path) ||
    path.length === 0 ||
    $position.depth < path.length
  ) return false
  for (let depth = 0; depth < path.length; depth += 1) {
    if ($position.index(depth) !== path[depth]) return false
  }
  return true
}

const onlyPathChangedInNode = (beforeParent, afterParent, path, depth) => {
  if (
    !beforeParent ||
    !afterParent ||
    beforeParent.childCount !== afterParent.childCount
  ) return false
  const targetIndex = path[depth]
  if (
    !Number.isInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= beforeParent.childCount
  ) return false

  for (let index = 0; index < beforeParent.childCount; index += 1) {
    if (index === targetIndex) continue
    if (beforeParent.child(index).eq?.(afterParent.child(index)) !== true) return false
  }

  const beforeChild = beforeParent.child(targetIndex)
  const afterChild = afterParent.child(targetIndex)
  if (beforeChild?.type?.name !== afterChild?.type?.name) return false
  if (depth === path.length - 1) return true
  if (
    !sourceSyncAttrsEqual(beforeChild.attrs, afterChild.attrs) ||
    beforeChild.childCount !== afterChild.childCount
  ) return false
  return onlyPathChangedInNode(beforeChild, afterChild, path, depth + 1)
}

export const onlySourceSyncNodePathChanged = (beforeDoc, afterDoc, path) =>
  Boolean(
    beforeDoc &&
    afterDoc &&
    Array.isArray(path) &&
    path.length > 0 &&
    onlyPathChangedInNode(beforeDoc, afterDoc, path, 0)
  )

export const onlyTopLevelSourceSyncIndexChanged = (beforeDoc, afterDoc, index) =>
  onlySourceSyncNodePathChanged(beforeDoc, afterDoc, [index])

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

const collectAnchoredCandidates = ({
  oldDoc,
  newDoc,
  beforeNode,
  afterNode,
  path,
  expectedType,
  candidates
}) => {
  if (!beforeNode || !afterNode || beforeNode.type?.name !== afterNode.type?.name) return
  if (
    beforeNode.type?.name === expectedType &&
    beforeNode.eq?.(afterNode) !== true &&
    onlySourceSyncNodePathChanged(oldDoc, newDoc, path)
  ) {
    const previousEntry = sourceSyncNodeEntryAtPath(oldDoc, path)
    const nextEntry = sourceSyncNodeEntryAtPath(newDoc, path)
    if (previousEntry && nextEntry) {
      candidates.push(Object.freeze({ previousEntry, nextEntry }))
    }
  }
  if (beforeNode.childCount !== afterNode.childCount) return
  for (let index = 0; index < beforeNode.childCount; index += 1) {
    collectAnchoredCandidates({
      oldDoc,
      newDoc,
      beforeNode: beforeNode.child(index),
      afterNode: afterNode.child(index),
      path: [...path, index],
      expectedType,
      candidates
    })
  }
}

/**
 * Proves that one stable descendant path owns every change inside the sole
 * changed top-level subtree. The family is identified from ProseMirror node
 * paths and transaction documents, never from serialized Markdown shape.
 */
export function classifySingleAnchoredSubtreeChange({
  oldDoc,
  newDoc,
  expectedType,
  reasonPrefix = 'anchored-subtree'
} = {}) {
  if (!expectedType) return rejected(`${reasonPrefix}-expected-type-missing`)
  const topLevel = classifySingleTopLevelSubtreeChange({
    oldDoc,
    newDoc,
    reasonPrefix
  })
  if (!topLevel.ok) return topLevel

  const candidates = []
  collectAnchoredCandidates({
    oldDoc,
    newDoc,
    beforeNode: topLevel.previousEntry.node,
    afterNode: topLevel.nextEntry.node,
    path: [topLevel.topLevelIndex],
    expectedType,
    candidates
  })
  if (candidates.length !== 1) {
    return rejected(`${reasonPrefix}-anchored-target-count`, {
      expectedType,
      candidateCount: candidates.length,
      candidatePaths: candidates.map((candidate) => candidate.previousEntry.path)
    })
  }

  const candidate = candidates[0]
  return Object.freeze({
    ...topLevel,
    previousTopLevelEntry: topLevel.previousEntry,
    nextTopLevelEntry: topLevel.nextEntry,
    previousEntry: candidate.previousEntry,
    nextEntry: candidate.nextEntry,
    nodePath: candidate.previousEntry.path,
    targetDepth: candidate.previousEntry.depth
  })
}
