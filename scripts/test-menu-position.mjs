import assert from 'node:assert/strict'
import { clampFloatingRect } from '../src/renderer/src/lib/menuPosition.js'

assert.deepEqual(clampFloatingRect({
  x: 100,
  y: 80,
  width: 180,
  height: 260,
  viewportWidth: 900,
  viewportHeight: 700
}), { left: 100, top: 80 })

assert.deepEqual(clampFloatingRect({
  x: 850,
  y: 680,
  width: 180,
  height: 420,
  viewportWidth: 900,
  viewportHeight: 700
}), { left: 712, top: 272 })

assert.deepEqual(clampFloatingRect({
  x: -20,
  y: -40,
  width: 500,
  height: 900,
  viewportWidth: 320,
  viewportHeight: 480
}), { left: 8, top: 8 })

console.log('PASS floating menus: measured rectangles stay inside the viewport')
