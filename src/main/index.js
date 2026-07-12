import { app, BrowserWindow, ipcMain, Menu, shell, net, session, clipboard } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, basename, extname, resolve, sep } from 'node:path'
import fs from 'node:fs/promises'
import { existsSync, statSync, realpathSync, constants as fsConstants } from 'node:fs'
import { exec } from 'node:child_process'
import { tmpdir } from 'node:os'
import { canGrantLocalFonts, createLocalFontGrant, getAllowedExternalUrl } from './security.js'
import { registerDocumentIpc } from './documents.js'
import { registerFileSystemIpc } from './filesystem.js'
import { registerWatcherIpc } from './watchers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Supported Markdown file types — single source for the open-dialog filter and
// the extension test used while scanning folders / launch args.
const MD_EXTS = ['md', 'markdown', 'mdx', 'txt']
const MD_RE = new RegExp(`\\.(${MD_EXTS.join('|')})$`, 'i')

let mainWindow = null
// When true, the window is allowed to close without re-prompting (the renderer
// has confirmed there are no unsaved changes, or the user chose to discard).
let allowClose = false
// True once a real app quit is underway (Cmd/Ctrl+Q, menu Quit). Lets the close
// handler tell "quit the app" apart from "just close the window" (macOS keeps the
// app running on window close, but Cmd+Q must fully quit).
let isQuitting = false
let localFontGrant = null

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

// ---- First-launch open queue (#36): argv files (Win/Linux) and open-file
// events (macOS) arrive before the renderer has registered its open-paths
// listener. Hold them until the renderer signals 'app-ready', then deliver —
// otherwise the launched file is lost and the restored session shows instead.
let pendingLaunch = { files: [], folders: [] }
ipcMain.on('app-ready', () => {
  const { files, folders } = pendingLaunch
  pendingLaunch = { files: [], folders: [] }
  if (folders.length) sendToRenderer('open-folder', folders[0])
  if (files.length) sendToRenderer('open-paths', files)
})

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

async function openExternalUrl(url) {
  const allowedUrl = getAllowedExternalUrl(url)
  if (!allowedUrl) return { ok: false, error: 'Unsupported external URL.' }
  await shell.openExternal(allowedUrl)
  return { ok: true }
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
    // Launch files/folders are delivered on the renderer's 'app-ready' signal
    // (see pendingLaunch below) — sending here races the renderer's IPC listener
    // registration, and the double-clicked file is lost to the restored session
    // (issue #36).
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url)
    return { action: 'deny' }
  })

  // Security: never let the window navigate away from our own app content
  // (e.g. a malicious link in a Markdown file). Open external URLs in the
  // user's browser instead.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    void openExternalUrl(url)
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
    // First launch: queue for the renderer's app-ready handshake (#36).
    if (!pendingLaunch.files.includes(path)) pendingLaunch.files.push(path)
  }
})

app.whenReady().then(() => {
  // Win/Linux: argv carries the launched file/folder. Merge into the launch
  // queue (macOS open-file events already pushed above). Delivered on the
  // renderer's app-ready signal (#36).
  const launched = extractArgs(process.argv)
  for (const f of launched.files) if (!pendingLaunch.files.includes(f)) pendingLaunch.files.push(f)
  for (const d of launched.folders) if (!pendingLaunch.folders.includes(d)) pendingLaunch.folders.push(d)
  ensureThemesDir()
  buildMenu()
  const allowLocalFonts = (webContents, permission, requestingUrl, isMainFrame) =>
    canGrantLocalFonts({
      permission,
      webContentsId: webContents?.id,
      trustedWebContentsId: mainWindow?.webContents.id,
      requestingUrl,
      currentUrl: webContents?.getURL() || '',
      devRendererUrl: process.env.ELECTRON_RENDERER_URL,
      isMainFrame,
      grant: localFontGrant
    })

  // Electron 34 reports Local Font Access as either `local-fonts` or `unknown`,
  // depending on the Chromium path. Only grant it briefly after the settings UI
  // explicitly requests font enumeration; every other permission stays denied.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(allowLocalFonts(webContents, permission, details?.requestingUrl || '', details?.isMainFrame))
  })
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    allowLocalFonts(webContents, permission, details?.requestingUrl || requestingOrigin, details?.isMainFrame)
  )
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

