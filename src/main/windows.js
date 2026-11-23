// Multi-window (tab tear-off): one MAIN window + any number of SECONDARY
// windows. The main window keeps every app-global surface (sidebar, settings,
// update, sync); a secondary is tab bar + editor + status bar.
//
// This module owns:
//   - the registry of app windows (webContents id → entry). Only these
//     webContents are trusted senders (PDF / HTML preview workers are not);
//   - secondary window creation, their close confirm, and the quit
//     preparation the main window's close waits for (app-quit-prepare →
//     app:quit-prepared, 2 s timeout);
//   - tab transfer between windows (drag start / drop index / drag end, move
//     to a new window, move back to main) — payloads are opaque renderer JSON,
//     only `path` is read (routing) and, for persistence, the untitled text;
//   - the open-paths registry (which window holds which file) for routing
//     Finder / Explorer / second-instance opens;
//   - secondary sessions persisted to userData/windows.json and restored
//     after the main renderer is ready.
// The main window itself is still created by index.js (`mainWindow`), which
// registers it here with role 'main'. With no secondary window every main
// code path behaves exactly as before.
import { BrowserWindow, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cleanBounds, nextWindowState } from './window-state-core.js'
import { fitToDisplays, restoredBounds, windowInfo } from './window-state.js'

const WINDOWS_FILE = 'windows.json'
const QUIT_PREPARE_TIMEOUT_MS = 2000
const DROP_WAIT_MS = 400
const DRAG_TTL_MS = 30000
const PERSIST_DEBOUNCE_MS = 500
const MAX_WINDOWS = 50
const MAX_TABS = 200
// Tear-off: the new window's top-left sits this far up-left of the cursor,
// so the cursor lands on the window's tab bar.
const TEAR_OFFSET = { x: 80, y: 20 }
// Menu commands that act on the main window's own surfaces (sidebar panes,
// workspace, settings, home): sent to main and main is focused, whatever
// window is focused.
const MAIN_MENU_COMMANDS = new Set([
  'openFolder', 'toggleSidebar', 'toggleOutline', 'toggleFiles', 'globalSearch', 'settings', 'home'
])
// window:toMain(action) → the main window's menu command.
const TO_MAIN_ACTIONS = {
  settings: 'settings',
  openFolder: 'openFolder',
  globalSearch: 'globalSearch',
  home: 'home',
  toggleSidebar: 'toggleSidebar',
  toggleFiles: 'toggleFiles',
  toggleOutline: 'toggleOutline'
}

const alive = (win) => !!win && !win.isDestroyed() && !win.webContents.isDestroyed()
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const contains = (rect, point) => !!rect && point.x >= rect.x && point.x < rect.x + rect.width &&
  point.y >= rect.y && point.y < rect.y + rect.height
const pathKey = (path) => (process.platform === 'win32' ? String(path).toLowerCase() : String(path))

function cleanPath(value) {
  return typeof value === 'string' && value && value.length <= 4096 ? value : null
}

function cleanPaths(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list.slice(0, 2000)) {
    const path = cleanPath(item)
    if (path && !out.includes(path)) out.push(path)
  }
  return out
}

// The persisted / restorable form of a tab: a file is reopened from disk; an
// untitled tab keeps its text (it is unsaved by definition). An empty
// untitled tab has nothing to restore.
function minimalTab(tab) {
  if (!isPlainObject(tab)) return null
  const path = cleanPath(tab.path)
  const title = typeof tab.title === 'string' ? tab.title.slice(0, 500) : ''
  if (path) return { path, title }
  const text = typeof tab.untitledContent === 'string'
    ? tab.untitledContent
    : (typeof tab.content === 'string' ? tab.content : '')
  if (!text) return null
  return { path: null, title, untitledContent: text }
}

function cleanTabs(list) {
  if (!Array.isArray(list)) return []
  return list.slice(0, MAX_TABS).map(minimalTab).filter(Boolean)
}

function cleanRecord(record) {
  if (!isPlainObject(record)) return null
  const tabs = cleanTabs(record.tabs)
  if (!tabs.length) return null
  return {
    tabs,
    activePath: cleanPath(record.activePath),
    bounds: cleanBounds(record.bounds),
    maximized: record.maximized === true
  }
}

