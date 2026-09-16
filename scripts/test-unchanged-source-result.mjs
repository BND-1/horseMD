import assert from 'node:assert/strict'
import { reconcileUnchangedSourceResult, UNCHANGED_SOURCE_REASON } from '../src/renderer/src/lib/source-sync/unchanged-source-result.js'

const text = value => ({ type: 'text', text: value })
const paragraph = value => ({ type: 'paragraph', ...(value ? { content: [text(value)] } : {}) })
const list = (type, items) => ({ type, content: items.map(content => ({ type: 'list_item', content })) })
const doc = content => ({ toJSON: () => ({ type: 'doc', content }) })
const current = doc([list('bullet_list', [[paragraph('one')], [paragraph('two')]])])
const before = doc([list('bullet_list', [[paragraph('one'), paragraph('')], [paragraph('two')]])])
const changed = doc([list('bullet_list', [[paragraph('changed')], [paragraph('two')]])])
const source = '- one\n- two\n'
const canonical = '* one\n* two\n'
const failed = Object.freeze({ markdown: source, preserved: false, blocked: true, reason: 'unmapped-diverged-list-batch' })
const base = { source, canonical, expectedDoc: current, result: failed, parseMarkdown: () => current }
const good = reconcileUnchangedSourceResult(base)
assert.equal(good.markdown, source)
assert.equal(good.preserved, true)
assert.equal(good.reason, UNCHANGED_SOURCE_REASON)
assert.equal(good.blocked, undefined)
assert.equal(good.integrityProof, null)
assert.equal(failed.preserved, false, 'never mutate the failed result')
assert.equal(reconcileUnchangedSourceResult({ ...base, expectedDoc: before }), failed, 'real nested empty paragraph cannot be dropped')
assert.equal(reconcileUnchangedSourceResult({ ...base, expectedDoc: changed }), failed, 'old source is not current text')
assert.equal(reconcileUnchangedSourceResult({ ...base, parseMarkdown: value => value === source ? current : before }), failed, 'stale callback cannot advance baseline')
assert.equal(reconcileUnchangedSourceResult({ ...base, parseMarkdown: () => { throw new Error('parser failed') } }), failed)
assert.equal(reconcileUnchangedSourceResult({ ...base, expectedDoc: null }), failed)
assert.equal(reconcileUnchangedSourceResult({ ...base, parseMarkdown: null }), failed)
const editedCandidate = { ...failed, markdown: source + 'extra' }
assert.equal(reconcileUnchangedSourceResult({ ...base, result: editedCandidate }), editedCandidate)
const successful = { markdown: source, preserved: true }
assert.equal(reconcileUnchangedSourceResult({ ...base, result: successful, parseMarkdown: () => assert.fail('success path must not reparse') }), successful)
const numberedSource = '1. one\n2. two\n'
const renumbered = '1. one\n9. two\n'
const ordered = doc([list('ordered_list', [[paragraph('one')], [paragraph('two')]])])
const numberedFailure = { ...failed, markdown: numberedSource }
assert.equal(reconcileUnchangedSourceResult({ ...base, source: numberedSource, canonical: renumbered, result: numberedFailure, expectedDoc: ordered, parseMarkdown: () => ordered }), numberedFailure, 'list numbering gate stays strict even when parser omits ordinals')
const nestedCanonical = '- one\n  - two\n'
assert.equal(reconcileUnchangedSourceResult({ ...base, canonical: nestedCanonical }), failed, 'nesting gate stays strict')
const semanticBreak = doc([list('bullet_list', [[{ type: 'paragraph', content: [text('one'), { type: 'hardbreak' }] }], [paragraph('two')]])])
assert.equal(reconcileUnchangedSourceResult({ ...base, expectedDoc: semanticBreak }), failed, 'authored hard break cannot disappear')
console.log('PASS unchanged source candidate: exact bytes, no mutation, stale source/callback, real empty paragraph, numbering/nesting, hard break, exceptions and zero-work success path')
