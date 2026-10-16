import assert from 'node:assert/strict'
import { isReadOnlyMutationKey } from '../src/renderer/src/components/editor-read-only.js'

const writes = [
  { key: 'a' },
  { key: 'Enter' },
  { key: 'Backspace' },
  { key: 'Delete' },
  { key: 'Tab' },
  { key: 'v', metaKey: true },
  { key: 'x', ctrlKey: true },
  { key: 'z', metaKey: true },
  { key: 'y', ctrlKey: true }
]
const reading = [
  { key: 'ArrowDown' },
  { key: 'PageDown' },
  { key: 'c', metaKey: true },
  { key: 'a', ctrlKey: true },
  { key: 'Shift' }
]

for (const event of writes) assert.equal(isReadOnlyMutationKey(event), true, `should block ${JSON.stringify(event)}`)
for (const event of reading) assert.equal(isReadOnlyMutationKey(event), false, `should allow ${JSON.stringify(event)}`)

console.log('PASS mobile read-only: editing keys are blocked while reading keys stay available')
