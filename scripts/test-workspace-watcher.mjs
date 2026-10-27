import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { createWorkspaceWatcher } from '../src/main/workspace-watcher.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Both watch modes: chokidar (macOS / Linux) and one recursive fs.watch
// (Windows default, so folders holding subfolders stay renamable).
for (const native of [false, true]) {
const mode = native ? 'recursive fs.watch' : 'chokidar'
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-workspace-worker-'))
let watcher
let heartbeat
const events = []
const waitForEvent = async (event, path) => {
  const deadline = performance.now() + 10000
  while (performance.now() < deadline) {
    if (events.some((entry) => entry.event === event && entry.path === path)) return
    await sleep(25)
  }
  throw new Error(`Missing workspace event: ${event} ${path}`)
}

try {
  for (let index = 0; index < 10; index += 1) {
    const dir = join(root, `data-${index}`)
    await fs.mkdir(dir)
    await Promise.all(Array.from({ length: 100 }, (_, file) => fs.writeFile(join(dir, `sample-${file}.bin`), 'data')))
  }
  await fs.writeFile(join(root, 'note.md'), '# note\n')
  await fs.writeFile(join(root, 'note.txt'), 'text\n')
  await fs.mkdir(join(root, 'node_modules'))
  await fs.writeFile(join(root, 'node_modules', 'ignored.md'), '# ignored\n')

  let ticks = 0
  let lastTick = performance.now()
  let maxLag = 0
  heartbeat = setInterval(() => {
    const now = performance.now()
    maxLag = Math.max(maxLag, now - lastTick - 25)
    lastTick = now
    ticks += 1
  }, 25)
  watcher = createWorkspaceWatcher(root, undefined, { native })
  watcher.on('error', (error) => { throw error })
  for (const event of ['add', 'unlink', 'addDir', 'unlinkDir']) {
    watcher.on(event, (path) => events.push({ event, path }))
  }
  const ready = once(watcher, 'ready')
  const [watched] = await Promise.race([
    ready,
    sleep(10000).then(() => { throw new Error('Workspace worker did not become ready') })
  ])
  assert(watched.entries < 30, `Unrelated data files were registered: ${watched.entries} entries`)
  assert.equal(events.length, 0, 'initial enumeration must not emit file-tree changes')
  // The recursive watch is ready within a tick; the lag check still applies.
  assert(native || ticks > 0, 'main event loop did not run during worker initialization')
  assert(maxLag < 1000, `main event loop stalled during initialization: ${maxLag}ms`)

  const added = join(root, 'new.MARKDOWN')
  await fs.writeFile(added, '# new\n')
  await waitForEvent('add', added)
  const renamed = join(root, 'renamed.mdx')
  await fs.rename(added, renamed)
  await waitForEvent('unlink', added)
  await waitForEvent('add', renamed)
  await fs.unlink(renamed)
  await waitForEvent('unlink', renamed)

  const nested = join(root, 'new-folder')
  await fs.mkdir(nested)
  await waitForEvent('addDir', nested)
  const text = join(nested, 'nested.txt')
  await fs.writeFile(text, 'nested\n')
  await waitForEvent('add', text)
  await fs.unlink(text)
  await waitForEvent('unlink', text)
  await fs.rmdir(nested)
  await waitForEvent('unlinkDir', nested)

  // A folder holding a subfolder can be renamed while it is watched
  // (Windows refused this with one chokidar handle per folder: EPERM), and
  // the rename reaches the tree.
  const outer = join(root, 'outer')
  await fs.mkdir(join(outer, 'inner'), { recursive: true })
  await fs.writeFile(join(outer, 'inner', 'deep.md'), '# deep\n')
  await waitForEvent('add', join(outer, 'inner', 'deep.md'))
  await sleep(300)
  const moved = join(root, 'outer-renamed')
  if (native || process.platform !== 'win32') {
    await fs.rename(outer, moved)
    await waitForEvent('unlinkDir', outer)
    await waitForEvent('addDir', moved)
    await fs.rename(join(moved, 'inner'), join(moved, 'Inner'))
    await waitForEvent('addDir', join(moved, 'Inner'))
  }

  const data = join(root, 'new.bin')
  await fs.writeFile(data, 'data')
  await sleep(500)
  assert(!events.some((entry) => entry.path === data), 'unrelated data file emitted a workspace event')

  const close = watcher.close()
  assert.equal(watcher.close(), close, 'closing a worker is idempotent')
  await close
  const count = events.length
  await fs.writeFile(join(root, 'after-close.md'), '# closed\n')
  await sleep(150)
  assert.equal(events.length, count, 'a stopped worker emitted a late notification')

  const initializing = createWorkspaceWatcher(root, undefined, { native })
  initializing.on('error', (error) => { throw error })
  await initializing.close()
  console.log(`PASS workspace worker (${mode}): non-document filtering, add/rename/delete, directory events, renaming a folder with subfolders, cancellation; main loop max lag ${Math.round(maxLag)}ms`)
} finally {
  clearInterval(heartbeat)
  if (watcher) await watcher.close()
  await fs.rm(root, { recursive: true, force: true })
}
}
