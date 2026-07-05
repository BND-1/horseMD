import { app, BrowserWindow, ipcMain, dialog, Menu, shell, net } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, basename, extname, resolve, sep } from 'node:path'
import fs from 'node:fs/promises'
import { existsSync, statSync, realpathSync, constants as fsConstants } from 'node:fs'
import { exec } from 'node:child_process'
import { tmpdir } from 'node:os'
import chokidar from 'chokidar'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Supported Markdown file types — single source for the open-dialog filter and
// the extension test used while scanning folders / launch args.
const MD_EXTS = ['md', 'markdown', 'mdx', 'txt']
const MD_RE = new RegExp(`\\.(${MD_EXTS.join('|')})$`, 'i')

// Print stylesheet for PDF export — a clean, warm reading layout.
const PDF_CSS = `
  @page { size: A4; margin: 20mm 18mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .doc {
    font-family: 'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Hiragino Sans GB',
      'Source Han Sans SC', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
    font-size: 14.5px; line-height: 1.75; color: #2a2620;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
    word-wrap: break-word;
  }
  .doc > :first-child { margin-top: 0 !important; }
  .doc h1, .doc h2, .doc h3, .doc h4, .doc h5, .doc h6 {
    color: #16130e; font-weight: 700; line-height: 1.3; margin: 1.6em 0 0.6em;
    page-break-after: avoid;
  }
  .doc h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 2px solid #e6e1d8; letter-spacing: -0.01em; }
  .doc h2 { font-size: 1.5em; padding-bottom: 0.2em; border-bottom: 1px solid #ece7de; }
  .doc h3 { font-size: 1.25em; }
  .doc h4 { font-size: 1.05em; }
  .doc h5 { font-size: 1em; }
  .doc h6 { font-size: 0.92em; color: #6b655c; }
  .doc p { margin: 0.85em 0; }
  .doc a { color: #c86b35; text-decoration: none; border-bottom: 1px solid rgba(200,107,53,.35); }
  .doc strong { font-weight: 700; color: #16130e; }
  .doc em { font-style: italic; }
  .doc ul, .doc ol { margin: 0.8em 0; padding-left: 1.6em; }
  .doc li { margin: 0.32em 0; }
  .doc li::marker { color: #c86b35; }
  .doc blockquote {
    margin: 1em 0; padding: 0.5em 1.1em; border-left: 3px solid #c86b35;
    background: rgba(200,107,53,.06); color: #6b655c; border-radius: 0 6px 6px 0;
    page-break-inside: avoid;
  }
  .doc blockquote p { margin: 0.3em 0; }
  .doc code {
    font-family: 'SF Mono', SFMono-Regular, Consolas, Monaco, monospace; font-size: 0.88em;
    background: #f4f1ea; padding: 0.12em 0.4em; border-radius: 4px; color: #b3431f;
  }
  .doc pre {
    background: #f4f1ea; border: 1px solid #e6e1d8; border-radius: 8px;
    padding: 14px 16px; margin: 1em 0; overflow: hidden; page-break-inside: avoid;
  }
  .doc pre code {
    background: none; padding: 0; color: #2a2620; font-size: 0.86em; line-height: 1.6;
    white-space: pre-wrap; word-break: break-word;
  }
  .doc table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.95em; page-break-inside: avoid; }
  .doc th, .doc td { border: 1px solid #e6e1d8; padding: 8px 12px; text-align: left; vertical-align: top; }
  .doc th { background: #f4f1ea; font-weight: 700; color: #16130e; }
  .doc tr:nth-child(even) td { background: #faf8f4; }
  .doc img { max-width: 100%; height: auto; border-radius: 6px; display: block; margin: 1em auto; page-break-inside: avoid; }
  .doc hr { border: none; border-top: 1px solid #e6e1d8; margin: 1.8em 0; }
  .doc input[type="checkbox"] { margin-right: 0.4em; }
`