function cleanStripRect(rect) {
  if (!isPlainObject(rect)) return null
  const { left, top, right, bottom } = rect
  if (![left, top, right, bottom].every(finite) || right < left || bottom < top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

// A new window at a point (the cursor, or another window's corner + 32): kept
// on the display under that point.
function boundsAt(point, size) {
  let wa = null
  try {
    wa = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea
  } catch {
    wa = null
  }
  let width = Math.round(size?.width || 1280)
  let height = Math.round(size?.height || 820)
  let x = Math.round(point.x)
  let y = Math.round(point.y)
  if (wa) {
    width = Math.min(width, wa.width)
    height = Math.min(height, wa.height)
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - Math.min(width, 200))
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - 100)
  }
  return { x, y, width, height }
}

export function createWindowManager({
  ipcMain,
  getMainWindow,
  isMainReady,
  focusMain,
  windowOptions,
  installGuards,
  loadRenderer,
  getUserDataPath,
  isQuitting,
  traceQuit = () => {},
  trace = () => {},
  backgroundTestMode = false,
  onSessionEnd = () => {}
}) {
  // webContents id → { win, wcId, role, wid, ready, allowClose, userClosed,
  //   openPaths, session, bounds, maximized, initial, pendingReceive }
  // For the main window `ready` / `allowClose` stay in index.js
  // (rendererReady / allowClose); isReady() reads them through isMainReady.
  const entries = new Map()
  let nextWid = 1
  // Secondary windows hidden together with the main one (close to tray /
  // the show-hide shortcut): shown again with it.
  const trayHidden = new Set()

  const isReady = (entry) => (entry.role === 'main' ? isMainReady() : entry.ready)
  const send = (entry, channel, payload) => {
    if (entry && alive(entry.win)) entry.win.webContents.send(channel, payload)
  }
  const secondaries = () => [...entries.values()].filter((e) => e.role === 'secondary' && alive(e.win))
  const mainEntry = () => {
    const main = getMainWindow()
    return alive(main) ? entries.get(main.webContents.id) || null : null
  }

  function entryOf(event) {
    const sender = event?.sender
    if (!sender || typeof sender.id !== 'number') return null
    const entry = entries.get(sender.id)
    // webContents ids are never reused within a process.
    if (!entry || !alive(entry.win)) return null
    return entry
  }
  const entryOfWebContents = (webContents) => (webContents ? entryOf({ sender: webContents }) : null)

  function focusWin(win) {
    if (!alive(win)) return false
    if (backgroundTestMode) return true
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return true
  }

  // ---- registry ----------------------------------------------------------
  function registerMain(win) {
    const wcId = win.webContents.id
    const entry = {
      win, wcId, role: 'main', wid: 0, ready: false, allowClose: false, userClosed: false,
      openPaths: [], session: null, bounds: null, maximized: false, initial: null, pendingReceive: []
    }
    entries.set(wcId, entry)
    win.once('closed', () => {
      entries.delete(wcId)
      // The main window closes only on a quit (or, with no secondary, on a
      // plain close). Any secondary still open goes with it and comes back
      // on the next launch / the next main window.
      for (const other of secondaries()) {
        other.allowClose = true
        other.userClosed = false
        try { other.win.close() } catch { /* already closing */ }
      }
    })
    return entry
  }

  function holderOf(path) {
    const key = pathKey(path)
    for (const entry of secondaries()) {
      if (entry.openPaths.some((p) => pathKey(p) === key)) return entry
    }
    return null
  }
  const addOpenPath = (entry, path) => {
    if (entry && path && !entry.openPaths.some((p) => pathKey(p) === pathKey(path))) entry.openPaths.push(path)
  }
  const removeOpenPath = (entry, path) => {
    if (entry && path) entry.openPaths = entry.openPaths.filter((p) => pathKey(p) !== pathKey(path))
  }

  // Files opened from Finder / Explorer / a second launch: a file already
  // open in a secondary window goes there (focused, tab activated by its
  // renderer); everything else goes to the main window.
  function planOpenPaths(files = []) {
    const forMain = []
    const groups = new Map()
    for (const file of files) {
      const holder = holderOf(file)
      if (holder && holder.ready) {
        if (!groups.has(holder)) groups.set(holder, [])
        groups.get(holder).push(file)
      } else {
        forMain.push(file)
      }
    }
    return { forMain, groups: [...groups.entries()] }
  }
  function deliverOpenPaths(groups) {
    for (const [entry, paths] of groups) {
      focusWin(entry.win)
      send(entry, 'open-paths', paths)
      trace('open-paths-routed', { wid: entry.wid, count: paths.length })
    }
  }

  // ---- menu ----------------------------------------------------------------
  function sendMenu(cmd, focusedWindow) {
    const win = alive(focusedWindow) ? focusedWindow : BrowserWindow.getFocusedWindow()
    const entry = alive(win) ? entries.get(win.webContents.id) : null
    if (entry?.role === 'secondary') {
      if (MAIN_MENU_COMMANDS.has(cmd)) {
        focusMain()
        const main = mainEntry()
        if (main && isReady(main)) send(main, 'menu', cmd)
        return
      }
      if (entry.ready) send(entry, 'menu', cmd)
      return
    }
    const main = mainEntry()
    if (main && isReady(main)) send(main, 'menu', cmd)
  }

  // ---- show / hide with the main window ------------------------------------
  function hideSecondaries() {
    for (const entry of secondaries()) {
      if (!entry.win.isVisible()) continue
      entry.win.hide()
      trayHidden.add(entry.wcId)
    }
    if (trayHidden.size) traceQuit('secondaries-hidden', { count: trayHidden.size })
  }
  function showHiddenSecondaries() {
    for (const wcId of trayHidden) {
      const entry = entries.get(wcId)
      if (entry && alive(entry.win)) entry.win.showInactive()
    }
    trayHidden.clear()
  }
  const anyFocused = () => [...entries.values()].some((e) => alive(e.win) && e.win.isFocused())

  // ---- persistence (userData/windows.json) ----------------------------------
  // saved: read at start, waiting for the main renderer (restore).
  // kept: secondaries closed by a quit (not by the user) — restored next time.
  let loaded = false
  let saved = []
  let kept = []
  let lastWritten = null
  let persistTimer = null
  const filePath = () => join(getUserDataPath(), WINDOWS_FILE)
  const serialize = (windows) => JSON.stringify({ version: 1, windows })

  function load() {
    if (loaded) return
    loaded = true
    try {
      const parsed = JSON.parse(readFileSync(filePath(), 'utf8'))
      saved = (Array.isArray(parsed?.windows) ? parsed.windows : [])
        .slice(0, MAX_WINDOWS).map(cleanRecord).filter(Boolean)
    } catch {
      saved = []
    }
    lastWritten = serialize(saved)
  }

  function sessionRecord(entry) {
    return {
      tabs: entry.session?.tabs || [],
      activePath: entry.session?.activePath || null,
      bounds: entry.bounds,
      maximized: entry.maximized
    }
  }

  function snapshot() {
    return [...secondaries().map(sessionRecord), ...kept, ...saved]
      .filter((record) => record.tabs.length)
      .slice(0, MAX_WINDOWS)
  }

  // Synchronous and atomic (temp file + rename): it also runs in will-quit,
  // where the process exits before queued async work.
  function persistNow() {
    clearTimeout(persistTimer)
    persistTimer = null
    load()
    const data = serialize(snapshot())
    if (data === lastWritten) return
    const target = filePath()
    const temp = `${target}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(temp, data, 'utf8')
      renameSync(temp, target)
      lastWritten = data
    } catch (error) {
      console.error('windows.json write failed (ignored):', error?.message || error)
    }
  }
  function schedulePersist() {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS)
  }

  // After the main renderer said app-ready: bring back the secondaries of the
  // last run (or those closed with a main window on macOS). A path the main
  // window is opening right now is not opened twice.
  function restoreSaved({ skipPaths = [] } = {}) {
    load()
    const list = [...saved, ...kept]
    saved = []
    kept = []
    if (!list.length) return
    const skip = new Set([...skipPaths, ...(mainEntry()?.openPaths || [])].map(pathKey))
    let restored = 0
    for (const record of list) {
      const tabs = record.tabs.filter((tab) => !tab.path || !skip.has(pathKey(tab.path)))
      if (!tabs.length) continue
      for (const tab of tabs) if (tab.path) skip.add(pathKey(tab.path))
      const activeIndex = Math.max(0, tabs.findIndex((tab) => record.activePath && tab.path === record.activePath))
      createSecondary({
        tabs: tabs.map((tab) => ({ ...tab })),
        activeIndex,
        bounds: fitToDisplays(record.bounds),
        maximized: record.maximized,
        focus: false
      })
      restored++
    }
    trace('windows-restored', { count: restored })
    schedulePersist()
  }

  // ---- secondary windows -----------------------------------------------------
  function createSecondary({ tabs = [], activeIndex = 0, bounds = null, maximized = false, focus = true } = {}) {
    const extra = bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : {}
    const win = new BrowserWindow(windowOptions(extra))
    const wcId = win.webContents.id
    const entry = {
      win, wcId, role: 'secondary', wid: nextWid++, ready: false, allowClose: false, userClosed: false,
      openPaths: cleanPaths(tabs.map((tab) => tab?.path)),
      session: { tabs: cleanTabs(tabs), activePath: cleanPath(tabs[activeIndex]?.path) },
      bounds: null,
      // Restored maximized: stays so until the window says otherwise (it is
      // maximized on ready-to-show, after this).
      maximized: maximized === true,
      initial: { tabs, activeIndex: Math.max(0, Math.min(activeIndex, Math.max(0, tabs.length - 1))) },
      pendingReceive: []
    }
    entries.set(wcId, entry)
    const applied = restoredBounds(win, bounds)
    try { entry.bounds = windowInfo(win, applied).normalBounds } catch { entry.bounds = bounds }

    installGuards(win)
    const emitMaxState = () => send(entry, 'window:maximized', alive(win) && win.isMaximized())
    win.on('maximize', emitMaxState)
    win.on('unmaximize', emitMaxState)
    win.on('session-end', () => onSessionEnd())
    const trackBounds = () => {
      if (!alive(win)) return
      // Minimized / full screen: the last normal state is kept
      // (window-state-core.js nextWindowState).
      try {
        const next = nextWindowState({ bounds: entry.bounds, maximized: entry.maximized }, windowInfo(win, applied))
        if (next) { entry.bounds = next.bounds; entry.maximized = next.maximized }
      } catch { /* closing */ }
      schedulePersist()
    }
    win.on('move', trackBounds)
    win.on('resize', trackBounds)
    win.on('maximize', trackBounds)
    win.on('unmaximize', trackBounds)
    win.on('restore', trackBounds)

    win.once('ready-to-show', () => {
      if (backgroundTestMode || !alive(win)) return
      if (maximized) win.maximize()
      if (focus) focusWin(win)
      else win.showInactive()
    })

    // Its renderer died: nothing will answer app-close-request or
    // app-quit-prepare, so the window closes without asking and a quit does
    // not wait for it (see render-process-gone in index.js).
    win.webContents.on('render-process-gone', (_event, details) => {
      traceQuit('secondary-renderer-gone', { wid: entry.wid, reason: details?.reason })
      if (details?.reason === 'clean-exit') return
      entry.ready = false
      settlePrepare(wcId, 0)
    })

    win.on('close', (event) => {
      traceQuit('secondary-close', { wid: entry.wid, allowClose: entry.allowClose, isQuitting: isQuitting(), ready: entry.ready })
      if (entry.allowClose) return
      // A quit is underway: the main window's close asks every window first
      // (app-quit-prepare) and then closes them all.
      if (isQuitting() && alive(getMainWindow())) {
        event.preventDefault()
        return
      }
      // Its renderer never came up: nothing it holds could be asked about.
      if (!entry.ready) {
        entry.userClosed = !isQuitting()
        return
      }
      event.preventDefault()
      send(entry, 'app-close-request', { closeToTray: false, scope: 'window' })
    })

    win.on('closed', () => {
      entries.delete(wcId)
      trayHidden.delete(wcId)
      if (!entry.userClosed && entry.session?.tabs?.length) kept.push(sessionRecord(entry))
      traceQuit('secondary-closed', { wid: entry.wid, userClosed: entry.userClosed })
      settlePrepare(wcId, 0)
      for (const drag of drags.values()) {
        if (drag.dropWcId === wcId) drag.dropWcId = null
      }
      // A quit writes now (the process may be gone before a timer runs).
      if (isQuitting()) persistNow()
      else schedulePersist()
    })

    loadRenderer(win, { hmWindow: 'secondary', wid: String(entry.wid) })
    trace('window-created', { wid: entry.wid, tabs: tabs.length })
    schedulePersist()
    return entry
  }

  function markReady(entry) {
    if (!entry || entry.role !== 'secondary' || entry.ready) return
    entry.ready = true
    flushPendingReceive(entry)
  }
  function flushPendingReceive(entry) {
    if (!entry.pendingReceive.length) return
    const queued = entry.pendingReceive
    entry.pendingReceive = []
    // After the current IPC reply: the renderer registers onTabReceive before
    // it asks for its initial tabs / says app-ready.
    setImmediate(() => { for (const msg of queued) send(entry, 'tab:receive', msg) })
  }
  function onMainReady() {
    const main = mainEntry()
    if (main) flushPendingReceive(main)
  }

  function deliverTabs(entry, payloads, index = null) {
    const msg = { payloads, index: Number.isInteger(index) && index >= 0 ? index : null }
    for (const payload of payloads) addOpenPath(entry, cleanPath(payload?.path))
    if (isReady(entry)) send(entry, 'tab:receive', msg)
    else entry.pendingReceive.push(msg)
  }

  // ---- close / quit ------------------------------------------------------------
  // Secondary renderer answered its own close confirm.
  function confirmSecondaryClose(entry) {
    traceQuit('secondary-confirmed', { wid: entry.wid, isQuitting: isQuitting() })
    entry.allowClose = true
    entry.userClosed = !isQuitting()
    if (alive(entry.win)) entry.win.close()
  }
  function cancelSecondaryClose(entry) {
    traceQuit('secondary-cancelled', { wid: entry.wid })
  }

  // The main window's close (or a quit) asks every secondary first: each
  // flushes its session and reports its unsaved count; the main renderer's
  // one confirm then covers all of them. Windows that do not answer in 2 s
  // count 0.
  let prepare = null
  function settlePrepare(wcId, dirty) {
    if (!prepare || !prepare.pending.has(wcId)) return
    prepare.pending.delete(wcId)
    prepare.dirty += dirty
    if (!prepare.pending.size) prepare.finish(false)
  }
  function prepareQuit() {
    if (prepare) return prepare.promise
    const all = secondaries()
    const targets = all.filter((entry) => entry.ready)
    traceQuit('quit-prepare-sent', { windows: targets.length, secondaries: all.length })
    if (!targets.length) {
      traceQuit('quit-prepared', { dirty: 0, timedOut: false, missing: 0 })
      return Promise.resolve({ dirty: 0, timedOut: false })
    }
    let resolve
    const promise = new Promise((r) => { resolve = r })
    const state = { pending: new Set(targets.map((entry) => entry.wcId)), dirty: 0, promise, timer: null }
    state.finish = (timedOut) => {
      if (prepare !== state) return
      prepare = null
      clearTimeout(state.timer)
      traceQuit('quit-prepared', { dirty: state.dirty, timedOut, missing: state.pending.size })
      resolve({ dirty: state.dirty, timedOut })
    }
    state.timer = setTimeout(() => state.finish(true), QUIT_PREPARE_TIMEOUT_MS)
    prepare = state
    for (const entry of targets) send(entry, 'app-quit-prepare', { wid: entry.wid })
    return promise
  }
  function onQuitPrepared(entry, info) {
    if (!entry || entry.role !== 'secondary') return
    const n = Number(info?.dirty)
    const dirty = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100000) : 0
    traceQuit('quit-prepared-window', { wid: entry.wid, dirty })
    settlePrepare(entry.wcId, dirty)
  }

  // The main renderer confirmed a quit: every secondary may close without
  // asking again, and keeps its session for the next launch.
  function allowAllToClose() {
    for (const entry of secondaries()) {
      entry.allowClose = true
      entry.userClosed = false
    }
    persistNow()
  }

  // ---- tab transfer --------------------------------------------------------------
  // token → { token, sourceWcId, payload, dropIndex, dropWcId, waiters, timer }
  const drags = new Map()
  function dropDrag(token) {
    const drag = drags.get(token)
    if (!drag) return
    clearTimeout(drag.timer)
    for (const done of drag.waiters) done()
    drags.delete(token)
  }
  // The target cannot always read the token (it may only see the tab id the
  // source put on the drag): an unknown key matches the payload's own id, and
  // otherwise the most recent drag (the OS runs one drag at a time).
  function findDrag(key) {
    if (typeof key === 'string' && drags.has(key)) return drags.get(key)
    const list = [...drags.values()]
    const byId = list.find((drag) => key != null && (drag.payload?.dragId === key || drag.payload?.id === key))
    return byId || list[list.length - 1] || null
  }
  function waitForDrop(drag, ms) {
    if (drag.dropWcId) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        drag.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      drag.waiters.add(done)
    })
  }
  function appWindowAt(point, excludeWcId) {
    for (const entry of entries.values()) {
      if (entry.wcId === excludeWcId || !alive(entry.win)) continue
      if (!entry.win.isVisible() || entry.win.isMinimized()) continue
      if (contains(entry.win.getBounds(), point)) return entry
    }
    return null
  }
  const sizeOf = (entry) => {
    try {
      const b = entry.win.getNormalBounds()
      return { width: b.width, height: b.height }
    } catch {
      return { width: 1280, height: 820 }
    }
  }

  async function dragEnd(source, token, info) {
    const drag = drags.get(token)
    if (!drag || drag.sourceWcId !== source.wcId) return { result: 'none' }
    try {
      // Tests (background, hidden windows) put the drop point here.
      const cursor = (backgroundTestMode && globalThis.__hmTestCursorPoint) || screen.getCursorScreenPoint()
      const strip = cleanStripRect(info?.stripRect)
      const tabCount = Number(info?.tabCount)
      let target = drag.dropWcId ? entries.get(drag.dropWcId) : null
      if (!target) {
        const over = appWindowAt(cursor, source.wcId)
        // The source started the drag, so it is the frontmost window: where it
        // overlaps another one, only a drop reported by that other window
        // (its tab bar) counts.
        const inSource = alive(source.win) && contains(source.win.getBounds(), cursor)
        if (over) {
          await waitForDrop(drag, DROP_WAIT_MS)
          target = drag.dropWcId ? entries.get(drag.dropWcId) : (inSource ? null : over)
        }
      }
      if (target && alive(target.win) && target.wcId !== source.wcId) {
        deliverTabs(target, [drag.payload], drag.dropIndex)
        removeOpenPath(source, cleanPath(drag.payload?.path))
        focusWin(target.win)
        trace('tab-moved', { from: source.wid, to: target.wid, index: drag.dropIndex })
        return { result: 'moved' }
      }
      if (strip && contains(strip, cursor)) return { result: 'none' }
      const topLeft = { x: cursor.x - TEAR_OFFSET.x, y: cursor.y - TEAR_OFFSET.y }
      if (source.role === 'secondary' && tabCount === 1) {
        // Its only tab: the window itself follows the cursor (as browsers do).
        if (alive(source.win) && !source.win.isMaximized() && !source.win.isFullScreen()) {
          const b = boundsAt(topLeft, sizeOf(source))
          source.win.setPosition(b.x, b.y)
        }
        trace('tab-window-moved', { wid: source.wid })
        return { result: 'none' }
      }
      const created = createSecondary({
        tabs: [drag.payload],
        activeIndex: 0,
        bounds: boundsAt(topLeft, sizeOf(source)),
        focus: true
      })
      removeOpenPath(source, cleanPath(drag.payload?.path))
      trace('tab-torn', { from: source.wid, to: created.wid })
      return { result: 'torn' }
    } finally {
      dropDrag(token)
    }
  }

  // ---- IPC -----------------------------------------------------------------------
  ipcMain.handle('tab:dragStart', (event, payload) => {
    const source = entryOf(event)
    if (!source || !isPlainObject(payload)) return null
    const token = randomUUID()
    const drag = { token, sourceWcId: source.wcId, payload, dropIndex: null, dropWcId: null, waiters: new Set(), timer: null }
    drag.timer = setTimeout(() => dropDrag(token), DRAG_TTL_MS)
    drags.set(token, drag)
    // One OS drag at a time: older ones can no longer end.
    while (drags.size > 8) dropDrag(drags.keys().next().value)
    return token
  })

  ipcMain.on('tab:dropIndex', (event, key, index) => {
    const target = entryOf(event)
    if (!target) return
    const drag = findDrag(key)
    if (!drag || drag.sourceWcId === target.wcId) return
    drag.dropWcId = target.wcId
    drag.dropIndex = Number.isInteger(index) && index >= 0 ? index : null
    for (const done of [...drag.waiters]) done()
  })

  ipcMain.handle('tab:dragEnd', (event, token, info) => {
    const source = entryOf(event)
    if (!source) return { result: 'none' }
    return dragEnd(source, token, info)
  })

  ipcMain.handle('tab:toNewWindow', (event, payload) => {
    const source = entryOf(event)
    if (!source || !isPlainObject(payload)) return { ok: false }
    let corner = { x: 100, y: 100 }
    try {
      const b = source.win.getNormalBounds()
      corner = { x: b.x + 32, y: b.y + 32 }
    } catch { /* default corner */ }
    const created = createSecondary({ tabs: [payload], activeIndex: 0, bounds: boundsAt(corner, sizeOf(source)), focus: true })
    removeOpenPath(source, cleanPath(payload.path))
    trace('tab-to-new-window', { from: source.wid, to: created.wid })
    return { ok: true }
  })

  ipcMain.handle('tab:toMain', (event, payload) => {
    const source = entryOf(event)
    const main = mainEntry()
    if (!source || source.role !== 'secondary' || !main || !isPlainObject(payload)) return { ok: false }
    deliverTabs(main, [payload], null)
    removeOpenPath(source, cleanPath(payload.path))
    focusMain()
    trace('tab-to-main', { from: source.wid })
    return { ok: true }
  })

  ipcMain.handle('window:initialTabs', (event) => {
    const entry = entryOf(event)
    if (!entry || entry.role !== 'secondary') return { tabs: [], activeIndex: 0 }
    let result
    if (entry.initial) {
      result = entry.initial
      entry.initial = null
    } else {
      // A reloaded window gets back the tabs it last reported.
      const tabs = (entry.session?.tabs || []).map((tab) => ({ ...tab }))
      const activePath = entry.session?.activePath
      result = { tabs, activeIndex: Math.max(0, tabs.findIndex((tab) => activePath && tab.path === activePath)) }
    }
    markReady(entry)
    return result
  })

  ipcMain.on('window:toMain', (event, action) => {
    const entry = entryOf(event)
    const cmd = TO_MAIN_ACTIONS[action]
    if (!entry || !cmd || !Object.hasOwn(TO_MAIN_ACTIONS, action)) return
    focusMain()
    const main = mainEntry()
    if (main && isReady(main)) send(main, 'menu', cmd)
  })

  ipcMain.on('window:session', (event, state) => {
    const entry = entryOf(event)
    if (!entry || !isPlainObject(state)) return
    if (entry.role === 'main') {
      // The main session itself stays in localStorage (minimd.session.v1);
      // only its open paths are kept, for routing.
      entry.openPaths = cleanPaths(state.openPaths)
      return
    }
    const tabs = cleanTabs(state.tabs)
    entry.session = { tabs, activePath: cleanPath(state.activePath) }
    entry.openPaths = Array.isArray(state.openPaths)
      ? cleanPaths(state.openPaths)
      : cleanPaths(tabs.map((tab) => tab.path))
    schedulePersist()
  })

  // A window about to open files (file tree, Ctrl+O, a link, a drop): a file
  // already open in ANOTHER window is shown there instead (that window is
  // focused, its tab activated) — the same document is never open twice.
  // Returns the paths the asking window should open itself.
  ipcMain.handle('window:claimPaths', (event, paths) => {
    const asker = entryOf(event)
    const list = cleanPaths(paths)
    if (!asker) return list
    const own = []
    const groups = new Map()
    for (const path of list) {
      const key = pathKey(path)
      const holder = [...entries.values()].find((entry) => entry.wcId !== asker.wcId && alive(entry.win) && isReady(entry) &&
        entry.openPaths.some((p) => pathKey(p) === key))
      if (!holder) { own.push(path); continue }
      if (!groups.has(holder)) groups.set(holder, [])
      groups.get(holder).push(path)
    }
    deliverOpenPaths([...groups.entries()])
    return own
  })

  ipcMain.on('app:quit-prepared', (event, info) => onQuitPrepared(entryOf(event), info))

  return {
    registerMain,
    entryOf,
    entryOfWebContents,
    isAppWindowSender: (event) => !!entryOf(event),
    isAppWebContents: (webContents) => !!entryOfWebContents(webContents),
    windowOfSender: (event) => entryOf(event)?.win || null,
    mainWin: () => getMainWindow(),
    allWindows: () => [...entries.values()].filter((e) => alive(e.win)).map((e) => e.win),
    hasSecondaries: () => secondaries().length > 0,
    isPreparingQuit: () => !!prepare,
    focusEntry: (entry) => focusWin(entry?.win),
    anyFocused,
    hideSecondaries,
    showHiddenSecondaries,
    planOpenPaths,
    deliverOpenPaths,
    sendMenu,
    markReady: (event) => markReady(entryOf(event)),
    onMainReady,
    restoreSaved,
    load,
    persistNow,
    prepareQuit,
    allowAllToClose,
    confirmSecondaryClose,
    cancelSecondaryClose,
    createSecondary
  }
}
