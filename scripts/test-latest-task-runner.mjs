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
await new Promise((resolve) => setImmediate(resolve))
pending.get('second')()
assert.deepEqual(await second, { stale: false, value: 'second' }, 'latest task wins')
assert.equal(maxRunning, 1, 'cancellation prevents concurrent work for one key')

const third = runner.run('renderer-1', 'third')
assert.equal(runner.cancel('renderer-1'), true)
assert.deepEqual(await third, { stale: true }, 'explicit cancellation resolves as stale')
assert.equal(runner.cancel('missing'), false)

const starts = []
const finishes = []
let asynchronousRunning = 0
let asynchronousMaxRunning = 0
const asynchronousRunner = createLatestTaskRunner((value, signal) => new Promise((resolve, reject) => {
  starts.push(value)
  asynchronousRunning += 1
  asynchronousMaxRunning = Math.max(asynchronousMaxRunning, asynchronousRunning)
  const finish = (callback) => {
    setTimeout(() => {
      asynchronousRunning -= 1
      finishes.push(value)
      callback()
    }, 40)
  }
  signal.addEventListener('abort', () => finish(() => reject(new Error('asynchronous cleanup complete'))), { once: true })
  if (value === 'latest') finish(() => resolve(value))
}))

const asynchronousFirst = asynchronousRunner.run('renderer-2', 'printing')
const asynchronousLatest = asynchronousRunner.run('renderer-2', 'latest')
assert.deepEqual(starts, ['printing'], 'replacement waits while the old worker cleans up')
assert.deepEqual(await asynchronousFirst, { stale: true })
assert.deepEqual(await asynchronousLatest, { stale: false, value: 'latest' })
assert.deepEqual(starts, ['printing', 'latest'])
assert.deepEqual(finishes, ['printing', 'latest'])
assert.equal(asynchronousMaxRunning, 1, 'asynchronous abort cleanup never overlaps the replacement worker')

console.log('PASS latest task runner: latest wins, explicit cancel, and asynchronous cleanup stays serialized')
