import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { DEFAULT_WATCH_EXTENSIONS } from './workspace-watch-policy.js'

// Source tests load .js; electron-vite emits the sibling worker as .cjs.
const workerModuleUrl = new URL(
  import.meta.url.endsWith('.cjs') ? './workspace-watcher-worker.cjs' : './workspace-watcher-worker.js',
  import.meta.url
)
// Node's worker entry point must also be a real file in packaged builds. The
// builder unpacks this entry and its shared chunks beside app.asar.
const workerUrl = new URL(workerModuleUrl.href.replace('/app.asar/', '/app.asar.unpacked/'))

export function createWorkspaceWatcher(dir, extensions = DEFAULT_WATCH_EXTENSIONS) {
  const watcher = new EventEmitter()
  const worker = new Worker(workerUrl, { workerData: { dir, extensions } })
  let closed = false
  let closePromise = null
  worker.on('message', ({ event, path, message, watched }) => {
    if (closed) return
    if (event === 'error') watcher.emit('error', new Error(message))
    else watcher.emit(event, event === 'ready' ? watched : path)
  })
  worker.on('error', (error) => {
    if (!closed) watcher.emit('error', error)
  })
  worker.on('exit', (code) => {
    if (!closed) watcher.emit('error', new Error(`Workspace watcher exited unexpectedly (${code})`))
  })
  worker.unref()
  watcher.close = () => {
    if (!closePromise) {
      closed = true
      // Do not wait for a busy initializer to consume a stop message. Terminate
      // its event loop and native watch handles without blocking Electron's UI.
      closePromise = worker.terminate().then(() => {})
    }
    return closePromise
  }
  return watcher
}
