import assert from 'node:assert/strict'
import {
  saveSourceSyncRecovery,
  sourceSyncRecoveryName
} from '../src/renderer/src/lib/source-sync-recovery.js'

assert.equal(sourceSyncRecoveryName('report.md'), 'report.horsemd-recovered.md')
assert.equal(sourceSyncRecoveryName('notes.markdown'), 'notes.horsemd-recovered.md')

const writes = []
const saved = await saveSourceSyncRecovery({
  title: 'report.md',
  markdown: '# live rich edit\n',
  api: {
    saveAs: async (name) => `/tmp/${name}`,
    writeFile: async (path, content) => writes.push({ path, content })
  }
})
assert.deepEqual(saved, { ok: true, path: '/tmp/report.horsemd-recovered.md' })
assert.deepEqual(writes, [{
  path: '/tmp/report.horsemd-recovered.md',
  content: '# live rich edit\n'
}])

let wroteAfterCancel = false
const cancelled = await saveSourceSyncRecovery({
  title: 'report.md',
  markdown: 'unsaved',
  api: {
    saveAs: async () => null,
    writeFile: async () => { wroteAfterCancel = true }
  }
})
assert.deepEqual(cancelled, { ok: false, reason: 'cancelled' })
assert.equal(wroteAfterCancel, false)

console.log('PASS source-sync recovery: persistent ambiguity writes only a user-chosen recovery copy')
