import { parentPort, workerData } from 'node:worker_threads'
import chokidar from 'chokidar'
import { isRestrictedWatchRoot, workspaceWatchOptions } from './workspace-watch-policy.js'

if (isRestrictedWatchRoot(workerData.dir)) throw new Error('Restricted workspace watch root')

// Recursive enumeration and native fs.watch creation run on this thread's
// event loop, never on the Electron main thread that handles windows and IPC.
const watcher = chokidar.watch(workerData.dir, workspaceWatchOptions(workerData.extensions))
for (const event of ['add', 'unlink', 'addDir', 'unlinkDir']) {
  watcher.on(event, (path) => parentPort.postMessage({ event, path }))
}
watcher.on('error', (error) => parentPort.postMessage({ event: 'error', message: error.message }))
watcher.on('ready', () => {
  const directories = Object.values(watcher.getWatched())
  parentPort.postMessage({
    event: 'ready',
    watched: { directories: directories.length, entries: directories.reduce((sum, names) => sum + names.length, 0) }
  })
})
