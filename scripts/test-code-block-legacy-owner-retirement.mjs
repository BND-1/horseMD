import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'
import {
  blocksRetiredLegacySourceSyncFallback,
  retiredLegacySourceSyncFailureReason
} from '../src/renderer/src/lib/source-sync/index.js'

const legacyImplementationPaths = [
  new URL('../src/renderer/src/markdown-source-preservation.js', import.meta.url),
  new URL('../src/renderer/src/lib/markdown-preservation/regions.js', import.meta.url)
]
const editorRegistry = await readFile(
  new URL('../src/renderer/src/components/Editor.jsx', import.meta.url),
  'utf8'
)
const legacyImplementation = (await Promise.all(
  legacyImplementationPaths.map((path) => readFile(path, 'utf8'))
)).join('\n')

// These lifecycle families are journal-owned in Editor. Their reason strings may
// exist in focused transaction owners and tests, but the canonical-diff modules
// must not contain a dedicated mapper or claim for them.
for (const key of [
  'empty-code-block-unpack',
  'code-block-paragraph',
  'code-block-exit',
  'code-block',
  'code-block-info'
]) {
  const start = editorRegistry.indexOf(`key: '${key}'`)
  const end = editorRegistry.indexOf('boundaries:', start)
  assert.equal(start >= 0 && end > start, true,
    `missing structural registry entry for retired family ${key}`)
  assert.equal(editorRegistry.slice(start, end).includes('legacyRetired: true'), true,
    `retired family ${key} is no longer blocking legacy fallback`)
}

for (const retiredClaim of [
  'preserveFencedCodeBlockTextChange',
  "reason: 'fenced-code-block-content-change'",
  "reason: 'fenced-code-block-info-string-change'",
  "reason: 'empty-fenced-code-block-backspace-unpack'",
  "reason: 'code-block-converted-to-paragraph'",
  "reason: 'code-block-exit'"
]) {
  assert.equal(
    legacyImplementation.includes(retiredClaim),
    false,
    `legacy canonical-diff implementation still contains retired code-block claim: ${retiredClaim}`
  )
}

assert.equal(blocksRetiredLegacySourceSyncFallback({
  ownerEntry: { legacyRetired: true },
  ownership: { ok: false, recognized: true }
}), true)
assert.equal(blocksRetiredLegacySourceSyncFallback({
  ownerEntry: { legacyRetired: true },
  ownership: { ok: false, recognized: false }
}), false)
assert.equal(blocksRetiredLegacySourceSyncFallback({
  ownerEntry: { legacyRetired: false },
  ownership: { ok: false, recognized: true }
}), false)
assert.equal(blocksRetiredLegacySourceSyncFallback({
  ownerEntry: { legacyRetired: true },
  ownership: { ok: true, recognized: true }
}), false)
assert.equal(retiredLegacySourceSyncFailureReason({
  legacyBlocked: true,
  reason: 'code-block-source-fence-collision'
}), 'code-block-source-fence-collision')
assert.equal(retiredLegacySourceSyncFailureReason({ legacyBlocked: true }),
  'retired-legacy-owner-rejected')
assert.equal(retiredLegacySourceSyncFailureReason({ legacyBlocked: false }), null)

const source = [
  '# code block ownership',
  '',
  '- authored bullet',
  '',
  '1. surrounding text',
  '',
  '```',
  '',
  '```',
  '',
  '- following bullet',
  ''
].join('\n')
const previous = [
  '# code block ownership',
  '',
  '* authored bullet',
  '',
  '1. surrounding text',
  '',
  '```',
  '',
  '```',
  '',
  '* following bullet',
  ''
].join('\n')
const next = previous.replace('```\n\n```', '```\nsurge\n```')
const legacyResult = preserveRichMarkdownSource(source, previous, next)
assert.notEqual(
  legacyResult?.reason,
  'fenced-code-block-content-change',
  'legacy preservation must not claim code-block content after Transaction Journal migration'
)

console.log('PASS code-block legacy owner retirement: canonical-diff modules contain no dedicated lifecycle claims, and only a recognized rejection from a legacyRetired registry family blocks fallback')
