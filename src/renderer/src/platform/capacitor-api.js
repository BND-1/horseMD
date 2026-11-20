// Capacitor implementation of the window.api contract (see src/preload/index.js).
//
// On desktop, window.api is injected by Electron's preload over IPC. On mobile
// there is no preload, so this module provides the SAME interface backed by
// Capacitor plugins. The renderer (App.jsx etc.) only knows the contract, so it
// runs unchanged. Desktop-only capabilities (file watching, window controls,
// native menus, image-host exec) degrade to safe no-ops and are also
// advertised via `capabilities` so the UI can hide what isn't available.
// PDF / HTML export run on the phone too (mobile-export.js).
//
// File model (MVP): an app-private library under Documents/HorseMD. Paths handed
// to the renderer are POSIX-relative to that Documents directory (e.g.
// "HorseMD/notes.md"); the renderer treats `path` as an opaque string.
import { Capacitor, registerPlugin } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { App as CapApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { StatusBar, Style } from '@capacitor/status-bar'
import { Share } from '@capacitor/share'
import { FilePicker } from '@capawesome/capacitor-file-picker'
import { fireToast } from '../ui.js'
import { searchFiles } from '../../../main/globalsearch-core.js'
import { STORE_SETUP_FILES, storeDirectory } from './mobile-sync/store-location.js'

// Files and folders OUTSIDE the app (iCloud Drive, On My iPhone, phone storage,
// a file another app hands us), opened and saved in place like iA Writer /
// Markor do. Native side: ios/App/App/HorseFilesPlugin.swift and
// android/…/HorseFilesPlugin.java. A granted file or folder is a "root"; the
// renderer sees it as a path `ext:<id>/<name>[/<relative path>]`, so tab titles
// and the file tree show real names and everything else treats it as a path.
const HorseFiles = registerPlugin('HorseFiles')
const EXT_RE = /^ext:([a-z0-9]+)\/([^/]+)(?:\/(.+))?$/
const parseExt = (path) => {
  const m = EXT_RE.exec(path || '')
  return m ? { id: m[1], rootName: m[2], rel: m[3] || '' } : null
}
const isExt = (path) => typeof path === 'string' && path.startsWith('ext:')
// A slash cannot be part of a path segment; names with one are shown with ∕.
const extRootPath = (root) => `ext:${root.id}/${String(root.name || 'Untitled').replace(/\//g, '∕')}`
const zh = () => {
  let lang = ''
  try {
    lang = JSON.parse(localStorage.getItem('minimd.session.v1') || '{}').lang || ''
  } catch {}
  return /^zh/i.test(lang || navigator.language || '')
}
// Native error codes → the messages the renderer already shows.
const nativeError = (error) => {
  const code = error?.code
  if (code === 'EEXIST') return new Error('A file or folder with that name already exists.')
  if (code === 'EACCES') {
    return new Error(zh() ? '没有权限访问这个位置了。请从「打开文件」或「添加文件夹」重新选择它。' : 'HorseMD no longer has access to this location. Open it again from Open File or Add Folder.')
  }
  if (code === 'EXDEV') return new Error(zh() ? '这个位置不支持移动到别的文件夹。' : 'This location cannot move items between folders.')
  if (code === 'ENOENT') return Object.assign(new Error(error?.message || 'Not found'), { code: 'ENOENT' })
  return error instanceof Error ? error : new Error(String(error?.message || error))
}
const ext = async (method, args) => {
  try {
    return await HorseFiles[method](args)
  } catch (error) {
    throw nativeError(error)
  }
}

// Where the library lives. iOS Documents is user-visible (Files app) AND writable.
// Android's public Documents is NOT writable on Android 11+ (scoped storage), so
// use the app's external files dir there — always writable, no permission, and
// still browsable in-app (and over USB).
const DIR = Capacitor.getPlatform() === 'ios' ? Directory.Documents : Directory.External
const LIB = 'HorseMD' // library subfolder
const MD_RE = /\.(md|markdown|mdx)$/i

// The editor resolves a relative image against the document's folder as a
// file URL (file:///HorseMD/img/a.png for the library). The web view cannot
// load that; Capacitor serves app files at convertFileSrc(<absolute path>).
// The library's absolute location is asked once at start (a document opens
// later than that). Files of folders added from other apps (ext:) have no
// served URL and keep the link.
let libraryRootUri = null
Filesystem.getUri({ path: LIB, directory: DIR })
  .then(({ uri }) => { libraryRootUri = String(uri || '').replace(/\/+$/, '') })
  .catch(() => {})
const displayUrlForFile = (fileUrl) => {
  if (!libraryRootUri || !/^file:\/\/\/HorseMD(\/|$)/.test(fileUrl)) return fileUrl
  return Capacitor.convertFileSrc(libraryRootUri + fileUrl.slice('file:///HorseMD'.length))
}

const stat = async (path) => {
  try {
    const s = await Filesystem.stat({ path, directory: DIR })
    return s.mtime || 0
  } catch {
    return 0
  }
}

// Ensure the library folder exists (best effort; mkdir is idempotent enough).
const ensureLib = async () => {
  try {
    await Filesystem.mkdir({ path: LIB, directory: DIR, recursive: true })
  } catch {
    /* already exists */
  }
}

// Last mtime HorseMD read or wrote per path: the resume check compares with it.
const knownMtimes = new Map()

const readFile = async (path) => {
  const target = parseExt(path)
  if (target) {
    const res = await ext('read', { id: target.id, rel: target.rel })
    knownMtimes.set(path, res.mtime || 0)
    return { content: res.data, mtimeMs: res.mtime || 0 }
  }
  const res = await Filesystem.readFile({ path, directory: DIR, encoding: Encoding.UTF8 })
  const mtimeMs = await stat(path)
  knownMtimes.set(path, mtimeMs)
  return { content: res.data, mtimeMs }
}

// options.expectedMtimeMs (auto-save, merge-on-save): refuse instead of
// overwriting a file another app or iCloud changed since — the same contract
// as the desktop fs:writeFile.
const writeFile = async (path, content, options) => {
  const expected = options?.expectedMtimeMs
  const target = parseExt(path)
  if (target) {
    const res = await ext('write', {
      id: target.id,
      rel: target.rel,
      data: content,
      ...(typeof expected === 'number' && expected > 0 ? { expectedMtime: expected } : {})
    })
    if (res.conflict) return { conflict: res.conflict, mtimeMs: res.mtime }
    // Providers (cloud drives, third-party file apps) are not all careful
    // with writes: read the file back so a save never reports success for
    // bytes that did not land.
    const back = await ext('read', { id: target.id, rel: target.rel })
    if (back.data !== content) {
      throw new Error(zh() ? '保存后读回的内容和写入的不一致，这个位置可能不支持直接修改。请另存一份。' : 'The saved file reads back differently; this location may not support editing in place. Save a copy instead.')
    }
    knownMtimes.set(path, back.mtime || res.mtime || 0)
    return { mtimeMs: back.mtime || res.mtime || 0 }
  }
  if (typeof expected === 'number' && expected > 0) {
    const current = await stat(path)
    if (!current) return { conflict: 'missing' }
    if (current > expected) return { conflict: 'modified', mtimeMs: current }
  }
  forgetSyncHash(path)
  await Filesystem.writeFile({
    path,
    directory: DIR,
    data: content,
    encoding: Encoding.UTF8,
    recursive: true
  })
  const mtimeMs = await stat(path)
  knownMtimes.set(path, mtimeMs)
  return { mtimeMs }
}

const exists = async (path) => {
  const target = parseExt(path)
  if (target) {
    try {
      return !!(await ext('stat', { id: target.id, rel: target.rel })).exists
    } catch {
      return false
    }
  }
  try {
    await Filesystem.stat({ path, directory: DIR })
    return true
  } catch {
    return false
  }
}

const createFile = async (path, content = '') => {
  const target = parseExt(path)
  if (target) {
    await ext('create', { id: target.id, rel: target.rel, data: content })
    return true
  }
  if (await exists(path)) throw new Error('A file with that name already exists.')
  await Filesystem.writeFile({
    path,
    directory: DIR,
    data: content,
    encoding: Encoding.UTF8,
    recursive: true
  })
  return true
}

const createDir = async (path) => {
  const target = parseExt(path)
  if (target) {
    await ext('mkdir', { id: target.id, rel: target.rel })
    return true
  }
  await Filesystem.mkdir({ path, directory: DIR, recursive: true })
  return true
}

const rename = async (oldPath, newPath) => {
  const from = parseExt(oldPath)
  const to = parseExt(newPath)
  if (from || to) {
    if (!from || !to || from.id !== to.id || !from.rel || !to.rel) throw nativeError({ code: 'EXDEV' })
    await ext('move', { id: from.id, from: from.rel, to: to.rel })
    return true
  }
  if (newPath.toLowerCase() !== oldPath.toLowerCase() && (await exists(newPath))) {
    throw new Error('A file or folder with that name already exists.')
  }
  forgetSyncHash(oldPath)
  forgetSyncHash(newPath)
  await Filesystem.rename({ from: oldPath, to: newPath, directory: DIR, toDirectory: DIR })
  return true
}

const deleteItem = async (path) => {
  const target = parseExt(path)
  if (target) {
    await ext('remove', { id: target.id, rel: target.rel })
    return true
  }
  forgetSyncHash(path)
  // Try as file first, then as directory.
  try {
    await Filesystem.deleteFile({ path, directory: DIR })
  } catch {
    await Filesystem.rmdir({ path, directory: DIR, recursive: true })
  }
  return true
}

const dropExt = (name) => name.replace(/\.[^.]+$/, '')
const extOf = (name) => (name.match(/\.[^.]+$/) || [''])[0]
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const baseOf = (path) => (path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path)

const duplicate = async (path) => {
  const { content } = await readFile(path)
  const dir = dirOf(path)
  const name = baseOf(path)
  let copy = `${dropExt(name)} copy${extOf(name)}`
  let target = dir ? `${dir}/${copy}` : copy
  let n = 2
  while (await exists(target)) {
    copy = `${dropExt(name)} copy ${n++}${extOf(name)}`
    target = dir ? `${dir}/${copy}` : copy
  }
  await writeFile(target, content)
  return true
}

// A folder the user added that is gone (deleted, moved off the device, grant
// revoked): say so once instead of showing it as an empty folder forever.
const warnedLostRoots = new Set()
const warnLostRoot = (dir, error) => {
  const target = parseExt(dir)
  if (!target || target.rel || warnedLostRoots.has(target.id)) return
  warnedLostRoots.add(target.id)
  fireToast(zh()
    ? `找不到「${target.rootName}」了，它可能被删除或移走了。长按它可以从工作区移除，或用「添加文件夹」重新选择。`
    : `"${target.rootName}" cannot be found; it may have been deleted or moved. Long-press it to remove it from the workspace, or add it again.`, { sticky: true })
  void error
}

const extEntries = async (dir) => {
  const target = parseExt(dir)
  const { entries } = await ext('list', { id: target.id, rel: target.rel })
  return entries || []
}

const readTree = async (dir) => {
  if (isExt(dir)) {
    let entries
    try {
      entries = await extEntries(dir)
    } catch (error) {
      warnLostRoot(dir, error)
      return []
    }
    const nodes = []
    for (const e of entries) {
      if (!e.name || e.name.startsWith('.')) continue
      const full = `${dir}/${e.name}`
      if (e.type === 'dir') nodes.push({ name: e.name, path: full, type: 'dir', children: null })
      else if (MD_RE.test(e.name)) nodes.push({ name: e.name, path: full, type: 'file' })
    }
    return nodes.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)))
  }
  let files
  try {
    files = (await Filesystem.readdir({ path: dir || LIB, directory: DIR })).files
  } catch {
    return []
  }
  const nodes = []
  for (const e of files) {
    if (e.name.startsWith('.')) continue
    const full = dir ? `${dir}/${e.name}` : e.name
    if (e.type === 'directory') nodes.push({ name: e.name, path: full, type: 'dir', children: null })
    else if (MD_RE.test(e.name)) nodes.push({ name: e.name, path: full, type: 'file' })
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

const listFilesFlat = async (root, dir, acc, depth) => {
  if (depth > 12 || acc.length > 5000) return
  let files
  try {
    files = (await Filesystem.readdir({ path: dir, directory: DIR })).files
  } catch {
    return
  }
  for (const e of files) {
    if (e.name.startsWith('.')) continue
    const full = `${dir}/${e.name}`
    if (e.type === 'directory') await listFilesFlat(root, full, acc, depth + 1)
    else if (MD_RE.test(e.name))
      acc.push({ name: e.name, path: full, rel: full.slice(root.length + 1) })
  }
}

const listExtFlat = async (root, dir, acc, depth) => {
  if (depth > 12 || acc.length > 5000) return
  let entries
  try {
    entries = await extEntries(dir)
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.name || e.name.startsWith('.')) continue
    const full = `${dir}/${e.name}`
    if (e.type === 'dir') await listExtFlat(root, full, acc, depth + 1)
    else if (MD_RE.test(e.name)) acc.push({ name: e.name, path: full, rel: full.slice(root.length + 1) })
  }
}

