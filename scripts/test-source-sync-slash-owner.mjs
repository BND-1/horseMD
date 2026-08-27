import assert from 'node:assert/strict'
import {
  SLASH_BLOCK_SOURCE_SYNC_BOUNDARY,
  createEditorSourceSyncBridge,
  createSlashBlockSourceSyncOwner,
  createSourceSyncCheckpointStore,
  findSlashCodeBlockAtSelection,
  isSlashBlockSourceCommand
} from '../src/renderer/src/lib/source-sync/index.js'
import {
  applySlashBlockSourceIntent,
  captureSlashBlockSourceIntent
} from '../src/renderer/src/components/editor-slash-source.js'

const doc = Object.freeze({ id: 'slash-doc' })
const source = '前文\r\n\r\n/code\r\n\r\n后文\r\n'
const canonical = '前文\n\n/code\n\n后文\n'
const calls = []
const owner = createSlashBlockSourceSyncOwner({
  preserve: (authored, previous, next) => {
    calls.push(['preserve', authored, previous, next])
    return {
      markdown: authored,
      preserved: true,
      reason: 'fixture-stage'
    }
  },
  captureIntent: (input) => {
    calls.push(['capture', input])
    return captureSlashBlockSourceIntent(input)
  },
  applyIntent: (input) => {
    calls.push(['apply', input])
    return applySlashBlockSourceIntent(input)
  }
})

assert.equal(isSlashBlockSourceCommand('code'), true)
assert.equal(isSlashBlockSourceCommand('math'), true)
assert.equal(isSlashBlockSourceCommand('code:python'), true)
assert.equal(isSlashBlockSourceCommand('task'), false)
assert.equal(owner.owner, 'legacy')
assert.equal(owner.family, 'legacy-preservation')
assert.equal(owner.boundary, SLASH_BLOCK_SOURCE_SYNC_BOUNDARY)

const deferred = owner.capture({ id: 'task' })
assert.equal(deferred.ok, false)
assert.equal(deferred.deferred, true)
assert.equal(deferred.reason, 'slash-block-owner-deferred')
assert.deepEqual(calls, [], 'unsupported commands must not invoke owner helpers')

const captured = owner.capture({
  id: 'code',
  source,
  previousCanonical: canonical,
  canonical,
  queryText: '/code',
  resolveSourceOffset: ({ source: resolvedSource }) => {
    calls.push(['offset', resolvedSource])
    return resolvedSource.indexOf('/code') + '/code'.length
  }
})
assert.equal(captured.ok, true)
assert.equal(captured.staged, false)
assert.equal(captured.token.id, 'code')
assert.equal(captured.token.source, source)
assert.equal(captured.token.previousCanonical, canonical)
assert.equal(captured.token.rawStart, source.indexOf('/code'))
assert.equal(captured.token.rawEnd, source.indexOf('/code') + '/code'.length)
assert.equal(captured.token.lineEnding, '\r\n')
assert.ok(Object.isFrozen(captured))
assert.ok(Object.isFrozen(captured.token))
assert.deepEqual(calls.map((entry) => entry[0]), ['offset', 'capture'])

const plan = owner.plan({
  id: 'code',
  token: captured.token,
  activeToken: captured.token,
  blockMarkdown: '```js\n\n```\n',
  canonical: '前文\n\n```js\n\n```\n\n后文\n',
  expectedDoc: doc
})
assert.equal(plan.ok, true)
assert.equal(plan.boundary, SLASH_BLOCK_SOURCE_SYNC_BOUNDARY)
assert.equal(plan.result.reason, SLASH_BLOCK_SOURCE_SYNC_BOUNDARY)
assert.equal(
  plan.result.markdown,
  '前文\r\n\r\n```js\r\n\r\n```\r\n\r\n后文\r\n'
)
assert.equal(plan.result.integrityProof, plan.proof)
assert.equal(plan.proof.kind, 'slash-block-source-intent')
assert.equal(plan.proof.commandId, 'code')
assert.equal(plan.proof.rawStart, captured.token.rawStart)
assert.equal(plan.proof.rawEnd, captured.token.rawEnd)
assert.equal(plan.proof.lineEnding, '\r\n')
assert.equal(plan.proof.sourceLength, source.length)
assert.equal(typeof plan.proof.sourceDigest, 'string')
assert.equal('source' in plan.proof, false, 'candidate proof must not duplicate full source bytes')
assert.equal(plan.publication.result, plan.result)
assert.equal(plan.publication.expectedDoc, doc)
assert.equal(plan.publication.notifyChange, true)
assert.ok(Object.isFrozen(plan))
assert.ok(Object.isFrozen(plan.result))
assert.ok(Object.isFrozen(plan.proof))
assert.ok(Object.isFrozen(plan.publication))

