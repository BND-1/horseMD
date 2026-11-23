// The main window's position and size come back on the next launch
// (userData/window-state.json; Windows report 2026-11-22: every start was
// 1280×820 in the middle of the screen, on every OS). Secondary windows keep
// theirs in windows.json (windows.js); both use window-state-core.js.
//
// Saved: on every move / resize / maximize change (debounced) and at once,
// synchronously, when the window closes (a quit exits before queued work).
// Restored: the window is created at the saved normal bounds (fitted to the
// displays there are now) and maximized before it is first shown.
import { screen } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fitToWorkAreas, nextWindowState, parseWindowState, serializeWindowState, withRequestedBounds } from './window-state-core.js'

const STATE_FILE = 'window-state.json'
const SAVE_DEBOUNCE_MS = 500

export function displayWorkAreas() {
  try {
    return { workAreas: screen.getAllDisplays().map((d) => d.workArea), primary: screen.getPrimaryDisplay().workArea }
  } catch {
    return { workAreas: [], primary: null }
  }
}

export function fitToDisplays(bounds) {
  if (!bounds) return null
  const { workAreas, primary } = displayWorkAreas()
  return fitToWorkAreas(bounds, workAreas, primary) || bounds
}

const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

// What the window reports now; with `applied` (see restoredBounds) the
// bounds it was restored to, while it is still exactly there.
export function windowInfo(win, applied = null) {
  return withRequestedBounds({
    normalBounds: win.getNormalBounds(),
    maximized: win.isMaximized(),
    minimized: win.isMinimized(),
    fullScreen: win.isFullScreen()
  }, applied)
}

// After creating a window at restored bounds: set them again when the
// window differs (Windows with monitors of different scaling: a window
// created on the other monitor can get its size scaled once more; setting
// the bounds on the right monitor gives the size asked for), and return the
// { requested, actual } pair windowInfo uses (fractional scaling rounds).
export function restoredBounds(win, wanted) {
  if (!wanted) return null
  try {
    if (!sameRect(win.getBounds(), wanted)) win.setBounds(wanted)
    return { requested: { ...wanted }, actual: win.getNormalBounds() }
  } catch {
    return null
  }
}

export function createMainWindowState({ getUserDataPath, trace = () => {}, backgroundTestMode = false }) {
  let state = null
  let loaded = false
  let lastWritten = null
  let timer = null
  const filePath = () => join(getUserDataPath(), STATE_FILE)

  function load() {
    if (loaded) return state
    loaded = true
    try {
      const text = readFileSync(filePath(), 'utf8')
      state = parseWindowState(text)
      lastWritten = state ? serializeWindowState(state) : null
    } catch {
      state = null
    }
    return state
  }

  // Synchronous and atomic (temp file + rename).
  function writeNow(reason) {
    clearTimeout(timer)
    timer = null
    const data = serializeWindowState(state)
    if (!data || data === lastWritten) return
    const target = filePath()
    const temp = `${target}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(temp, data, 'utf8')
      renameSync(temp, target)
      lastWritten = data
      trace('window-state-saved', { reason, ...state })
    } catch (error) {
      console.error('window-state.json write failed (ignored):', error?.message || error)
    }
  }

  // BrowserWindow options for a new main window: the saved bounds, fitted to
  // the displays connected now; none (the defaults, centred) on a first run.
  function initialOptions() {
    const saved = load()
    if (!saved) return {}
    const bounds = fitToDisplays(saved.bounds)
    return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : {}
  }

  // Call right after `new BrowserWindow(initialOptions())`, before any other
  // ready-to-show listener (the maximize has to come before the first show).
  function attach(win) {
    const saved = load()
    const wanted = saved ? fitToDisplays(saved.bounds) : null
    const applied = restoredBounds(win, wanted)
    const info = () => windowInfo(win, applied)
    try { state = nextWindowState(saved, info()) } catch { state = saved }
    if (saved) state = { ...state, maximized: saved.maximized }
    trace('window-state-restored', {
      saved: saved || null, bounds: wanted, maximized: saved?.maximized === true,
      actual: applied?.actual || (() => { try { return win.getBounds() } catch { return null } })()
    })

    win.once('ready-to-show', () => {
      if (!saved?.maximized || win.isDestroyed()) return
      // maximize() shows the window: test runs stay in the background.
      if (backgroundTestMode) trace('window-state-maximize-skipped', { reason: 'background-test' })
      else win.maximize()
    })

    const track = () => {
      if (win.isDestroyed()) return
      try { state = nextWindowState(state, info()) } catch { return }
      clearTimeout(timer)
      timer = setTimeout(() => writeNow('change'), SAVE_DEBOUNCE_MS)
    }
    for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'restore']) win.on(event, track)
    win.on('close', () => {
      if (win.isDestroyed()) return
      try { state = nextWindowState(state, info()) } catch { /* keep the last one */ }
      writeNow('close')
    })
  }

  return { initialOptions, attach, flush: () => writeNow('flush') }
}