let mainWindow = null
// When true, the window is allowed to close without re-prompting (the renderer
// has confirmed there are no unsaved changes, or the user chose to discard).
let allowClose = false
// True once a real app quit is underway (Cmd/Ctrl+Q, menu Quit). Lets the close
// handler tell "quit the app" apart from "just close the window" (macOS keeps the
// app running on window close, but Cmd+Q must fully quit).
let isQuitting = false
const watchers = new Map() // folder path -> watcher
const fileWatchers = new Map() // file path -> { watcher, timer }

// ---- Safety net: never let a stray async error abort the whole app ----
// chokidar (and other fs/network async work) can reject with EACCES/EPERM when
// it touches a path we can't read — e.g. watching a folder whose subtree
// includes restricted system files. With Node's default unhandled-rejection
// behaviour an unhandled one of these would crash (SIGABRT) the main process on
// launch. Log and swallow instead; the watcher's own error handler does the rest.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (ignored):', reason?.message || reason)
})
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (ignored):', err?.message || err)
})

// ---- Single instance: route any second launch into the existing window ----
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const { files, folders } = extractArgs(argv)
    focusMainWindow()
    if (folders.length) sendToRenderer('open-folder', folders[0])
    if (files.length) sendToRenderer('open-paths', files)
  })
}

// Split launch args into markdown files and folders. A folder argument (from
// the Explorer "Open with HorseMD" folder menu) opens as a workspace; markdown
// files open as tabs. Non-existent paths and flags are ignored.
function extractArgs(argv) {
  const files = []
  const folders = []
  // The app's own directory (in dev, argv includes "." / the project path). Never
  // open it as a workspace — that's how a bogus relative/CWD workspace slipped in.
  let appDir = null
  try {
    appDir = resolve(app.getAppPath())
  } catch {
    /* not ready yet */
  }
  for (const a of argv.slice(1)) {
    if (a.startsWith('-')) continue
    // Resolve to an absolute path so a relative arg (e.g. ".") never becomes a
    // workspace that later resolves against the process CWD.
    const abs = resolve(a)
    if (appDir && abs === appDir) continue
    if (!existsSync(abs)) continue
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) folders.push(abs)
    else if (MD_RE.test(abs)) files.push(abs)
  }
  return { files, folders }
}

function focusMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#1a1b20',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    // macOS: place the traffic lights at a fixed spot so the renderer can
    // reserve a matching gap (see `.app.is-mac` rules in app.css). y centers the
    // ~12px buttons within the 40px top bar.
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 14 } : undefined,
    // Windows/Linux: no native caption-button overlay — the renderer draws its
    // own minimize / maximize / close controls (so they can have custom hover
    // states). macOS keeps its native traffic lights via hiddenInset above.
    titleBarOverlay: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // Security: keep the renderer isolated from Node. These are Electron's
      // defaults, but we set them explicitly so the posture is obvious and
      // robust against future default changes. sandbox stays off because the
      // preload is an ES module (the sandbox requires a CommonJS preload).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true
    }
  })

  mainWindow.once('ready-to-show', () => {
    focusMainWindow()
    const { files, folders } = extractArgs(process.argv)
    if (folders.length) sendToRenderer('open-folder', folders[0])
    if (files.length) sendToRenderer('open-paths', files)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Security: never let the window navigate away from our own app content
  // (e.g. a malicious link in a Markdown file). Open external URLs in the
  // user's browser instead.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    if (url.startsWith('http')) shell.openExternal(url)
  })

  // Keep the renderer's maximize/restore button icon in sync with the real
  // window state (e.g. double-click drag-to-maximize, OS shortcuts).
  const emitMaxState = () => sendToRenderer('window:maximized', mainWindow?.isMaximized() ?? false)
  mainWindow.on('maximize', emitMaxState)
  mainWindow.on('unmaximize', emitMaxState)

  // Warn about unsaved changes before the window closes (macOS traffic light,
  // the custom Windows close button, Cmd/Ctrl+Q). The dirty state lives in the
  // renderer, so defer the close and ask it; it calls back via 'app:confirm-close'
  // (proceed) or 'app:cancel-close' (abort).
  allowClose = false
  mainWindow.on('close', (e) => {
    if (allowClose) return
    e.preventDefault()
    sendToRenderer('app-close-request')
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// macOS: opening a file from Finder
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (mainWindow) {
    focusMainWindow()
    sendToRenderer('open-paths', [path])
  } else {
    app.whenReady().then(() => sendToRenderer('open-paths', [path]))
  }
})

