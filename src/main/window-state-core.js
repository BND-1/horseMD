// Window position / size memory — the pure part (no Electron), shared by the
// main window (window-state.js) and the secondary windows (windows.js).
//
// What is remembered follows VS Code / electron-window-state: the window's
// NORMAL bounds (its restored size even while maximized), whether it was
// maximized. Minimized and full-screen states are not states to come back
// in: while a window is minimized or full screen the last normal state is
// kept, and full screen is not restored (VS Code's default,
// window.restoreFullscreen false).

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

export function cleanBounds(bounds) {
  if (!isPlainObject(bounds)) return null
  const { x, y, width, height } = bounds
  if (![x, y, width, height].every(finite)) return null
  if (width < 200 || height < 150 || width > 20000 || height > 20000) return null
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

function cleanArea(area) {
  if (!isPlainObject(area)) return null
  const { x, y, width, height } = area
  if (![x, y, width, height].every(finite) || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

// The part of `bounds`' top edge (the title bar) that lies on `area`.
function titleBarOverlap(bounds, area) {
  const w = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
  const titleOnArea = bounds.y >= area.y - 10 && bounds.y <= area.y + area.height - 40
  return titleOnArea ? Math.max(0, w) : 0
}

// A saved window must come back where the user can see and drag it.
//   - its title bar lies on some display (≥ 100 px of it): kept as it was;
//     only a window larger than that display's work area (a resolution or
//     scaling change since) is shrunk and moved into it;
//   - otherwise (the monitor it was on is gone): centred on the primary
//     display, shrunk to fit.
// `workAreas`: every display's work area; `primary`: the primary display's.
export function fitToWorkAreas(bounds, workAreas = [], primary = null) {
  const b = cleanBounds(bounds)
  if (!b) return null
  const areas = (Array.isArray(workAreas) ? workAreas : []).map(cleanArea).filter(Boolean)
  const home = cleanArea(primary) || areas[0] || null
  if (!home) return b
  let best = null
  let bestOverlap = 0
  for (const area of areas) {
    const overlap = titleBarOverlap(b, area)
    if (overlap > bestOverlap) { best = area; bestOverlap = overlap }
  }
  if (best && bestOverlap >= 100) {
    // Fits: exactly where the user left it (partly past a screen edge too).
    if (b.width <= best.width && b.height <= best.height) return b
    const width = Math.min(b.width, best.width)
    const height = Math.min(b.height, best.height)
    const x = Math.min(Math.max(b.x, best.x), best.x + best.width - width)
    const y = Math.min(Math.max(b.y, best.y), best.y + best.height - height)
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
  }
  const width = Math.min(b.width, home.width)
  const height = Math.min(b.height, home.height)
  return {
    x: Math.round(home.x + (home.width - width) / 2),
    y: Math.round(home.y + (home.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height)
  }
}

// The state file of the main window (userData/window-state.json).
export const WINDOW_STATE_VERSION = 1

export function parseWindowState(text) {
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) return null
    const bounds = cleanBounds(parsed.bounds)
    if (!bounds) return null
    return { bounds, maximized: parsed.maximized === true }
  } catch {
    return null
  }
}

export function serializeWindowState(state) {
  const bounds = cleanBounds(state?.bounds)
  if (!bounds) return null
  return JSON.stringify({ version: WINDOW_STATE_VERSION, bounds, maximized: state.maximized === true })
}

// The state to remember from what a window reports now, or `previous` when
// this moment is not one to come back to (minimized, full screen, or the
// window reports nothing usable). `info`: { normalBounds, maximized,
// minimized, fullScreen }.
export function nextWindowState(previous, info) {
  if (!info || info.minimized || info.fullScreen) return previous || null
  const bounds = cleanBounds(info.normalBounds)
  if (!bounds) return previous || null
  return { bounds, maximized: info.maximized === true }
}

// Windows at a fractional display scale (125 %, 150 %) rounds a window's
// bounds outwards on every DIP ↔ pixel conversion: created at 1000×640 it
// reports 1002–1004 × 642–644 (measured, Windows 10 at 125 %), and saving
// that grew the window by a few pixels per launch. `applied` pairs what we
// asked for with what the window reported right after; while the window
// still reports exactly that (the user has not moved or resized it), the
// asked-for bounds are what is remembered.
export function withRequestedBounds(info, applied) {
  if (!info || !applied?.requested || !applied?.actual) return info
  const n = info.normalBounds
  const a = applied.actual
  if (n && n.x === a.x && n.y === a.y && n.width === a.width && n.height === a.height) {
    return { ...info, normalBounds: { ...applied.requested } }
  }
  return info
}
