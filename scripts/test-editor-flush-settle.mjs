import assert from 'node:assert/strict'
import { settleEditorMarkdown } from '../src/renderer/src/lib/editor-flush-settle.js'

let calls = 0
const settled = await settleEditorMarkdown(() => {
  calls += 1
  return calls < 3 ? null : 'safe source\n'
}, { delays: [0, 0, 0] })

assert.equal(settled, 'safe source\n')
assert.equal(calls, 3, 'the durability boundary must retry a transient fail-closed mapping')

calls = 0
const blocked = await settleEditorMarkdown(() => {
  calls += 1
  return null
}, { delays: [0, 0] })

assert.equal(blocked, null)
assert.equal(calls, 3, 'a persistent ambiguity must remain fail closed after bounded retries')

let receivedForce = null
await settleEditorMarkdown((options) => {
  receivedForce = options.force
  return 'ok'
}, { force: true, delays: [] })
assert.equal(receivedForce, true)

console.log('PASS editor flush settle: transient mappings retry; persistent ambiguity stays fail closed')
