import assert from 'node:assert/strict'
import { createLatestTaskRunner } from '../src/main/latest-task-runner.js'

const pending = new Map()
let running = 0
let maxRunning = 0
const runner = createLatestTaskRunner((value, signal) => new Promise((resolve, reject) => {
  running += 1
  maxRunning = Math.max(maxRunning, running)
  const finish = () => {
    running -= 1
    signal.removeEventListener('abort', abort)
  }
  const abort = () => {
    finish()
    reject(new Error('canceled'))
  }
  signal.addEventListener('abort', abort, { once: true })
  pending.set(value, () => {
    finish()
    resolve(value)
  })
}))

const first = runner.run('renderer-1', 'first')
const second = runner.run('renderer-1', 'second')
assert.deepEqual(await first, { stale: true }, 'superseded task resolves as stale')
pending.get('second')()
assert.deepEqual(await second, { stale: false, value: 'second' }, 'latest task wins')
assert.equal(maxRunning, 1, 'cancellation prevents concurrent work for one key')

const third = runner.run('renderer-1', 'third')
assert.equal(runner.cancel('renderer-1'), true)
assert.deepEqual(await third, { stale: true }, 'explicit cancellation resolves as stale')
assert.equal(runner.cancel('missing'), false)

console.log('PASS latest task runner: one active task, latest wins, explicit cancel')
