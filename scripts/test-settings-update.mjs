import assert from 'node:assert/strict'

import { resolveUpdateCheckState } from '../src/renderer/src/lib/settings-update.js'

assert.deepEqual(resolveUpdateCheckState({ ok: false }), {
  status: 'error',
  info: null
})
assert.deepEqual(resolveUpdateCheckState({ ok: true }), {
  status: 'error',
  info: null
})
assert.deepEqual(resolveUpdateCheckState({ ok: true, latest: '0.6.5', current: '0.6.5' }), {
  status: 'uptodate',
  info: null
})
assert.deepEqual(resolveUpdateCheckState({ ok: true, latest: '0.6.5', current: '0.6.29' }), {
  status: 'uptodate',
  info: null
})
assert.deepEqual(resolveUpdateCheckState({
  ok: true,
  latest: '0.7.0',
  current: '0.6.5',
  url: 'https://github.com/BND-1/horseMD/releases/tag/v0.7.0'
}), {
  status: 'available',
  info: {
    latest: '0.7.0',
    url: 'https://github.com/BND-1/horseMD/releases/tag/v0.7.0'
  }
})
assert.deepEqual(resolveUpdateCheckState({ ok: true, latest: '0.7.0', current: '0.6.5' }), {
  status: 'available',
  info: {
    latest: '0.7.0',
    url: ''
  }
})

console.log('PASS settings update state resolution')