ipcMain.handle('permissions:allowLocalFonts', (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return false
  localFontGrant = createLocalFontGrant(event.sender.id)
  return true
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

registerDocumentIpc(ipcMain, {
  getMainWindow: () => mainWindow,
  markdownExtensions: MD_EXTS
})

registerFileSystemIpc(ipcMain, { shell, markdownPattern: MD_RE })

registerWatcherIpc(ipcMain, { sendToRenderer })

ipcMain.handle('shell:openExternal', async (event, url) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { ok: false, error: 'Untrusted renderer.' }
  }
  return openExternalUrl(url)
})
ipcMain.handle('shell:openFileUrl', async (_e, url) => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return { ok: false, error: 'Only file:// URLs are supported.' }
    const targetPath = fileURLToPath(parsed)
    const error = await shell.openPath(targetPath)
    return error ? { ok: false, error } : { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || 'Invalid file URL.' }
  }
})
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
// final URL on its own line. We parse STDOUT ONLY for the URL — stderr carries
// warnings/errors (e.g. the AWS SDK v2 deprecation notice, whose a.co blog link
// would otherwise be wrongly matched as the upload URL). The PicGo desktop app
// (PicGo.exe) prints nothing useful to stdout but writes `![](url)` to the
// clipboard — the caller falls back to that (see image:upload).
function runUploadCommand(command, file) {
  return new Promise((resolve) => {
    const full = `${command} "${file}"`
    exec(
      full,
      { timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          url: parseUploadedUrl(stdout || ''),
          stdout: stdout || '',
          stderr: stderr || '',
          error: err ? (err.message || String(err)) : '',
        })
      }
    )
  })
}

// PicGo desktop (and uploaders that don't print to stdout) write the result to
// the clipboard — either as `![](url)` markdown or a bare URL. Extract the first
// http(s) URL from the clipboard text.
function extractClipboardUrl(text) {
  if (!text) return null
  const m = String(text).match(/https?:\/\/[^\s)"'<>]+/i)
  return m ? m[0].replace(/[)\]"'.,]+$/, '') : null
}

// PicGo desktop (PicGo.exe) writes the URL to the clipboard ASYNCHRONOUSLY after
// the upload — the `PicGo.exe upload` command returns to the prompt before the
// upload finishes, and the clipboard is written slightly later. So a single read
// right after the command exits races + misses it. Poll the clipboard for a
// short window until it changes to something with a URL.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitForClipboardUrl(beforeText, timeoutMs = 6000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const clip = clipboard.readText()
    if (clip && clip !== beforeText) {
      const url = extractClipboardUrl(clip)
      if (url) return url
    }
    await sleep(intervalMs)
  }
  return null
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

// PicGo app server upload (Typora-compatible, issue #35). The PicGo GUI app has
// no CLI; instead it runs a local HTTP server (default 127.0.0.1:36677) that
// accepts POST /upload with {"list": [<base64 data URI>]} and replies
// {"success": true, "result": [url]}. We POST the image bytes as a data URI and
// read the URL. Uses net.fetch (Chromium stack) like the update check.
async function uploadViaServer(endpoint, name, bytes) {
  const ext = (name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  const mime =
    ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'gif' ? 'image/gif'
    : ext === 'webp' ? 'image/webp'
    : ext === 'svg' ? 'image/svg+xml'
    : 'image/png'
  const dataUri = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
  const res = await net.fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ list: [dataUri] }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`PicGo server HTTP ${res.status}: ${text.slice(0, 200)}`)
  try {
    const j = JSON.parse(text)
    if (j && j.success && Array.isArray(j.result) && j.result[0]) return String(j.result[0])
    if (j && j.success === false) throw new Error(j.message || 'PicGo server returned failure')
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e // JSON but not the expected shape
    /* JSON parsed but the shape wasn't {success, result[]} (e.g. a bare object).
       Salvage any URL from the body instead of failing. */
  }
  return parseUploadedUrl(text) // fallback: any http(s) URL in the body
}

