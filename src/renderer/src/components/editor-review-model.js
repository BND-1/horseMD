export function closeReviewGroupState() {
  return { openGroupKey: null, activeKey: null, activeIndex: 0 }
}

export function makeReviewTextblockGroupKey(start) {
  return `textblock:${start}`
}

function parseReviewTextblockGroupStart(groupKey) {
  const match = String(groupKey || '').match(/^textblock:(\d+)$/)
  return match ? Number(match[1]) : null
}

function compareReviewAnnotations(a, b) {
  return (
    (a?.from ?? 0) - (b?.from ?? 0) ||
    (a?.to ?? 0) - (b?.to ?? 0) ||
    String(a?.key || '').localeCompare(String(b?.key || ''))
  )
}

export function groupReviewAnnotationParts(widgetParts) {
  const passthrough = []
  const groups = new Map()

  for (const item of widgetParts || []) {
    const part = item?.part
    if (part?.role !== 'comment-margin' || !part.annotation || !part.groupKey) {
      passthrough.push(item)
      continue
    }

    const existing = groups.get(part.groupKey) || {
      pos: item.pos,
      part: {
        type: 'widget',
        role: 'comment-margin',
        groupKey: part.groupKey,
        annotations: []
      }
    }

    existing.pos = Math.min(existing.pos, item.pos)
    existing.part.annotations.push(part.annotation)
    groups.set(part.groupKey, existing)
  }

  const grouped = [...groups.values()].map((group) => {
    const annotations = [...group.part.annotations].sort(compareReviewAnnotations)
    return {
      pos: group.pos,
      part: {
        ...group.part,
        annotations,
        annotation: annotations[0] || null,
        label: String(annotations.length),
        title: annotations[0]?.comment || ''
      }
    }
  })

  const sorted = [...passthrough, ...grouped].sort((a, b) => {
    const posDelta = (a?.pos ?? 0) - (b?.pos ?? 0)
    if (posDelta) return posDelta
    return String(a?.part?.role || '').localeCompare(String(b?.part?.role || ''))
  })
  let seq = 0
  for (const item of sorted) {
    if (item?.part?.role === 'comment-margin') {
      seq += 1
      item.part.label = String(seq)
    }
  }
  return sorted
}

export function resolveReviewGroupActiveIndex(annotations, activeKey, preferredIndex = 0) {
  const list = Array.isArray(annotations) ? annotations : []
  if (!list.length) return -1

  if (activeKey) {
    const keyedIndex = list.findIndex((annotation) => annotation?.key === activeKey)
    if (keyedIndex >= 0) return keyedIndex
  }

  if (!Number.isInteger(preferredIndex)) return 0
  return Math.max(0, Math.min(preferredIndex, list.length - 1))
}

export function cycleReviewGroupActiveIndex(currentIndex, count, direction) {
  if (!Number.isInteger(count) || count <= 0) return -1
  const step = direction < 0 ? -1 : 1
  const index = Number.isInteger(currentIndex) ? currentIndex : 0
  return ((index + step) % count + count) % count
}

export function normalizeReviewPluginState(pluginState) {
  return {
    openGroupKey: pluginState?.openGroupKey || null,
    activeKey: pluginState?.activeKey || null,
    activeIndex: Number.isInteger(pluginState?.activeIndex) ? pluginState.activeIndex : 0
  }
}

export function mapReviewTextblockGroupState(pluginState, mapping, docSize) {
  const state = normalizeReviewPluginState(pluginState)
  const start = parseReviewTextblockGroupStart(state.openGroupKey)
  if (!Number.isInteger(start)) return closeReviewGroupState()

  const result = mapping?.mapResult?.(start, -1)
  if (!result || result.deleted) return closeReviewGroupState()

  const mappedPos = result.pos
  if (
    !Number.isInteger(mappedPos) ||
    mappedPos < 0 ||
    (Number.isInteger(docSize) && mappedPos > docSize)
  ) {
    return closeReviewGroupState()
  }

  return {
    ...state,
    openGroupKey: makeReviewTextblockGroupKey(mappedPos)
  }
}

export function getReviewGroupRemovalMeta(part) {
  const annotations = Array.isArray(part?.annotations)
    ? part.annotations
    : part?.annotation
      ? [part.annotation]
      : []
  if (!part?.groupKey || annotations.length <= 1) return { type: 'close' }

  const currentIndex = Number.isInteger(part.activeIndex)
    ? Math.max(0, Math.min(part.activeIndex, annotations.length - 1))
    : 0

  return {
    type: 'activate',
    groupKey: part.groupKey,
    activeKey: null,
    activeIndex: Math.min(currentIndex, annotations.length - 2)
  }
}

export function parseParsedHighlightCommentClose(text) {
  const match = String(text || '').match(/^([ \t]*)\}\{>>([\s\S]*?)<<\}/)
  if (!match || !match[2]) return null
  return {
    leadingText: match[1],
    comment: match[2],
    length: match[0].length,
    syntaxStart: match[1].length
  }
}