const codeNode = Object.freeze({ type: Object.freeze({ name: 'code_block' }) })
const paragraphNode = Object.freeze({ type: Object.freeze({ name: 'paragraph' }) })
const docNode = Object.freeze({ type: Object.freeze({ name: 'doc' }) })
assert.equal(findSlashCodeBlockAtSelection({
  $from: {
    depth: 2,
    node: (depth) => depth === 1 ? codeNode : depth === 2 ? paragraphNode : docNode
  }
}), codeNode)
assert.equal(findSlashCodeBlockAtSelection({
  $from: {
    depth: 1,
    node: (depth) => depth === 1 ? paragraphNode : docNode
  }
}), null)
assert.equal(findSlashCodeBlockAtSelection(null), null)

const stagedOwner = createSlashBlockSourceSyncOwner({
  preserve: (authored, previous, next) => {
    assert.equal(previous, 'serializer-old\n')
    assert.equal(next, 'serializer-new\n')
    return {
      markdown: authored.replace('/math', '/math'),
      preserved: true,
      reason: 'staged-before-slash'
    }
  },
  captureIntent: captureSlashBlockSourceIntent,
  applyIntent: applySlashBlockSourceIntent
})
const stagedSource = 'before\n\n/math\n'
let stagedOffsetSource = null
const stagedCapture = stagedOwner.capture({
  id: 'math',
  source: stagedSource,
  previousCanonical: 'serializer-old\n',
  canonical: 'serializer-new\n',
  queryText: '/math',
  resolveSourceOffset: ({ source: resolvedSource }) => {
    stagedOffsetSource = resolvedSource
    return resolvedSource.indexOf('/math') + 5
  }
})
assert.equal(stagedCapture.ok, true)
assert.equal(stagedCapture.staged, true)
assert.equal(stagedCapture.stageReason, 'staged-before-slash')
assert.equal(stagedCapture.token.previousCanonical, 'serializer-new\n')
assert.equal(stagedOffsetSource, stagedCapture.token.source)
const mathPlan = stagedOwner.plan({
  id: 'math',
  token: stagedCapture.token,
  activeToken: stagedCapture.token,
  blockMarkdown: '$$\nx^2 + 1\n$$\n',
  canonical: 'before\n\n$$\nx^2 + 1\n$$\n',
  expectedDoc: doc
})
assert.equal(mathPlan.ok, true)
assert.equal(mathPlan.proof.commandId, 'math')
assert.equal(mathPlan.result.markdown, 'before\n\n$$\nx^2 + 1\n$$\n')
const emptyMathPlan = stagedOwner.plan({
  id: 'math',
  token: stagedCapture.token,
  activeToken: stagedCapture.token,
  blockMarkdown: '$$\n\n$$\n',
  canonical: 'before\n\n$$\n$$\n',
  expectedDoc: doc
})
assert.equal(emptyMathPlan.ok, true)
assert.equal(
  emptyMathPlan.result.markdown,
  'before\n\n$$\n$$\n',
  'isolated empty math serializer spacing must not enter authored source'
)
assert.equal(stagedOwner.plan({
  id: 'math',
  token: stagedCapture.token,
  activeToken: stagedCapture.token,
  blockMarkdown: '$$\nmissing close',
  canonical: 'before\n\n$$\nmissing close\n',
  expectedDoc: doc
}).reason, 'slash-block-source-apply-rejected')

for (const [label, result, reason] of [
  ['stale token', owner.plan({
    id: 'code',
    token: captured.token,
    activeToken: { ...captured.token },
    blockMarkdown: '```\n```\n',
    canonical,
    expectedDoc: doc
  }), 'slash-block-token-stale'],
  ['command mismatch', owner.plan({
    id: 'math',
    token: captured.token,
    activeToken: captured.token,
    blockMarkdown: '```\n```\n',
    canonical,
    expectedDoc: doc
  }), 'slash-block-command-mismatch'],
  ['incomplete fence', owner.plan({
    id: 'code',
    token: captured.token,
    activeToken: captured.token,
    blockMarkdown: '```js\nmissing close',
    canonical,
    expectedDoc: doc
  }), 'slash-block-source-apply-rejected'],
  ['missing doc', owner.plan({
    id: 'code',
    token: captured.token,
    activeToken: captured.token,
    blockMarkdown: '```\n```\n',
    canonical,
    expectedDoc: null
  }), 'slash-block-publication-incomplete']
]) {
  assert.equal(result.ok, false, label)
  assert.equal(result.reason, reason, label)
}

