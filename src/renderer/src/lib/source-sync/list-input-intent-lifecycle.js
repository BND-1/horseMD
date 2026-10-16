const SUPPORTED_TYPES = new Set(['bullet-list', 'ordered-list'])

export const isSourceSyncListInputIntentActive = (intent, now = Date.now()) => {
  if (!intent || !SUPPORTED_TYPES.has(intent.type)) return false
  const expiresAt = Number.isFinite(intent.batchUntil)
    ? intent.batchUntil
    : Number(intent.at || 0) + 3000
  return Number.isFinite(expiresAt) && now < expiresAt
}

export const sourceSyncListInputIntentBlocksStructuralJournal = (intent, now = Date.now()) =>
  isSourceSyncListInputIntentActive(intent, now) && intent?.consumed !== true

export const markSourceSyncListInputIntentConsumed = (intent, callbackTailUntil) => {
  if (!intent || !Number.isFinite(callbackTailUntil)) return intent
  return {
    ...intent,
    consumed: true,
    consumedAt: Date.now(),
    batchUntil: Math.min(
      Number.isFinite(intent.batchUntil) ? intent.batchUntil : callbackTailUntil,
      callbackTailUntil
    )
  }
}

export const hasBlockingSourceSyncListInputIntent = (intents, currentIntent, now = Date.now()) => {
  const seen = new Set()
  for (const intent of [...(Array.isArray(intents) ? intents : []), currentIntent]) {
    if (!intent || seen.has(intent)) continue
    seen.add(intent)
    if (sourceSyncListInputIntentBlocksStructuralJournal(intent, now)) return true
  }
  return false
}