const listFiles = async (root) => {
  const acc = []
  if (isExt(root)) await listExtFlat(root, root, acc, 0)
  else await listFilesFlat(root, root, acc, 0)
  return acc
}

const openFolderTree = async (dir) => ({
  root: { name: baseOf(dir), path: dir, type: 'dir' },
  children: await readTree(dir)
})

// Copy picked bytes into the library (the fallback when a file cannot be
// edited in place).
const importCopy = async (name, base64) => {
  await ensureLib()
  name = name || 'Untitled.md'
  let path = `${LIB}/${name}`
  let n = 2
  while (await exists(path)) path = `${LIB}/${dropExt(name)} ${n++}${extOf(name)}`
  await Filesystem.writeFile({ path, directory: DIR, data: base64 || '', recursive: true })
  return path
}

// Open File…: the system picker, edited IN PLACE (iA Writer, Runestone,
// Markor) — saving writes the file the user picked, and the grant is kept so
// it reopens after a restart. Only a build without the native plugin falls
// back to importing copies.
const openFiles = async () => {
  if (Capacitor.isPluginAvailable('HorseFiles')) {
    const { roots = [] } = await ext('pickFiles', { multiple: true })
    return roots.map(extRootPath)
  }
  return openFilesAsCopies()
}

const openFilesAsCopies = async () => {
  let picked
  try {
    picked = await FilePicker.pickFiles({ readData: true })
  } catch {
    return [] // user cancelled
  }
  await ensureLib()
  const out = []
  // f.data is base64 of the raw bytes; written without text encoding to keep them.
  for (const f of picked.files || []) out.push(await importCopy(f.name, f.data))
  return out
}

