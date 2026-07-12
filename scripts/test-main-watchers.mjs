import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isAbsoluteWatchPath,
  isRestrictedWatchRoot,
  registerWatcherIpc
} from '../src/main/watchers.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeWatcher extends EventEmitter {
  closed = false

  async close() {
    this.closed = true
  }
}

const handlers = new Map()
const ipcMain = {
  handle(channel, handler) {
    handlers.set(channel, handler)
  }
}
const watched = []
const watcherFactory = {
  watch(path, options) {
    const watcher = new FakeWatcher()
    watched.push({ path, options, watcher })
    return watcher
  }
}
const sent = []
registerWatcherIpc(ipcMain, {
  watcherFactory,
  sendToRenderer: (channel, payload) => sent.push({ channel, payload })
})

assert.equal(isAbsoluteWatchPath('/tmp/docs'), true)
assert.equal(isAbsoluteWatchPath('C:\\Docs'), true)
assert.equal(isAbsoluteWatchPath('\\\\server\\share'), true)
assert.equal(isAbsoluteWatchPath('./docs'), false)
assert.equal(isRestrictedWatchRoot('/'), true)
assert.equal(isRestrictedWatchRoot('.'), true)
assert.equal(isRestrictedWatchRoot('/dev'), true)
assert.equal(isRestrictedWatchRoot('/private/var/folders/a'), true)
assert.equal(isRestrictedWatchRoot('/tmp/docs'), false)

assert.equal(await handlers.get('watch:start')(null, '.'), false)
assert.equal(watched.length, 0)
assert.equal(await handlers.get('watch:start')(null, '/tmp/horsemd-watch-root'), true)
assert.equal(await handlers.get('watch:start')(null, '/tmp/horsemd-watch-root'), true)
assert.equal(watched.length, 1, 'duplicate folder watches reuse the existing watcher')
assert.equal(watched[0].options.followSymlinks, false)
assert.equal(watched[0].options.ignored('/tmp/horsemd-watch-root/node_modules/pkg'), true)
assert.equal(watched[0].options.ignored('/tmp/horsemd-watch-root/notes/file.md'), false)

watched[0].watcher.emit('add', '/tmp/horsemd-watch-root/new.md')
await sleep(145)
assert.deepEqual(sent.shift(), { channel: 'watch:changed', payload: '/tmp/horsemd-watch-root' })

watched[0].watcher.emit('add', '/tmp/horsemd-watch-root/later.md')
await handlers.get('watch:stop')(null, '/tmp/horsemd-watch-root')
await sleep(145)
assert.equal(sent.length, 0, 'stopping a folder watch clears pending notifications')
assert.equal(watched[0].watcher.closed, true)

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-watcher-'))
const file = join(root, 'watched.md')
try {
  await fs.writeFile(file, '# watched')
  assert.equal(await handlers.get('watch:file')(null, file), true)
  assert.equal(await handlers.get('watch:file')(null, file), true)
  assert.equal(watched.length, 2, 'duplicate file watches reuse the existing watcher')
  assert.equal(watched[1].options.usePolling, true)
  assert.equal(watched[1].options.interval, 1000)

  watched[1].watcher.emit('change', file)
  await sleep(105)
  assert.equal(sent[0].channel, 'file:changed')
  assert.equal(sent[0].payload.path, file)
  assert.equal(sent[0].payload.mtimeMs > 0, true)

  await handlers.get('watch:unfile')(null, file)
  assert.equal(watched[1].watcher.closed, true)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

console.log('PASS main watchers: root guards, debounce, polling and cleanup')
