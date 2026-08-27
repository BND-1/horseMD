import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'

export const SLASH_BLOCK_SOURCE_SYNC_BOUNDARY = 'slash-code-block-atomic'

export const isSlashBlockSourceCommand = (id) => {
  const value = typeof id === 'string' ? id : ''
  return value === 'code' || value === 'math' || value.startsWith('code:')
}

const rejected = (reason, { deferred = false, proof = null } = {}) => Object.freeze({
  ok: false,
  deferred,
  reason,
  proof
})

const validCapturedIntent = (intent) => Boolean(
  intent &&
  typeof intent.id === 'string' &&
  typeof intent.source === 'string' &&
  Number.isInteger(intent.rawStart) &&
  Number.isInteger(intent.rawEnd) &&
  intent.rawStart >= 0 &&
  intent.rawEnd >= intent.rawStart &&
  intent.rawEnd <= intent.source.length &&
  typeof intent.lineEnding === 'string' &&
  typeof intent.query === 'string'
)

export function findSlashCodeBlockAtSelection(selection) {
  const $from = selection?.$from
  if (!$from || !Number.isInteger($from.depth) || typeof $from.node !== 'function') return null
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const candidate = $from.node(depth)
    if (candidate?.type?.name === 'code_block') return candidate
  }
  return null
}

/**
 * Behavior-preserving owner for the two-phase Slash code/math command.
 *
 * The owner plans a legacy SourceSync candidate; Editor still performs Crepe
 * serialization and Coordinator publication. Keeping those host concerns out
 * of this module makes token ownership, staging and fail-closed rules directly
 * testable without changing the existing authority policy.
 */
export function createSlashBlockSourceSyncOwner({
  preserve,
  captureIntent,
  applyIntent
} = {}) {
  for (const [name, value] of Object.entries({ preserve, captureIntent, applyIntent })) {
    if (typeof value !== 'function') {
      throw new TypeError(`slash block source-sync owner requires ${name}`)
    }
  }

  const capture = ({
    id,
    source,
    previousCanonical,
    canonical,
    queryText,
    sourceOffset = null,
    resolveSourceOffset = null
  } = {}) => {
    if (!isSlashBlockSourceCommand(id)) {
      return rejected('slash-block-owner-deferred', { deferred: true })
    }
    if (
      typeof source !== 'string' ||
      typeof previousCanonical !== 'string' ||
      typeof canonical !== 'string'
    ) {
      return rejected('slash-block-capture-incomplete')
    }

    let authoredSource = source
    let canonicalBaseline = previousCanonical
    let staged = false
    let stageReason = null
    if (canonical !== previousCanonical) {
      let stagedResult
      try {
        stagedResult = preserve(source, previousCanonical, canonical)
      } catch (error) {
        return rejected(`slash-block-stage-threw:${error?.name || 'Error'}`)
      }
      if (stagedResult?.preserved === false) {
        return rejected(stagedResult.reason || 'slash-block-stage-rejected')
      }
      if (!stagedResult || typeof stagedResult.markdown !== 'string') {
        return rejected('slash-block-stage-invalid')
      }
      authoredSource = stagedResult.markdown
      canonicalBaseline = canonical
      staged = true
      stageReason = stagedResult.reason || null
    }

    let resolvedOffset = sourceOffset
    if (typeof resolveSourceOffset === 'function') {
      try {
        resolvedOffset = resolveSourceOffset({
          source: authoredSource,
          previousCanonical: canonicalBaseline,
          canonical
        })
      } catch (error) {
        return rejected(`slash-block-offset-threw:${error?.name || 'Error'}`)
      }
    }

    let intent
    try {
      intent = captureIntent({
        source: authoredSource,
        queryText,
        sourceOffset: resolvedOffset,
        id
      })
    } catch (error) {
      return rejected(`slash-block-capture-threw:${error?.name || 'Error'}`)
    }
    if (!intent) return rejected('slash-block-intent-unmapped')
    if (!validCapturedIntent(intent)) return rejected('slash-block-intent-invalid')

    const token = Object.freeze({
      ...intent,
      previousCanonical: canonicalBaseline
    })
    return Object.freeze({
      ok: true,
      owner: SOURCE_SYNC_OWNERS.LEGACY,
      family: 'legacy-preservation',
      boundary: SLASH_BLOCK_SOURCE_SYNC_BOUNDARY,
      token,
      staged,
      stageReason
    })
  }

  const plan = ({
    id,
    token,
    activeToken,
    blockMarkdown,
    canonical,
    expectedDoc
  } = {}) => {
    if (!isSlashBlockSourceCommand(id)) {
      return rejected('slash-block-owner-deferred', { deferred: true })
    }
    if (!token || activeToken !== token) return rejected('slash-block-token-stale')
    if (token.id !== id) return rejected('slash-block-command-mismatch')
    if (typeof blockMarkdown !== 'string') return rejected('slash-block-markdown-missing')
    if (typeof canonical !== 'string' || !expectedDoc) {
      return rejected('slash-block-publication-incomplete')
    }

    let markdown
    try {
      markdown = applyIntent({ intent: token, blockMarkdown })
    } catch (error) {
      return rejected(`slash-block-apply-threw:${error?.name || 'Error'}`)
    }
    if (typeof markdown !== 'string') return rejected('slash-block-source-apply-rejected')

    const proof = Object.freeze({
      kind: 'slash-block-source-intent',
      commandId: token.id,
      sourceDigest: sourceSyncDigest(token.source),
      sourceLength: token.source.length,
      rawStart: token.rawStart,
      rawEnd: token.rawEnd,
      lineEnding: token.lineEnding,
      query: token.query
    })
    const result = Object.freeze({
      markdown,
      preserved: true,
      reason: SLASH_BLOCK_SOURCE_SYNC_BOUNDARY,
      integrityProof: proof
    })
    const publication = Object.freeze({
      result,
      canonical,
      expectedDoc,
      validationSite: SLASH_BLOCK_SOURCE_SYNC_BOUNDARY,
      boundary: SLASH_BLOCK_SOURCE_SYNC_BOUNDARY,
      notifyChange: true
    })

    return Object.freeze({
      ok: true,
      owner: SOURCE_SYNC_OWNERS.LEGACY,
      family: 'legacy-preservation',
      boundary: SLASH_BLOCK_SOURCE_SYNC_BOUNDARY,
      proof,
      result,
      publication
    })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.LEGACY,
    family: 'legacy-preservation',
    boundary: SLASH_BLOCK_SOURCE_SYNC_BOUNDARY,
    handles: isSlashBlockSourceCommand,
    capture,
    plan
  })
}
