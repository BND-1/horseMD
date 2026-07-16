import assert from 'node:assert/strict'
import { createEditorApiRegistry } from '../src/renderer/src/lib/editor-api-registry.js'

const registry = createEditorApiRegistry({ timeoutMs: 20 })
const ready = registry.waitFor('ready')
const api = { getPdfSource: () => ({ html: '<p>ready</p>' }) }
registry.register('ready', api)
assert.equal(await ready, api, 'register resolves pending readiness waiters')
assert.equal(await registry.waitFor('ready'), api, 'mounted API resolves immediately')

const closed = registry.waitFor('closed')
registry.prune(new Set(['ready']))
assert.equal(await closed, null, 'closing a tab releases readiness waiters')

assert.equal(await registry.waitFor('timeout'), null, 'failed editor mount times out')
registry.dispose()
assert.deepEqual(registry.ref.current, {}, 'dispose clears mounted APIs')

console.log('PASS editor API registry: ready, immediate, close, timeout, dispose')
