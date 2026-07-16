import assert from 'node:assert/strict'
import { performPdfSave } from '../src/renderer/src/hooks/usePdfExport.js'

const token = 'preview-token'
const defaultName = 'HorseMD.pdf'

assert.deepEqual(
  await performPdfSave(async () => ({ path: '/tmp/HorseMD.pdf' }), token, defaultName),
  { close: true, canceled: false, error: null }
)
assert.deepEqual(
  await performPdfSave(async () => ({ canceled: true }), token, defaultName),
  { close: true, canceled: true, error: null }
)
assert.deepEqual(
  await performPdfSave(async () => ({ ok: false, error: 'write failed' }), token, defaultName),
  { close: false, canceled: false, error: 'write failed' }
)
assert.deepEqual(
  await performPdfSave(async () => { throw new Error('IPC unavailable') }, token, defaultName),
  { close: false, canceled: false, error: 'IPC unavailable' }
)

console.log('PASS PDF save state: success, cancel, returned failure, and rejected IPC')
