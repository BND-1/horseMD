import fs from 'node:fs'
import { join, sep } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import chokidar from 'chokidar'
import { isRestrictedWatchRoot, workspaceWatchOptions } from './workspace-watch-policy.js'

if (isRestrictedWatchRoot(workerData.dir)) throw new Error('Restricted workspace watch root')

const post = (event, path) => parentPort.postMessage({ event, path })
const EVENTS = ['add', 'unlink', 'addDir', 'unlinkDir']

// Recursive enumeration and native fs.watch creation run on this thread's
// event loop, never on the Electron main thread that handles windows and IPC.
function watchWithChokidar() {
  const watcher = chokidar.watch(workerData.dir, workspaceWatchOptions(workerData.extensions))
  for (const event of EVENTS) watcher.on(event, (path) => post(event, path))
  watcher.on('error', (error) => parentPort.postMessage({ event: 'error', message: error.message }))
  watcher.on('ready', () => {
    const directories = Object.values(watcher.getWatched())
    parentPort.postMessage({
      event: 'ready',
      watched: { directories: directories.length, entries: directories.reduce((sum, names) => sum + names.length, 0) }
    })
  })
}

// Windows: chokidar opens one watch handle per folder, and Windows refuses
// to rename a folder while anything inside it is open — with a workspace
// open, no folder holding subfolders could be renamed, in HorseMD's own tree
// or in Explorer (EPERM). One recursive watch on the root (what VS Code does)
// keeps subfolders free. Same events and filters as the chokidar path.
function watchNative() {
  const root = workerData.dir
  const options = workspaceWatchOptions(workerData.extensions)
  const ignored = (path, stats) => options.ignored(path, stats)
  const tooDeep = (rel) => rel.split(/[\\/]/).length > options.depth + 1
  const dirs = new Set()
  let entries = 0
  const scan = (dir, depth) => {
    let list = []
    try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of list) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (ignored(path, { isDirectory: () => true }) || depth >= options.depth) continue
        dirs.add(path); entries += 1
        scan(path, depth + 1)
      } else if (entry.isFile() && !ignored(path, { isDirectory: () => false })) entries += 1
    }
  }
  const forgetUnder = (path) => {
    for (const dir of [...dirs]) if (dir === path || dir.startsWith(path + sep)) dirs.delete(dir)
  }
  const watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
    if (eventType !== 'rename') return
    if (!filename) { post('addDir', root); return }
    const path = join(root, String(filename))
    if (tooDeep(String(filename)) || ignored(path)) return
    let stats = null
    try { stats = fs.lstatSync(path) } catch {}
    if (stats?.isDirectory()) {
      if (ignored(path, stats) || dirs.has(path)) return
      dirs.add(path)
      scan(path, String(filename).split(/[\\/]/).length)
      post('addDir', path)
    } else if (stats) {
      if (!ignored(path, stats)) post('add', path)
    } else if (dirs.has(path)) {
      forgetUnder(path)
      post('unlinkDir', path)
    } else if (!ignored(path, { isDirectory: () => false })) {
      post('unlink', path)
    }
  })
  watcher.on('error', (error) => parentPort.postMessage({ event: 'error', message: error.message }))
  scan(root, 0)
  parentPort.postMessage({ event: 'ready', watched: { directories: dirs.size + 1, entries } })
}

const native = workerData.native ?? process.platform === 'win32'
if (native) {
  try { watchNative() } catch { watchWithChokidar() }
} else {
  watchWithChokidar()
}