// Add Folder…: any folder the system picker offers (iCloud Drive, On My
// iPhone, phone storage, SD card), read and written in place. The app's own
// library stays in the workspace on its own (useWorkspace: libraryRoot).
const openFolder = async () => {
  if (!Capacitor.isPluginAvailable('HorseFiles')) return LIB
  const { root } = await ext('pickFolder', {})
  return root ? extRootPath(root) : null
}

// 全局搜索 on a phone: the same pure matcher the desktop main process uses
// (globalsearch-core.js), over the workspace roots read here. It used to be
// missing on mobile, so a search spun forever.
const searchCache = new Map() // path → { mtimeMs, content }
const searchWorkspace = async ({ roots = [], query = '' } = {}) => {
  const entries = []
  for (const root of roots) {
    for (const file of await listFiles(root).catch(() => [])) {
      try {
        const mtimeMs = isExt(file.path) ? 0 : await stat(file.path)
        const cached = searchCache.get(file.path)
        let content
        if (cached && mtimeMs && cached.mtimeMs === mtimeMs) content = cached.content
        else {
          ;({ content } = await readFile(file.path))
          if (content.length > 2 * 1024 * 1024) continue
          searchCache.set(file.path, { mtimeMs, content })
        }
        entries.push({ ...file, content })
      } catch {
        /* unreadable file: skip */
      }
    }
  }
  const { terms, files, truncated, matchTotal } = searchFiles(entries, query)
  return { terms, files, truncated, matchTotal }
}

