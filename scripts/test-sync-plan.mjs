import assert from 'node:assert/strict'
import { makeConflictPath, buildDirectionalSyncPlan, buildSyncPlan } from '../src/main/sync/sync-plan.js'

const file = (sha256) => ({ sha256, size: 1 })
const plan = (localFiles, remoteFiles, previousEntries) =>
  buildSyncPlan({ localFiles, remoteFiles, previousEntries, conflictSuffix: 'from Mac 2026-07-18' })

assert.equal(makeConflictPath('notes/today.md', 'from Mac'), 'notes/today (from Mac).md')
assert.equal(makeConflictPath('README', 'from Mac'), 'README (from Mac)')

assert.deepEqual(plan({ 'a.md': file('a') }, {}, {}).summary, {
  upload: 1, download: 0, delete: 0, conflict: 0, unchanged: 0
})
assert.deepEqual(plan({}, { 'a.md': file('a') }, {}).summary, {
  upload: 0, download: 1, delete: 0, conflict: 0, unchanged: 0
})
assert.deepEqual(plan({ 'a.md': file('a') }, { 'a.md': file('b') }, {}).operations[0], {
  type: 'conflict',
  path: 'a.md',
  local: file('a'),
  remote: file('b'),
  conflictPath: 'a (from Mac 2026-07-18).md',
  reason: 'initial-divergence'
})

assert.equal(plan({ 'a.md': file('b') }, { 'a.md': file('a') }, { 'a.md': file('a') }).operations[0].type, 'upload')
assert.equal(plan({ 'a.md': file('a') }, { 'a.md': file('b') }, { 'a.md': file('a') }).operations[0].type, 'download')
assert.equal(plan({}, { 'a.md': file('a') }, { 'a.md': file('a') }).operations[0].type, 'deleteRemote')
assert.equal(plan({ 'a.md': file('a') }, {}, { 'a.md': file('a') }).operations[0].type, 'deleteLocal')

const divergent = plan({ 'a.md': file('b') }, { 'a.md': file('c') }, { 'a.md': file('a') })
assert.equal(divergent.operations[0].type, 'conflict')
assert.equal(divergent.operations[0].reason, 'both-modified')
assert.equal(divergent.summary.conflict, 1)

const deleteVsModify = plan({}, { 'a.md': file('b') }, { 'a.md': file('a') })
assert.equal(deleteVsModify.operations[0].type, 'conflict')
assert.equal(deleteVsModify.operations[0].reason, 'delete-vs-modify')

const push = buildDirectionalSyncPlan({
  localFiles: { 'local.md': file('local'), 'same.md': file('same') },
  remoteFiles: { 'remote.md': file('remote'), 'same.md': file('same') },
  strategy: 'push'
})
assert.deepEqual(push.summary, { upload: 1, download: 0, delete: 1, conflict: 0, unchanged: 1 })
assert.equal(push.operations.find((item) => item.path === 'local.md').preserveRemote, false)
assert.equal(push.operations.find((item) => item.path === 'remote.md').type, 'deleteRemote')

const pull = buildDirectionalSyncPlan({
  localFiles: { 'local.md': file('local'), 'same.md': file('same') },
  remoteFiles: { 'remote.md': file('remote'), 'same.md': file('same') },
  strategy: 'pull'
})
assert.deepEqual(pull.summary, { upload: 0, download: 1, delete: 1, conflict: 0, unchanged: 1 })
assert.equal(pull.operations.find((item) => item.path === 'remote.md').preserveLocal, false)
assert.equal(pull.operations.find((item) => item.path === 'local.md').type, 'deleteLocal')

console.log('PASS sync plan: merge and explicit push/pull directions')