ipcMain.handle('image:upload', async (_e, command, name, bytes) => {
  if (!command || !String(command).trim()) return { ok: false, error: 'No upload command configured.' }
  const cmd = String(command).trim()
  // PicGo app server (Typora-compatible, #35): "picgo" → default server, or any
  // http(s) URL → that endpoint. The PicGo GUI has no CLI; this is how Typora
  // talks to it. Otherwise fall through to the shell-command uploader below.
  let endpoint = cmd
  if (cmd.toLowerCase() === 'picgo') endpoint = 'http://127.0.0.1:36677/upload'
  if (/^https?:\/\//i.test(endpoint)) {
    try {
      const url = await uploadViaServer(endpoint, name, bytes)
      return url ? { ok: true, url } : { ok: false, error: 'No URL in PicGo server response.' }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }
  // Snapshot the clipboard BEFORE the upload — the PicGo desktop app (PicGo.exe)
  // writes `![](url)` to the clipboard instead of stdout, so if stdout has no URL
  // we read the clipboard + only trust it if it CHANGED during the upload (avoids
  // returning stale clipboard content for uploaders that don't touch it).
  const beforeClip = clipboard.readText()
  let dir
  try {
    dir = await fs.mkdtemp(join(tmpdir(), 'horsemd-img-'))
    const safe = (name || 'image.png').replace(/[\\/:*?"<>|]/g, '_') || 'image.png'
    const file = join(dir, safe)
    await fs.writeFile(file, Buffer.from(bytes))
    const res = await runUploadCommand(String(command).trim(), file)
    let url = res.url
    // PicGo.exe writes the URL to the clipboard async (after the command
    // returns), so poll for it instead of a single read (which races).
    if (!url) url = await waitForClipboardUrl(beforeClip)
    if (url) return { ok: true, url }
    return { ok: false, error: (res.stderr || res.stdout || res.error || '').slice(-500) || 'No URL in command output or clipboard.' }
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

const uniqueAssetFile = (dir, name) => {
  const safe = (name || 'attachment').replace(/[\\/:*?"<>|]/g, '_') || 'attachment'
  const ext = extname(safe)
  const stem = ext ? basename(safe, ext) : safe
  let file = join(dir, safe)
  let n = 1
  while (existsSync(file)) file = join(dir, `${stem}-${n++}${ext}`)
  return file
}

ipcMain.handle('attachment:save', async (_e, docPath, sourcePath) => {
  try {
    if (!docPath) return { ok: false, error: 'Save the document before attaching files.' }
    if (!sourcePath) return { ok: false, error: 'No attachment selected.' }
    const st = await fs.stat(sourcePath)
    if (!st.isFile()) return { ok: false, error: 'Only files can be attached.' }
    const assetsDir = join(dirname(docPath), 'assets')
    await fs.mkdir(assetsDir, { recursive: true })

    const sourceReal = realpathSync(sourcePath)
    let assetsReal = assetsDir
    try {
      assetsReal = realpathSync(assetsDir)
    } catch {
      /* just created; resolve() fallback below is enough */
    }
    const inAssets = sourceReal.startsWith(resolve(assetsReal) + sep)
    if (inAssets) return { ok: true, path: 'assets/' + basename(sourcePath), name: basename(sourcePath) }

    const file = uniqueAssetFile(assetsDir, basename(sourcePath))
    await fs.copyFile(sourcePath, file, fsConstants.COPYFILE_EXCL)
    return { ok: true, path: 'assets/' + basename(file), name: basename(sourcePath) }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
})

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
// Notify-only update check: ask GitHub for the latest *published* release
// (drafts/prereleases are excluded by this endpoint) and report its version so
// the renderer can show a "new version available" prompt. No download here.
ipcMain.handle('update:check', async () => {
  try {
    // Use Electron's net (Chromium's network stack), NOT Node's global fetch:
    // Node's fetch resolves DNS via the bundled c-ares, which can abort() the
    // whole main process for an unsigned app launched by Finder/launchd (observed
    // as an instant crash on open). net.fetch goes through Chromium's resolver,
    // which fails gracefully instead of crashing.
    const res = await net.fetch('https://api.github.com/repos/BND-1/horseMD/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HorseMD-Updater' }
    })
    if (!res.ok) return { ok: false }
    const data = await res.json()
    const latest = String(data.tag_name || '').replace(/^v/i, '')
    return {
      ok: true,
      latest,
      current: app.getVersion(),
      url: data.html_url || 'https://github.com/BND-1/horseMD/releases',
      // The release notes (Markdown) so the prompt can show "what's new". Capped
      // so a huge changelog can't bloat the IPC payload / the toast.
      name: typeof data.name === 'string' ? data.name : '',
      notes: typeof data.body === 'string' ? data.body.slice(0, 4000) : ''
    }
  } catch {
    return { ok: false }
  }
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
        { label: 'Attach File…', click: menuCmd('attachFile') },
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