app.whenReady().then(() => {
  ensureThemesDir()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// A real quit is starting (Cmd/Ctrl+Q, menu Quit, app.quit()). Mark it so the
// window 'close' handler quits the app rather than just closing the window.
app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ----------------------------- IPC: file system -----------------------------

ipcMain.handle('dialog:openFiles', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown', extensions: MD_EXTS },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  return res.canceled ? [] : res.filePaths
})

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  return res.canceled ? null : res.filePaths[0]
})

ipcMain.handle('dialog:saveAs', async (_e, defaultName) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'Untitled.md',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
  })
  return res.canceled ? null : res.filePath
})

// Export the current document (inline-styled HTML from the renderer) to a PDF
// by rendering it in a hidden window and using Chromium's printToPDF.
ipcMain.handle('export:pdf', async (_e, { html, defaultName }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'Untitled.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (res.canceled || !res.filePath) return { canceled: true }

  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${PDF_CSS}</style></head><body><div class="doc">${html}</div></body></html>`

  const tmp = join(app.getPath('temp'), `horsemd-export-${Date.now()}.html`)
  await fs.writeFile(tmp, doc, 'utf8')
  const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: false } })
  try {
    await win.loadFile(tmp)
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    await fs.writeFile(res.filePath, pdf)
  } finally {
    if (!win.isDestroyed()) win.destroy()
    fs.unlink(tmp).catch(() => {})
  }
  shell.openPath(res.filePath)
  return { path: res.filePath }
})

ipcMain.handle('fs:readFile', async (_e, path) => {
  const content = await fs.readFile(path, 'utf8')
  const stat = await fs.stat(path)
  return { content, mtimeMs: stat.mtimeMs }
})

ipcMain.handle('fs:writeFile', async (_e, path, content) => {
  await fs.writeFile(path, content, 'utf8')
  const stat = await fs.stat(path)
  return { mtimeMs: stat.mtimeMs }
})

ipcMain.handle('fs:rename', async (_e, oldPath, newPath) => {
  // Don't clobber an existing different file/folder (fs.rename overwrites
  // silently → data loss). Still allow a case-only rename on case-insensitive
  // filesystems (e.g. Foo.md → foo.md), where target and source are "the same".
  if (existsSync(newPath) && newPath.toLowerCase() !== oldPath.toLowerCase()) {
    throw new Error('A file or folder with that name already exists.')
  }
  await fs.rename(oldPath, newPath)
  return true
})

ipcMain.handle('fs:delete', async (_e, path) => {
  await shell.trashItem(path)
  return true
})

ipcMain.handle('fs:createFile', async (_e, path, content = '') => {
  await fs.writeFile(path, content, { flag: 'wx' })
  return true
})

ipcMain.handle('fs:createDir', async (_e, path) => {
  await fs.mkdir(path, { recursive: true })
  return true
})

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.DS_Store', '.obsidian', 'out', 'dist'])
// Whether to show dotfiles/dotdirs (.claude, .cursor, etc.) in the file tree.
// Set from the renderer via the 'settings:setShowHidden' IPC (#29). Default off.
let showHidden = false

ipcMain.handle('settings:setShowHidden', (_e, val) => {
  showHidden = !!val
  return true
})

async function readTree(dir, depth = 0) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes = []
  for (const e of entries) {
    // Skip dotfiles unless showHidden is on (always allow .gitignore). .git etc.
    // are always skipped via IGNORED_DIRS regardless of this setting.
    if (e.name.startsWith('.') && !showHidden && e.name !== '.gitignore') continue
    if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      nodes.push({ name: e.name, path: full, type: 'dir', children: null })
    } else if (MD_RE.test(e.name)) {
      nodes.push({ name: e.name, path: full, type: 'file' })
    }
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

ipcMain.handle('fs:readDir', async (_e, dir) => readTree(dir))

async function listFilesFlat(root, dir, acc, depth) {
  if (depth > 12 || acc.length > 5000) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && !showHidden) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue
      await listFilesFlat(root, full, acc, depth + 1)
    } else if (MD_RE.test(e.name)) {
      acc.push({ name: e.name, path: full, rel: full.slice(root.length + 1).replace(/\\/g, '/') })
    }
  }
}

ipcMain.handle('fs:listFiles', async (_e, root) => {
  const acc = []
  await listFilesFlat(root, root, acc, 0)
  return acc
})

ipcMain.handle('fs:openFolderTree', async (_e, dir) => ({
  root: { name: basename(dir), path: dir, type: 'dir' },
  children: await readTree(dir)
}))

// Paths we must never descend into: system/device trees that throw EACCES/EPERM
// when watched, plus the usual noise dirs. Watching e.g. "/" would otherwise hit
// /dev/* device files and crash the watcher.
const WATCH_IGNORE_RE =
  /(^|[\\/])(\.(git|obsidian)|node_modules)([\\/]|$)/
// An absolute path: POSIX "/…", Windows "C:\…"/"C:/…", or a UNC "\\…".
const isAbsolutePath = (p) => /^\//.test(p) || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p)
const isRestrictedRoot = (p) => {
  const norm = (p || '').replace(/[\\/]+$/, '')
  if (norm === '' || norm === '/' || norm === '.' || norm === '..') return true
  // A relative path (e.g. ".") resolves against the process CWD — which is "/"
  // when the app is launched by Finder/launchd, so watching it would recurse the
  // whole filesystem (/dev, /System…) and crash. Only ever watch absolute paths.
  if (!isAbsolutePath(norm)) return true
  // macOS system/device trees that are unreadable and would crash a recursive watch.
  return /^\/(dev|proc|System\/Volumes|private\/var\/(db|folders)|\.vol)(\/|$)/.test(norm)
}

// Watch a folder; notify renderer on changes (debounced lightly by chokidar)
ipcMain.handle('watch:start', async (_e, dir) => {
  if (watchers.has(dir)) return true
  // Don't recursively watch the filesystem root or restricted system trees —
  // they contain device/permission-protected files that make the watch throw.
  if (isRestrictedRoot(dir)) return false
  const w = chokidar.watch(dir, {
    ignored: (p) => WATCH_IGNORE_RE.test(p) || isRestrictedRoot(p),
    ignoreInitial: true,
    depth: 12,
    // Don't follow symlinks (they can point into restricted trees) and don't let
    // permission errors bubble up as fatal.
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  })
  // Swallow watcher errors (EACCES/EPERM on protected paths) so they never become
  // an unhandled rejection that crashes the process.
  w.on('error', (err) => console.error('watch:start error (ignored):', err?.message || err))
  let timer = null
  const ping = () => {
    clearTimeout(timer)
    timer = setTimeout(() => sendToRenderer('watch:changed', dir), 120)
  }
  w.on('add', ping).on('unlink', ping).on('addDir', ping).on('unlinkDir', ping)
  watchers.set(dir, w)
  return true
})

ipcMain.handle('watch:stop', async (_e, dir) => {
  const w = watchers.get(dir)
  if (w) {
    await w.close()
    watchers.delete(dir)
  }
  return true
})

// Watch a single open file for external content changes (e.g. an agent edits
// the file on disk). Emits `file:changed` with the new mtime so the renderer
// can reload the tab.
ipcMain.handle('watch:file', async (_e, path) => {
  if (fileWatchers.has(path)) return true
  const w = chokidar.watch(path, {
    ignoreInitial: true,
    // Poll the file (instead of native fs events). Many editors/tools save via
    // "atomic replace" (write temp + rename over), which swaps the file's inode
    // and makes a native single-file watch go deaf after the first such save.
    // Polling re-stats the path, so it keeps catching changes regardless.
    // Interval is 1s (not chokidar's 400ms default): with N open tabs that is N
    // libuv stats every second indefinitely, and on Windows each stat is hooked
    // by Defender real-time scanning — the threadpool contention worsened the
    // background load (and thus large-doc responsiveness). An external edit is
    // still detected within ~1s. (The renderer already ignores same/older-mtime
    // echoes on file:changed, so a slower poll costs nothing but detection lag.)
    usePolling: true,
    interval: 1000,
    binaryInterval: 1200,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  })
  const entry = { watcher: w, timer: null }
  const notify = async () => {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(async () => {
      let mtimeMs = 0
      try {
        mtimeMs = (await fs.stat(path)).mtimeMs
      } catch {
        /* file may have been removed */
      }
      sendToRenderer('file:changed', { path, mtimeMs })
    }, 80)
  }
  w.on('change', notify).on('add', notify)
  w.on('error', (err) => console.error('watch:file error (ignored):', err?.message || err))
  fileWatchers.set(path, entry)
  return true
})

ipcMain.handle('watch:unfile', async (_e, path) => {
  const entry = fileWatchers.get(path)
  if (entry) {
    clearTimeout(entry.timer)
    await entry.watcher.close()
    fileWatchers.delete(path)
  }
  return true
})

ipcMain.handle('shell:openExternal', async (_e, url) => shell.openExternal(url))
ipcMain.handle('shell:showInFolder', async (_e, path) => shell.showItemInFolder(path))

// ----------------------------- custom themes -------------------------------
// User-supplied CSS themes (e.g. migrated Typora themes) live in a `themes`
// folder under userData. Users drop a .css file in — OR a whole downloaded theme
// folder (Typora themes often ship as `name/coding/name.css` + assets), so we
// scan subfolders too. The renderer lists them, reads the CSS, and injects it.
const themesDir = () => join(app.getPath('userData'), 'themes')
async function ensureThemesDir() {
  try {
    await fs.mkdir(themesDir(), { recursive: true })
  } catch {
    /* ignore */
  }
}

async function collectThemeCss(dir, root, depth, acc) {
  if (depth > 4 || acc.length > 300) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      await collectThemeCss(full, root, depth + 1, acc)
    } else if (/\.css$/i.test(e.name)) {
      const rel = full.slice(root.length + 1).replace(/\\/g, '/')
      const relDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      acc.push({ file: rel, name: e.name.replace(/\.css$/i, ''), dir: relDir })
    }
  }
}

ipcMain.handle('themes:list', async () => {
  await ensureThemesDir()
  const acc = []
  await collectThemeCss(themesDir(), themesDir(), 0, acc)
  return acc.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file))
})

ipcMain.handle('themes:read', async (_e, file) => {
  // A .css path inside the themes dir (may be nested). Reject traversal.
  if (!file || !/\.css$/i.test(file) || file.includes('..')) throw new Error('Invalid theme file.')
  const root = resolve(themesDir())
  const full = resolve(root, file)
  if (full !== root && !full.startsWith(root + sep)) throw new Error('Invalid theme path.')
  let css = await fs.readFile(full, 'utf8')
  // Rewrite relative url(...) to absolute file:// so theme fonts/images (referenced
  // relative to the CSS file) still load when the CSS is injected into the page.
  const baseDir = dirname(full)
  css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, _q, p) => {
    const t = (p || '').trim()
    if (!t || /^(https?:|data:|file:|blob:)/i.test(t) || t.startsWith('//') || t.startsWith('#')) {
      return m
    }
    try {
      return `url("${pathToFileURL(resolve(baseDir, t)).href}")`
    } catch {
      return m
    }
  })
  return css
})

ipcMain.handle('themes:reveal', async () => {
  await ensureThemesDir()
  return shell.openPath(themesDir())
})

// ----------------------------- image host upload ---------------------------
// Typora-style custom uploader: write the image bytes to a temp file, run the
// user's command with the file path appended as an argument, and return the URL
// it prints to stdout. PicGo-Core (`picgo upload`) and most uploaders print the
// final URL on its own line; we take the last http(s) URL in the output.
function runUploadCommand(command, file) {
  return new Promise((resolve, reject) => {
    const full = `${command} "${file}"`
    exec(
      full,
      { timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = `${stdout || ''}\n${stderr || ''}`
        // Many uploaders exit non-zero but still print the URL; only treat it as a
        // failure if there's no URL anywhere in the output.
        if (err && !/https?:\/\//i.test(out)) {
          reject(new Error((stderr || err.message || '').slice(0, 500)))
          return
        }
        resolve(out)
      }
    )
  })
}

function parseUploadedUrl(out) {
  const lines = String(out)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  // Prefer a line that is exactly a URL (the uploader's final output line).
  const exact = lines.filter((l) => /^https?:\/\/\S+$/i.test(l))
  if (exact.length) return exact[exact.length - 1]
  // Fallback: the first URL found anywhere, trimmed of trailing punctuation.
  const m = String(out).match(/https?:\/\/\S+/i)
  return m ? m[0].replace(/[)\]>"',.]+$/, '') : null
}

ipcMain.handle('image:upload', async (_e, command, name, bytes) => {
  if (!command || !String(command).trim()) return { ok: false, error: 'No upload command configured.' }
  let dir
  try {
    dir = await fs.mkdtemp(join(tmpdir(), 'horsemd-img-'))
    const safe = (name || 'image.png').replace(/[\\/:*?"<>|]/g, '_') || 'image.png'
    const file = join(dir, safe)
    await fs.writeFile(file, Buffer.from(bytes))
    const out = await runUploadCommand(String(command).trim(), file)
    const url = parseUploadedUrl(out)
    if (url) return { ok: true, url }
    return { ok: false, error: out.slice(-500) || 'No URL in command output.' }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  } finally {
    if (dir) fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

// Pick a non-clobbering filename for `name` inside `dir`.
const uniqueImageFile = (dir, name) => {
  const safe = (name || 'image.png').replace(/[\\/:*?"<>|]/g, '_') || 'image.png'
  const ext = extname(safe) || '.png'
  const stem = basename(safe, ext) || 'image'
  let file = join(dir, `${stem}${ext}`)
  let n = 1
  while (existsSync(file)) file = join(dir, `${stem}-${n++}${ext}`)
  return file
}

// The app-global folder where images pasted into an UNSAVED doc are parked (we
// don't know a document folder yet). Mirrors Typora's global image folder; on
// the doc's first save they're moved into its ./assets (see image:inlineForSave).
const pasteImagesDir = () => join(app.getPath('userData'), 'paste-images')

// Save a pasted/dropped image next to the document, in an `assets/` subfolder,
// and return the relative path to insert into the Markdown (Typora-style). This
// is the no-image-host path for a SAVED doc; without it, pasted images become
// in-memory blob: URLs that vanish on reload.
ipcMain.handle('image:save', async (_e, docPath, name, bytes) => {
  try {
    if (!docPath) return { ok: false, error: 'No document path.' }
    const dir = join(dirname(docPath), 'assets')
    await fs.mkdir(dir, { recursive: true })
    const file = uniqueImageFile(dir, name)
    await fs.writeFile(file, Buffer.from(bytes))
    // POSIX-relative link so it round-trips in Markdown on every OS.
    return { ok: true, path: 'assets/' + basename(file) }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
})

// Save an image pasted into an UNSAVED doc to the global paste folder and return
// a file:// URL — so it shows immediately as a real path (not a base64 blob),
// like Typora. It's relocated into ./assets when the doc is first saved.
ipcMain.handle('image:savePaste', async (_e, name, bytes) => {
  try {
    const dir = pasteImagesDir()
    await fs.mkdir(dir, { recursive: true })
    const file = uniqueImageFile(dir, name)
    await fs.writeFile(file, Buffer.from(bytes))
    return { ok: true, url: pathToFileURL(file).href }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
})

// At save time, rewrite a doc's Markdown so no image link is a giant base64 blob
// or an absolute paste-folder path: base64 data URLs and file:// links in the
// global paste folder are written/moved into the doc's ./assets and rewritten to
// short relative paths (the Typora end-state). Other links are left untouched.
ipcMain.handle('image:inlineForSave', async (_e, content, targetPath) => {
  try {
    if (!content || !targetPath) return { content, changed: false }
    const matches = [...content.matchAll(/(!\[[^\]]*\]\()([^)\s]+)(\))/g)]
    if (!matches.length) return { content, changed: false }
    const assetsDir = join(dirname(targetPath), 'assets')
    // Real path so the startsWith test below survives symlinks (e.g. macOS
    // /tmp → /private/tmp), since the link's path and userData may differ.
    let pdir = pasteImagesDir()
    try {
      pdir = realpathSync(pdir)
    } catch {
      /* folder not created yet — nothing to relocate from it */
    }
    let ensured = false
    const ensure = async () => {
      if (!ensured) {
        await fs.mkdir(assetsDir, { recursive: true })
        ensured = true
      }
    }
    let out = ''
    let cursor = 0
    let changed = false
    for (const m of matches) {
      const [full, pre, url] = m
      out += content.slice(cursor, m.index)
      cursor = m.index + full.length
      let replacement = full
      try {
        const dataM = url.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/i)
        if (dataM) {
          await ensure()
          const ext = dataM[1].toLowerCase() === 'jpeg' ? 'jpg' : dataM[1].toLowerCase().replace(/[^a-z0-9]/g, '') || 'png'
          const file = uniqueImageFile(assetsDir, `image.${ext}`)
          await fs.writeFile(file, Buffer.from(dataM[2], 'base64'))
          replacement = pre + 'assets/' + basename(file) + ')'
          changed = true
        } else if (/^file:\/\//i.test(url)) {
          const fsPath = fileURLToPath(url)
          let realFsPath = fsPath
          try {
            realFsPath = realpathSync(fsPath)
          } catch {
            /* missing file — leave the link as-is */
          }
          if (realFsPath.startsWith(pdir) && existsSync(fsPath)) {
            await ensure()
            const file = uniqueImageFile(assetsDir, basename(fsPath))
            await fs.copyFile(fsPath, file)
            fs.rm(fsPath, { force: true }).catch(() => {})
            replacement = pre + 'assets/' + basename(file) + ')'
            changed = true
          }
        }
      } catch {
        /* keep the original link so the image is never lost */
      }
      out += replacement
    }
    out += content.slice(cursor)
    return { content: out, changed }
  } catch {
    return { content, changed: false }
  }
})

// Copy a file next to itself as "<name> copy<ext>", picking a free name.
ipcMain.handle('fs:duplicate', async (_e, path) => {
  const dir = dirname(path)
  const ext = extname(path)
  const stem = basename(path, ext)
  let target = join(dir, `${stem} copy${ext}`)
  let i = 2
  while (existsSync(target)) target = join(dir, `${stem} copy ${i++}${ext}`)
  // COPYFILE_EXCL: fail rather than overwrite if the target appeared between the
  // existsSync check and the copy (TOCTOU).
  await fs.copyFile(path, target, fsConstants.COPYFILE_EXCL)
  return target
})

// ----------------------------- window controls -----------------------------
// Custom min/max/close buttons (the native overlay is disabled so the renderer
// can style their hover states). macOS keeps its native traffic lights.
ipcMain.handle('window:minimize', () => mainWindow?.minimize())
ipcMain.handle('window:toggleMaximize', () => {
  if (!mainWindow) return false
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
  return mainWindow.isMaximized()
})
ipcMain.handle('window:close', () => mainWindow?.close())
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false)

// The renderer confirmed it's safe to close (no unsaved changes, or the user
// chose to discard). If a quit is underway (Cmd/Ctrl+Q), quit the whole app;
// otherwise just close the window (macOS keeps the app running).
ipcMain.on('app:confirm-close', () => {
  allowClose = true
  if (isQuitting) app.quit()
  else mainWindow?.close()
})
// The user cancelled the close. Clear the quit intent so a later window-close
// (e.g. the macOS traffic light) isn't mistaken for a quit.
ipcMain.on('app:cancel-close', () => {
  isQuitting = false
})

// ----------------------------- update check --------------------------------
// Notify-only update check: report the latest published release's version so the
// renderer can show a "new version available" prompt. No download here.
//
// Two sources, tried in order — both shaped into the same return object:
//   1) 官网 latest.json (https://horsemd.yangsir.net/latest.json) — 国内可达,
//      绕开 api.github.com 被墙/超时导致国内用户收不到更新提醒的问题。由
//      scripts/gen-latest-json.mjs 在每次发版后生成、随官网部署。
//   2) GitHub releases/latest API — 回退(官网挂了 / 海外用户)。
// Use Electron's net (Chromium's network stack), NOT Node's global fetch:
// Node's fetch resolves DNS via the bundled c-ares, which can abort() the whole
// main process for an unsigned app launched by Finder/launchd (observed as an
// instant crash on open). net.fetch goes through Chromium's resolver, which
// fails gracefully instead of crashing.
ipcMain.handle('update:check', async () => {
  const sources = [
    {
      url: 'https://horsemd.yangsir.net/latest.json',
      headers: { Accept: 'application/json' },
      // 官网 latest.json 已是 {latest,name,url,notes} 平结构
      pick: (d) => ({
        latest: String(d.latest || '').replace(/^v/i, ''),
        url: d.url,
        name: d.name,
        notes: d.notes
      })
    },
    {
      url: 'https://api.github.com/repos/BND-1/horseMD/releases/latest',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HorseMD-Updater' },
      // GitHub API 结构:tag_name / html_url / name / body(drafts & prereleases
      // 已被该端点排除)
      pick: (d) => ({
        latest: String(d.tag_name || '').replace(/^v/i, ''),
        url: d.html_url,
        name: d.name,
        notes: d.body
      })
    }
  ]
  for (const s of sources) {
    try {
      const res = await net.fetch(s.url, { headers: s.headers })
      if (!res.ok) continue
      const data = await res.json()
      const picked = s.pick(data)
      if (!picked.latest) continue
      return {
        ok: true,
        latest: picked.latest,
        current: app.getVersion(),
        url: picked.url || 'https://github.com/BND-1/horseMD/releases',
        // Release notes (Markdown) so the prompt can show "what's new". Capped
        // so a huge changelog can't bloat the IPC payload / the toast.
        name: typeof picked.name === 'string' ? picked.name : '',
        notes: typeof picked.notes === 'string' ? picked.notes.slice(0, 4000) : ''
      }
    } catch {
      // 网络错误 / DNS 失败 → 试下一个源
    }
  }
  return { ok: false }
})

// Menu actions are forwarded to renderer as commands.
function menuCmd(cmd) {
  return () => sendToRenderer('menu', cmd)
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New File', accelerator: 'CmdOrCtrl+N', click: menuCmd('new') },
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: menuCmd('open') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: menuCmd('openFolder') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: menuCmd('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: menuCmd('saveAs') },
        { label: 'Export as PDF…', accelerator: 'CmdOrCtrl+Shift+E', click: menuCmd('exportPdf') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: menuCmd('closeTab') },
        // macOS: give "Close Window" Shift+Cmd+W so it doesn't fight Close Tab
        // for Cmd+W (role 'close' otherwise defaults to Cmd+W). Windows: Quit.
        isMac ? { role: 'close', accelerator: 'Shift+CmdOrCtrl+W' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: menuCmd('find') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette', accelerator: 'CmdOrCtrl+P', click: menuCmd('palette') },
        // Sidebar toggle is handled in the renderer (capture phase) so it wins
        // over the editor's Ctrl/Cmd+B "bold" binding instead of conflicting.
        { label: 'Toggle Sidebar', click: menuCmd('toggleSidebar') },
        { label: 'Toggle Outline', accelerator: 'CmdOrCtrl+Shift+L', click: menuCmd('toggleOutline') },
        { label: 'Toggle Source Mode', accelerator: 'CmdOrCtrl+/', click: menuCmd('toggleSource') },
        { type: 'separator' },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+Shift+T', click: menuCmd('toggleTheme') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    // Windows/Linux: the bare 'windowMenu' role injects { role:'close' } whose
    // DEFAULT accelerator is CmdOrCtrl+W — which collides with Close Tab (#30),
    // sometimes closing the whole window/app instead of the tab. Use a custom
    // submenu so Close binds Alt+F4 (the Windows standard), leaving Ctrl+W for
    // Close Tab. macOS keeps the bare role (its windowMenu has no 'close').
    isMac
      ? { role: 'windowMenu' }
      : {
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'close', accelerator: 'Alt+F4' }
          ]
        }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