// "name (冲突副本 <device> <time>).md" next to the file when the folder is
// reachable, else in the library — the desktop fs:conflictCopyPath contract.
const conflictCopyPath = async (path) => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`
  const device = platform === 'ios' ? 'iPhone' : 'Android'
  const target = parseExt(path)
  const name = baseOf(path)
  const dir = target && !target.rel ? LIB : dirOf(path) || LIB
  for (let n = 1; n < 100; n += 1) {
    const suffix = `${zh() ? '冲突副本' : 'conflicted copy'} ${device} ${stamp}${n > 1 ? ` ${n}` : ''}`
    const candidate = `${dir}/${dropExt(name)} (${suffix})${extOf(name) || '.md'}`
    if (!(await exists(candidate))) return candidate
  }
  throw new Error(zh() ? '冲突副本太多，请先整理这个文件夹。' : 'Too many conflicted copies; tidy this folder first.')
}

// "Save As" within the library: hand back a non-clobbering library path; the
// renderer then writeFile()s the content to it.
const saveAs = async (defaultName) => {
  await ensureLib()
  const name = defaultName || 'Untitled.md'
  let path = `${LIB}/${name}`
  let n = 2
  while (await exists(path)) path = `${LIB}/${dropExt(name)} ${n++}${extOf(name)}`
  return path
}

// ---- main→renderer events ---------------------------------------------------
// Most desktop event sources (watch, menus, window state, close-request) don't
// exist on mobile, so their subscribers are no-ops returning an unsubscribe fn.
const noopOff = () => () => {}

// Another app hands us a file ("Open with HorseMD", Share → HorseMD, the
// Files app). Edited in place when the sender lets us keep access (Files /
// file managers / cloud drives); otherwise (WeChat, mail attachments) it is
// imported as a copy into the library and a toast says so.
const onOpenPaths = (cb) => {
  if (!Capacitor.isPluginAvailable('HorseFiles')) return noopOff()
  const seen = new Set()
  const handle = async (item) => {
    const url = item?.url
    if (!url || seen.has(url)) return
    seen.add(url)
    setTimeout(() => seen.delete(url), 3000)
    try {
      const res = await ext('adopt', { url, inPlace: !!item.inPlace })
      // `rel`: the file is inside a folder the user added → that folder's path,
      // so an already open tab is focused instead of a second one.
      if (res.root) return cb([res.rel ? `${extRootPath(res.root)}/${res.rel}` : extRootPath(res.root)])
      if (res.copy) {
        const dest = await importCopy(res.copy.name, res.copy.data)
        cb([dest])
        // Shared text (Android SEND with EXTRA_TEXT) has no original to edit.
        const sharedText = /horsefiles-incoming\//.test(url)
        fireToast(zh()
          ? sharedText
            ? `已存为 HorseMD 文件夹里的「${res.copy.name}」。`
            : `发送「${res.copy.name}」的应用不允许直接修改原文件，已存一份到 HorseMD 文件夹。`
          : sharedText
            ? `Saved as "${res.copy.name}" in the HorseMD folder.`
            : `The app that sent "${res.copy.name}" does not allow editing it in place; a copy is saved in the HorseMD folder.`, { duration: 6000 })
      }
    } catch (error) {
      fireToast(`${zh() ? '打不开这个文件：' : 'Cannot open this file: '}${error?.message || error}`, { sticky: true })
    }
  }
  let listener
  HorseFiles.addListener('incoming', handle).then((h) => (listener = h))
  ext('pendingIncoming', {}).then(({ items = [] }) => items.forEach(handle)).catch(() => {})
  return () => listener?.remove()
}

// No file watcher on a phone: when the app comes back to the foreground,
// files another app or iCloud changed meanwhile are reported like a desktop
// watcher event (useFileOps reloads clean tabs, warns about dirty ones).
const watchedFiles = new Set()
const fileChangedListeners = new Set()
const checkWatchedFiles = async () => {
  for (const path of [...watchedFiles]) {
    let mtimeMs = 0
    const target = parseExt(path)
    try {
      mtimeMs = target ? (await ext('stat', { id: target.id, rel: target.rel })).mtime || 0 : await stat(path)
    } catch {
      continue
    }
    const known = knownMtimes.get(path)
    if (!mtimeMs || !known || mtimeMs <= known) continue
    knownMtimes.set(path, mtimeMs)
    for (const cb of fileChangedListeners) cb({ path, mtimeMs })
  }
}
let resumeHooked = false
const onFileChanged = (cb) => {
  fileChangedListeners.add(cb)
  if (!resumeHooked) {
    resumeHooked = true
    CapApp.addListener('appStateChange', ({ isActive }) => { if (isActive) checkWatchedFiles() })
  }
  return () => fileChangedListeners.delete(cb)
}

// The desktop watcher's folder event (useWorkspace refreshes the tree). A
// phone has no watcher; cloud sync reports the library after a run.
const watchChangedListeners = new Set()
const onWatchChanged = (cb) => {
  watchChangedListeners.add(cb)
  return () => watchChangedListeners.delete(cb)
}
// A sync run wrote / removed files in the library: open tabs follow through
// the external-change path (useFileOps reloads clean tabs, warns about dirty
// ones — a dirty tab's file is never touched by the sync) and the tree
// re-reads its folders.
const notifyLocalChange = (dir) => {
  checkWatchedFiles().catch(() => {})
  for (const cb of [...watchChangedListeners]) {
    try { cb(dir) } catch { /* listener error */ }
  }
}

// Foreground state: automatic sync runs only while the app is in front
// (hooks/useAutoSync.js reads isAppActive / onAppStateChange).
let appActive = typeof document === 'undefined' || document.visibilityState !== 'hidden'
const appStateListeners = new Set()
let appStateHooked = false
const hookAppState = () => {
  if (appStateHooked) return
  appStateHooked = true
  CapApp.getState?.().then(({ isActive }) => { appActive = isActive !== false }).catch(() => {})
  CapApp.addListener('appStateChange', ({ isActive }) => {
    appActive = isActive !== false
    for (const cb of [...appStateListeners]) {
      try { cb(appActive) } catch { /* listener error */ }
    }
  }).catch(() => {})
}
const onAppStateChange = (cb) => {
  hookAppState()
  appStateListeners.add(cb)
  return () => appStateListeners.delete(cb)
}

// Share a document out (system sheet). An external file is shared from a
// temporary copy in the cache (the share sheet needs a plain file URL).
const shareFile = async (path) => {
  try {
    let uri
    if (isExt(path)) {
      const { content } = await readFile(path)
      const tmp = `share/${baseOf(path)}`
      await Filesystem.writeFile({ path: tmp, directory: Directory.Cache, data: content, encoding: Encoding.UTF8, recursive: true })
      ;({ uri } = await Filesystem.getUri({ path: tmp, directory: Directory.Cache }))
    } else {
      ;({ uri } = await Filesystem.getUri({ path, directory: DIR }))
    }
    await Share.share({ files: [uri], dialogTitle: 'HorseMD' })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

const platform = Capacitor.getPlatform() // 'ios' | 'android' | 'web'

// Make the system status bar blend with the app: draw the web content behind a
// transparent status bar (so the themed top bar fills the notch/status area),
// flip the clock/icons dark↔light as the theme changes, and inset the app's top
// bar by the REAL status bar height.
//
// On Android, env(safe-area-inset-top) only reflects a display cutout, NOT the
// status bar height — and MIUI ignores setOverlaysWebView(false), so the top bar
// collided with the clock/battery (Xiaomi). Instead we overlay on BOTH platforms
// (like iOS) and inset by the measured StatusBar height, which is reliable on
// every device (MIUI / Huawei / tablets). The themed top bar shows through the
// transparent status bar.
// "rgb(r, g, b)" / "rgba(r, g, b, a)" → "#rrggbb" (transparent → null).
const cssColorToHex = (value) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value || '')
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null
  return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
}

const setupStatusBar = () => {
  if (platform !== 'android' && platform !== 'ios') return
  if (platform === 'android') StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {})
  // Android 15+ draws edge to edge and Capacitor's SystemBars handles it:
  // it either pads the WebView below the status bar or passes the inset
  // through as --safe-area-inset-top. Adding the measured status bar height
  // too left an empty band above the top bar (Android 15, #175).
  const androidMajor = Number((/Android (\d+)/.exec(navigator.userAgent) || [])[1] || 0)
  const applyInset = () => {
    if (platform === 'android' && androidMajor >= 15) {
      document.documentElement.style.removeProperty('--hm-safe-top')
      return
    }
    StatusBar.getInfo()
      .then((info) => {
        if (info && info.height > 0) {
          document.documentElement.style.setProperty('--hm-safe-top', info.height + 'px')
        }
      })
      .catch(() => {
        /* CSS falls back to env(safe-area-inset-top), which works on iOS */
      })
  }
  const apply = () => {
    const dark =
      document.body.classList.contains('dark') ||
      document.body.classList.contains('theme-morandi-dark')
    StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {})
    applyInset()
    // The strips Android 15+ keeps outside the WebView take the top bar's
    // colour (see HorseFilesPlugin.setSystemBarColor).
    if (platform === 'android' && Capacitor.isPluginAvailable('HorseFiles')) {
      requestAnimationFrame(() => {
        // With the drawer open the status bar sits above the drawer, so it
        // takes the drawer's colour (Gmail / Files) instead of the top bar's.
        const bar = document.querySelector('.app.drawer-open .pane-left') || document.querySelector('.app .topbar') || document.body
        const hex = cssColorToHex(getComputedStyle(bar).backgroundColor) || cssColorToHex(getComputedStyle(document.body).backgroundColor)
        if (hex) HorseFiles.setSystemBarColor({ color: hex }).catch(() => {})
      })
    }
  }
  apply()
  // Re-apply the icon style when App swaps the theme classes on <body>.
  new MutationObserver(apply).observe(document.body, {
    attributes: true,
    attributeFilter: ['class']
  })
  // …and when the drawer opens or closes (a class on .app, rendered later).
  if (platform === 'android') {
    let watched = null
    const watchApp = () => {
      const app = document.querySelector('.app')
      if (!app || app === watched) return
      watched = app
      let open = app.classList.contains('drawer-open')
      new MutationObserver(() => {
        const now = app.classList.contains('drawer-open')
        if (now !== open) { open = now; apply() }
      }).observe(app, { attributes: true, attributeFilter: ['class'] })
    }
    const root = document.getElementById('root') || document.body
    new MutationObserver(watchApp).observe(root, { childList: true })
    watchApp()
  }
}

const capabilities = {
  folderWorkspace: false, // iOS sandbox; Android SAF comes later
  watch: false,
  windowControls: false,
  closeToTray: false,
  globalShortcuts: false,
  devtools: false,
  // PDF / HTML Studio (mobile-export.js): rendered natively (HorsePdf), saved
  // through the share sheet. A native shell without HorsePdf hides PDF.
  pdfExport: Capacitor.isPluginAvailable('HorsePdf'),
  htmlExport: true,
  // What the phone PDF path cannot do: header / footer text and the document
  // title line (no Chromium header/footer templates) and bookmarks. Page
  // numbers and page ranges work (pdf-lib, shared/export/pdf-postprocess.js).
  // Desktop has no pdfOptions: everything is shown there.
  pdfOptions: { headerFooterText: false, outline: false },
  pandocExport: false,
  imageHostExec: false,
  nativeMenus: false,
  externalShell: true,
  revealInFolder: false, // no Finder/Explorer on mobile
  splitView: false, // not enough width on a phone
  // No keyboard assumed: no shortcut hints, no shortcut settings (#175).
  keyboardShortcuts: false,
  // The phone has its own lock (mobileReadOnly); desktop reading mode is off.
  readingMode: false,
  // No themes folder on a phone (themesList is empty).
  customThemes: false,
  // Updates come from the app store / TestFlight / a new APK, not in-app.
  updates: false,
  canShare: true, // system share sheet (export a file out)
  // No installed-font list in a phone WebView (queryLocalFonts), so the font
  // pickers offered only 默认 under the keyboard.
  localFonts: false,
  // The narrowest page width (600 px) is wider than a phone screen.
  pageWidth: false,
  fileAttachments: false,
  // Phase 1 syncs the library folder only (docs/mobile-cloud-sync-architecture.md);
  // needs the native HTTP client and the Keychain / Keystore store.
  cloudSync: Capacitor.isPluginAvailable('HorseHttp') && Capacitor.isPluginAvailable('HorseSecureStore'),
  nativeDropOpen: false
}

// Android's back button / gesture. With no listener Capacitor finishes the
// activity: back with a menu, the drawer or a dialog open left the app
// (mobile review 2026-11-14). Like every Android app: back first closes what
// is on top — a menu, sheet, palette or dialog (Escape, else its backdrop),
// then the drawer, then full-screen mode; only then the app goes to the
// background (minimize, so the open documents stay as they are).
const OVERLAYS = '.menu-backdrop, .context-menu, .tab-ctxmenu, .palette-overlay, .block-switch-menu, .milkdown-slash-menu, [role="dialog"], [role="alertdialog"], .hm-toast.sticky'
// Backdrops whose press closes what they cover (not the drawer's scrim: a
// menu inside the drawer closes first, the drawer on the next back).
const BACKDROPS = '.menu-backdrop, .palette-overlay'
// Some overlays stay in the DOM while hidden (the slash menu).
const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && el.dataset.show !== 'false'
const closeTopLayer = () => {
  const escape = () => (document.activeElement || document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true })
  )
  const open = [...document.querySelectorAll(OVERLAYS)].find(shown)
  if (open) {
    escape()
    if (open.isConnected && shown(open)) {
      const backdrop = [...document.querySelectorAll(BACKDROPS)].find(shown)
      if (backdrop) {
        backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        backdrop.click()
      }
    }
    if (open.isConnected && shown(open)) open.querySelector('.hm-toast-close, .hm-alert-secondary')?.click()
    return true
  }
  const scrim = document.querySelector('.app.drawer-open .hm-scrim')
  if (scrim) { scrim.click(); return true }
  if (document.querySelector('.app.hm-immersive')) { escape(); return true }
  return false
}
let backHooked = false
const setupBackButton = () => {
  if (backHooked || platform !== 'android') return
  backHooked = true
  CapApp.addListener('backButton', () => {
    if (!closeTopLayer()) CapApp.minimizeApp().catch(() => {})
  })
}

// ---- PDF / HTML export (lazy) --------------------------------------------------
// mobile-export.js (and pdf-lib with it) loads the first time a studio opens.
let exportLoading = null
const loadExport = () => {
  if (!exportLoading) {
    exportLoading = import('./mobile-export.js')
      .then((m) => m.createMobileExport({ readLocalImage, zh }))
      .catch((error) => {
        exportLoading = null
        throw error
      })
  }
  return exportLoading
}
// `idle`: what a dispose answers before anything was loaded (nothing to free).
const exportCall = (name, idle) => async (...args) => {
  if (idle !== undefined && !exportLoading) return idle
  return (await loadExport())[name](...args)
}
// An exported document's file:// image (editor-images.js resolves a relative
// src against the document's folder: file:///HorseMD/img/a.png for the
// library). Library files are read through Filesystem; other absolute paths
// through Capacitor's local server. Files of folders added from other apps
// (ext:) have no binary read: those images keep their link.
const readLocalImage = async (src) => {
  let path
  try {
    path = decodeURIComponent(new URL(src).pathname)
  } catch {
    return null
  }
  const rel = path.replace(/^\/+/, '')
  if (!rel || rel.startsWith('ext:')) return null
  if (rel === LIB || rel.startsWith(LIB + '/')) {
    try {
      const { data } = await Filesystem.readFile({ path: rel, directory: DIR })
      let bytes
      if (typeof data === 'string') {
        const binary = atob(data)
        bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      } else {
        bytes = new Uint8Array(await data.arrayBuffer())
      }
      return { bytes, contentType: '' }
    } catch { /* fall through */ }
  }
  try {
    const response = await fetch(Capacitor.convertFileSrc('/' + rel))
    if (!response.ok) return null
    return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') || '' }
  } catch {
    return null
  }
}

// ---- cloud sync (lazy) -------------------------------------------------------
// The engine (src/shared/sync/ + ./mobile-sync/) is a separate chunk, loaded
// the first time sync is needed. Until a sync folder or a connection exists,
// the list calls answer from two stat()s and the engine never loads, so app
// start is not slower for people who do not use sync.
let syncModule = null // the loaded { api, … }
let syncLoading = null
const syncProgressListeners = new Set()
const phaseOneError = () => new Error(zh()
  ? '手机上目前只能同步「HorseMD 文件夹」（App 自己的文件夹）。用「添加文件夹」打开的其他位置暂不支持云同步。'
  : 'On a phone only the HorseMD folder (the app\'s own folder) can sync for now. Folders added from other locations do not sync yet.')
const loadSync = () => {
  if (syncModule) return Promise.resolve(syncModule)
  if (!syncLoading) {
    syncLoading = import('./mobile-sync/index.js')
      .then((m) => m.createMobileSync({ directory: DIR, root: LIB, onLocalChange: notifyLocalChange, phaseOneError }))
      .then((loaded) => {
        loaded.api.onSyncProgress((event) => {
          for (const cb of [...syncProgressListeners]) {
            try { cb(event) } catch { /* listener error */ }
          }
        })
        syncModule = loaded
        return loaded
      })
      .catch((error) => {
        syncLoading = null
        throw error
      })
  }
  return syncLoading
}
const syncSetUp = async () => {
  if (syncModule) return true
  for (const path of STORE_SETUP_FILES) {
    try {
      await Filesystem.stat({ path, directory: storeDirectory() })
      return true
    } catch { /* not there */ }
  }
  return false
}
const syncCall = (name) => async (...args) => (await loadSync()).api[name](...args)
// Lists: empty without loading the engine while nothing is set up.
const syncList = (name) => async (...args) => ((await syncSetUp()) ? syncCall(name)(...args) : [])
const forgetSyncHash = (path) => {
  if (syncModule && typeof path === 'string' && !isExt(path)) syncModule.platform.forgetHash(path)
}
const syncApi = () => (capabilities.cloudSync
  ? {
      syncListWorkspaces: syncList('syncListWorkspaces'),
      syncAdoptWorkspace: async (rootPath) => {
        if (String(rootPath || '').replace(/\/+$/, '') !== LIB) throw phaseOneError()
        return syncCall('syncAdoptWorkspace')(rootPath)
      },
      syncRemoveWorkspace: syncCall('syncRemoveWorkspace'),
      syncListConnections: syncList('syncListConnections'),
      syncAddWebDavConnection: syncCall('syncAddWebDavConnection'),
      syncAddS3Connection: syncCall('syncAddS3Connection'),
      syncStartOfficialLogin: syncCall('syncStartOfficialLogin'),
      syncAddOfficialConnection: syncCall('syncAddOfficialConnection'),
      syncOfficialAccount: syncCall('syncOfficialAccount'),
      syncUpdateConnection: syncCall('syncUpdateConnection'),
      syncRemoveConnection: syncCall('syncRemoveConnection'),
      syncTestConnection: syncCall('syncTestConnection'),
      syncBindWorkspaceConnection: syncCall('syncBindWorkspaceConnection'),
      syncUnlockWorkspace: syncCall('syncUnlockWorkspace'),
      syncChangeEncryptionPassword: syncCall('syncChangeEncryptionPassword'),
      syncPreview: syncCall('syncPreview'),
      syncRun: syncCall('syncRun'),
      onSyncProgress: (cb) => {
        syncProgressListeners.add(cb)
        return () => syncProgressListeners.delete(cb)
      },
      // Nothing can run before the engine is loaded.
      syncControl: async (rootPath, action) => (syncModule ? syncModule.api.syncControl(rootPath, action) : false),
      syncStatus: async () => (syncModule ? syncModule.api.syncStatus() : { running: [] }),
      syncListRemoteWorkspaces: syncCall('syncListRemoteWorkspaces'),
      syncJoinWorkspace: syncCall('syncJoinWorkspace')
    }
  : {
      syncListWorkspaces: async () => [],
      syncAdoptWorkspace: async () => { throw new Error('unsupported') },
      syncRemoveWorkspace: async () => false,
      syncListConnections: async () => [],
      syncAddWebDavConnection: async () => { throw new Error('unsupported') },
      syncAddS3Connection: async () => { throw new Error('unsupported') },
      syncStartOfficialLogin: async () => { throw new Error('unsupported') },
      syncAddOfficialConnection: async () => { throw new Error('unsupported') },
      syncOfficialAccount: async () => { throw new Error('unsupported') },
      syncUpdateConnection: async () => { throw new Error('unsupported') },
      syncRemoveConnection: async () => false,
      syncTestConnection: async () => { throw new Error('unsupported') },
      syncBindWorkspaceConnection: async () => { throw new Error('unsupported') },
      syncUnlockWorkspace: async () => { throw new Error('unsupported') },
      syncChangeEncryptionPassword: async () => { throw new Error('unsupported') },
      syncPreview: async () => { throw new Error('unsupported') },
      syncRun: async () => { throw new Error('unsupported') },
      syncListRemoteWorkspaces: async () => [],
      syncJoinWorkspace: async () => { throw new Error('unsupported') }
    })

export function makeCapacitorApi() {
  ensureLib()
  hookAppState()
  setupStatusBar()
  setupBackButton()
  return {
    // dialogs
    openFiles,
    openAttachments: async () => [],
    openFolder,
    saveAs,
    conflictCopyPath,
    searchWorkspace,
    // The app's own folder (Documents/HorseMD): always in the workspace.
    libraryRoot: LIB,
    // PDF / HTML Studio: the desktop preview/save contract (mobile-export.js).
    previewPDF: exportCall('previewPDF'),
    savePDFPreview: exportCall('savePDFPreview'),
    disposePDFPreview: exportCall('disposePDFPreview', false),
    previewHTML: exportCall('previewHTML'),
    saveHTMLPreview: exportCall('saveHTMLPreview'),
    disposeHTMLPreview: exportCall('disposeHTMLPreview', false),
    allowLocalFonts: async () => false,

    // fs
    readFile,
    writeFile,
    rename,
    deleteItem,
    createFile,
    createDir,
    duplicate,
    readDir: readTree,
    listFiles,
    openFolderTree,
    getPathForDroppedFile: () => '',
    classifyDroppedPaths: async () => [],
    ...syncApi(),
    // Foreground state for automatic sync (desktop: not present).
    isAppActive: () => appActive,
    onAppStateChange,

    // watch (no-op on mobile)
    watchStart: async () => true,
    watchStop: async () => true,
    watchFile: async (path) => { if (path) watchedFiles.add(path); return true },
    unwatchFile: async (path) => { watchedFiles.delete(path); return true },

    // shell
    openExternal: (url) => Browser.open({ url }).catch(() => {}),
    openFileUrl: async () => ({ ok: false, error: 'unsupported' }),
    showInFolder: async () => false,
    copyText: async (text) => {
      try {
        await navigator.clipboard?.writeText(String(text ?? ''))
        return true
      } catch {
        return false
      }
    },
    // Export/share a saved file via the system share sheet ("Save to Files",
    // Drive, send, …) — the way to get a copy out where the user can find it.
    // Full-screen mode (view.immersive) hides the system status bar too; the
    // app restores it on exit. Failure is harmless (bars stay visible).
    setSystemBarsHidden: async (hidden) => {
      if (platform !== 'android' && platform !== 'ios') return
      try {
        if (hidden) await StatusBar.hide()
        else await StatusBar.show()
      } catch {}
    },
    shareFile,
    displayUrlForFile,

    // image host (no Node subprocess on mobile)
    uploadImage: async () => ({ ok: false, error: 'unsupported' }),
    saveAttachment: async () => ({ ok: false, error: 'unsupported' }),

    // custom themes — none bundled on mobile yet
    themesList: async () => [],
    themeRead: async () => '',
    themesReveal: async () => false,

    // window controls (no-op)
    windowMinimize: async () => {},
    windowToggleMaximize: async () => {},
    windowClose: async () => {},
    windowIsMaximized: async () => false,
    windowToggleDevTools: async () => false,
    setCloseToTray: async () => ({ ok: false, closeToTray: false }),
    toggleWindowVisibility: async () => ({ ok: false }),
    setGlobalShortcuts: async () => ({ ok: false, accelerators: {}, unregistered: [] }),

    // update check — wired up later (CSP/network)
    checkUpdate: async () => null,
    setMenuKeybindings: async () => ({ ok: false, unsupported: true }),
    getMenuKeybindings: async () => ({}),
    getMenuSnapshot: async () => [],

    // app close (no "close window" on mobile)
    confirmAppClose: () => {},
    cancelAppClose: () => {},

    // events
    onOpenPaths,
    onOpenFolderPath: noopOff,
    onMenu: noopOff,
    onWatchChanged,
    onFileChanged,
    onWindowMaximized: noopOff,
    onAppCloseRequest: noopOff,

    platform,
    capabilities
  }
}
