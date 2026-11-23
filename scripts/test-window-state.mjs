// Pure rules of the window position / size memory (src/main/window-state-core.js).
import assert from 'node:assert/strict'
import { cleanBounds, fitToWorkAreas, nextWindowState, parseWindowState, serializeWindowState, withRequestedBounds } from '../src/main/window-state-core.js'

const left = { x: 0, y: 25, width: 1920, height: 1055 }
const right = { x: 1920, y: 0, width: 2560, height: 1400 }

// cleanBounds
assert.deepEqual(cleanBounds({ x: 1.4, y: 2.6, width: 800.2, height: 600 }), { x: 1, y: 3, width: 800, height: 600 })
for (const bad of [null, {}, { x: 0, y: 0, width: 100, height: 600 }, { x: NaN, y: 0, width: 800, height: 600 }, { x: 0, y: 0, width: 800, height: 30000 }]) {
  assert.equal(cleanBounds(bad), null, JSON.stringify(bad))
}

// fitToWorkAreas: kept where it was when its title bar is on a display.
const onRight = { x: 2100, y: 200, width: 1200, height: 800 }
assert.deepEqual(fitToWorkAreas(onRight, [left, right], left), onRight)
// Partly past the right edge of the last display: still kept (user placed it).
const pastEdge = { x: 4000, y: 100, width: 900, height: 700 }
assert.deepEqual(fitToWorkAreas(pastEdge, [left, right], left), pastEdge)
// Monitor gone → centred on the primary, shrunk to fit.
assert.deepEqual(fitToWorkAreas(onRight, [left], left), { x: 360, y: 153, width: 1200, height: 800 })
assert.deepEqual(fitToWorkAreas({ x: 3000, y: 0, width: 2400, height: 1300 }, [left], left), { x: 0, y: 25, width: 1920, height: 1055 })
// Title bar above the display (unreachable) → centred.
assert.deepEqual(fitToWorkAreas({ x: 100, y: -500, width: 800, height: 600 }, [left], left), { x: 560, y: 253, width: 800, height: 600 })
// Larger than its display (resolution change) → shrunk and moved into it.
assert.deepEqual(fitToWorkAreas({ x: 50, y: 40, width: 2400, height: 1300 }, [left, right], left), { x: 0, y: 25, width: 1920, height: 1055 })
// No display info: as saved.
assert.deepEqual(fitToWorkAreas(onRight, [], null), onRight)
assert.equal(fitToWorkAreas(null, [left], left), null)

// parse / serialize
const state = { bounds: { x: 10, y: 20, width: 900, height: 700 }, maximized: true }
assert.deepEqual(parseWindowState(serializeWindowState(state)), state)
assert.equal(parseWindowState('not json'), null)
assert.equal(parseWindowState('{"bounds":{"x":0}}'), null)
assert.equal(serializeWindowState({ bounds: null }), null)

// nextWindowState: minimized / full screen keep the last normal state.
const normal = { normalBounds: { x: 5, y: 6, width: 800, height: 600 }, maximized: false, minimized: false, fullScreen: false }
assert.deepEqual(nextWindowState(null, normal), { bounds: { x: 5, y: 6, width: 800, height: 600 }, maximized: false })
assert.deepEqual(nextWindowState(state, { ...normal, minimized: true }), state)
assert.deepEqual(nextWindowState(state, { ...normal, fullScreen: true }), state)
assert.deepEqual(nextWindowState(null, { ...normal, maximized: true }), { bounds: normal.normalBounds, maximized: true })
assert.deepEqual(nextWindowState(state, { ...normal, normalBounds: { x: 0, y: 0, width: 1, height: 1 } }), state)

// withRequestedBounds: Windows at 125 % rounds outwards (measured: asked
// 1000×640, got 1002×642). Untouched since the restore → what was asked.
const applied = { requested: { x: 37, y: 41, width: 1000, height: 640 }, actual: { x: 36, y: 40, width: 1002, height: 642 } }
const reported = { ...normal, normalBounds: { x: 36, y: 40, width: 1002, height: 642 } }
assert.deepEqual(withRequestedBounds(reported, applied).normalBounds, applied.requested)
const moved = { ...normal, normalBounds: { x: 80, y: 40, width: 1002, height: 642 } }
assert.deepEqual(withRequestedBounds(moved, applied), moved)
assert.deepEqual(withRequestedBounds(reported, null), reported)
assert.equal(withRequestedBounds(null, applied), null)

console.log('PASS window state core')