const stageRejected = createSlashBlockSourceSyncOwner({
  preserve: () => ({ markdown: source, preserved: false, reason: 'visible-stream-mismatch' }),
  captureIntent: captureSlashBlockSourceIntent,
  applyIntent: applySlashBlockSourceIntent
}).capture({
  id: 'code',
  source,
  previousCanonical: 'old',
  canonical: 'new',
  queryText: '/code',
  sourceOffset: source.indexOf('/code')
})
assert.equal(stageRejected.ok, false)
assert.equal(stageRejected.reason, 'visible-stream-mismatch')

const malformedIntent = createSlashBlockSourceSyncOwner({
  preserve: () => ({ markdown: source, preserved: true }),
  captureIntent: () => ({ id: 'code' }),
  applyIntent: applySlashBlockSourceIntent
}).capture({
  id: 'code',
  source,
  previousCanonical: canonical,
  canonical,
  queryText: '/code'
})
assert.equal(malformedIntent.reason, 'slash-block-intent-invalid')

const throwingApply = createSlashBlockSourceSyncOwner({
  preserve: () => ({ markdown: source, preserved: true }),
  captureIntent: captureSlashBlockSourceIntent,
  applyIntent: () => { throw new TypeError('fixture') }
}).plan({
  id: 'code',
  token: captured.token,
  activeToken: captured.token,
  blockMarkdown: '```\n```\n',
  canonical,
  expectedDoc: doc
})
assert.equal(throwingApply.reason, 'slash-block-apply-threw:TypeError')

let bridgeSource = source
let bridgeCanonical = canonical
const bridgeChanges = []
const bridgeCheckpoints = createSourceSyncCheckpointStore({ limit: 4 })
bridgeCheckpoints.trust(bridgeSource, bridgeCanonical)
let bridgeValidation = null
const bridge = createEditorSourceSyncBridge({
  checkpointStore: bridgeCheckpoints,
  getSource: () => bridgeSource,
  getCanonical: () => bridgeCanonical,
  getExpectedDoc: () => doc,
  setSource: (value) => { bridgeSource = value },
  setCanonical: (value) => { bridgeCanonical = value },
  onChange: (value) => bridgeChanges.push(value),
  validateLegacyCandidate: (
    markdown,
    expectedDoc,
    nextCanonical,
    authoredSource,
    reason,
    proof,
    validationSite,
    options
  ) => {
    bridgeValidation = {
      markdown,
      expectedDoc,
      nextCanonical,
      authoredSource,
      reason,
      proof,
      validationSite,
      options
    }
    return {
      ok: markdown === plan.result.markdown &&
        expectedDoc === doc &&
        nextCanonical === plan.publication.canonical
    }
  }
})
const bridgePublished = bridge.publish(plan.publication)
assert.equal(bridgePublished.ok, true)
assert.equal(bridgePublished.publication.owner, 'legacy')
assert.equal(bridgePublished.publication.family, 'legacy-preservation')
assert.equal(bridgePublished.publication.reason, SLASH_BLOCK_SOURCE_SYNC_BOUNDARY)
assert.equal(
  bridgePublished.candidate.proof.preservationProof.kind,
  'slash-block-source-intent'
)
assert.equal(
  bridgePublished.candidate.proof.preservationProof.sourceDigest,
  plan.proof.sourceDigest
)
assert.equal(bridgeValidation.proof.kind, 'slash-block-source-intent')
assert.equal(bridgeValidation.validationSite, SLASH_BLOCK_SOURCE_SYNC_BOUNDARY)
assert.equal(bridgeValidation.options.trustCheckpoint, false)
assert.equal(bridgeValidation.authoredSource, source)
assert.equal(bridgeSource, plan.result.markdown)
assert.equal(bridgeCanonical, plan.publication.canonical)
assert.deepEqual(bridgeChanges, [plan.result.markdown])
assert.equal(
  bridgeCheckpoints.has(plan.result.markdown, plan.publication.canonical),
  true
)
const duplicateBridgePublication = bridge.publishPrepared({
  coordinator: bridge.getCoordinator(),
  snapshot: bridgePublished.snapshot,
  candidate: bridgePublished.candidate,
  validation: bridgePublished.validation,
  boundary: SLASH_BLOCK_SOURCE_SYNC_BOUNDARY
})
assert.equal(duplicateBridgePublication.ok, false)
assert.match(
  duplicateBridgePublication.reason,
  /source-sync-(live-snapshot-stale|publication-already-consumed)/
)
assert.deepEqual(bridgeChanges, [plan.result.markdown])

assert.throws(() => createSlashBlockSourceSyncOwner({}), /requires preserve/)
assert.throws(() => createSlashBlockSourceSyncOwner({ preserve: () => ({}) }), /requires captureIntent/)
assert.throws(() => createSlashBlockSourceSyncOwner({
  preserve: () => ({}),
  captureIntent: () => null
}), /requires applyIntent/)

console.log('PASS source sync slash owner: allowlist, staged capture, exact token identity, fenced atomic plan, structured proof, and failure paths')
