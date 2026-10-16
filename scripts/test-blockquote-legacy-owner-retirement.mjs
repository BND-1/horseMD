import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'
import {
  blocksRetiredLegacySourceSyncFallback,
  retiredLegacySourceSyncFailureReason
} from '../src/renderer/src/lib/source-sync/index.js'

const editorRegistry = await readFile(
  new URL('../src/renderer/src/components/Editor.jsx', import.meta.url),
  'utf8'
)
const legacyImplementation = (await Promise.all([
  new URL('../src/renderer/src/markdown-source-preservation.js', import.meta.url),
  new URL('../src/renderer/src/lib/markdown-preservation/paragraphs.js', import.meta.url),
  new URL('../src/renderer/src/lib/markdown-preservation/regions.js', import.meta.url)
].map((path) => readFile(path, 'utf8')))).join('\n')

for (const key of [
  'blockquote-paragraph',
  'blockquote-split',
  'blockquote-join',
  'blockquote-exit'
]) {
  const start = editorRegistry.indexOf(`key: '${key}'`)
  const end = editorRegistry.indexOf('boundaries:', start)
  assert.equal(start >= 0 && end > start, true,
    `missing structural registry entry for retired family ${key}`)
  assert.equal(editorRegistry.slice(start, end).includes('legacyRetired: true'), true,
    `retired family ${key} is no longer blocking recognized legacy fallback`)
}

// Empty-quote creation/removal compatibility remains available for operations
// that the four focused owners do not recognize. The focused transaction result
// reasons themselves must never be reintroduced into canonical-diff modules.
for (const retiredClaim of [
  "reason: 'blockquote-paragraph-text-change'",
  "reason: 'blockquote-paragraph-split'",
  "reason: 'blockquote-paragraph-join'",
  "reason: 'blockquote-paragraph-exit'"
]) {
  assert.equal(
    legacyImplementation.includes(retiredClaim),
    false,
    `legacy canonical-diff implementation contains focused blockquote claim: ${retiredClaim}`
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
  reason: 'syntax-sensitive-insert'
}), 'syntax-sensitive-insert')
assert.equal(retiredLegacySourceSyncFailureReason({ legacyBlocked: true }),
  'retired-legacy-owner-rejected')
assert.equal(retiredLegacySourceSyncFailureReason({ legacyBlocked: false }), null)

// Without registry blocking, a final quote-line append is broad enough for an
// old tail/line mapper to publish it. The transaction owner must therefore be
// the authority once its PM Step chain has recognized this family.
const legacyResult = preserveRichMarkdownSource(
  '> alpha\n',
  '> alpha\n',
  '> alpha*\n'
)
assert.notEqual(legacyResult?.reason, 'blockquote-paragraph-text-change')
assert.equal(typeof legacyResult?.reason, 'string')

console.log('PASS blockquote legacy owner retirement: all four focused families block fallback only after transaction recognition, while unrelated empty-quote compatibility remains outside this retirement boundary')
