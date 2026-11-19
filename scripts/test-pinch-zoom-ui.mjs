// A trackpad pinch magnifies the page (#180, Typora parity): Electron's
// visual zoom is allowed (1–4×) in app windows. Checked with Chromium's own
// pinch gesture; pinching back returns to 1×.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = join(tmpdir(), `horsemd-pinch-${process.pid}`)
// The gesture completes on animation frames; a Windows test window in the
// background gets almost none, and the call never returned there.
const pinch = (app, params) => Promise.race([
  app.send('Input.synthesizePinchGesture', params),
  new Promise((_, reject) => setTimeout(() => reject(new Error('pinch gesture did not complete in 15 s (no animation frames in this window?)')), 15000))
])
const file = join(root, 'pinch.md')
await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
await writeFile(file, '# Pinch\n\n' + 'Some text to look at. '.repeat(40) + '\n')
const app = await launchBuiltElectron({ profileDir: join(root, 'p'), port: Number(process.env.CDP_PORT || 9889), appArgs: [file] })
try {
  for (let i = 0; i < 150 && !(await app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`)); i++) await sleep(80)
  await sleep(500)
  const center = await app.evaluate(`({ x: Math.round(innerWidth / 3), y: Math.round(innerHeight / 3) })`)
  await pinch(app, { ...center, scaleFactor: 2, relativeSpeed: 800, gestureSourceType: 'mouse' })
  let scale = 1
  for (let i = 0; i < 40 && scale <= 1.05; i++) { await sleep(50); scale = await app.evaluate('visualViewport.scale') }
  assert.ok(scale > 1.5, `pinch did not magnify the page: scale ${scale}`)
  assert.equal(await app.evaluate(`!!document.querySelector('.tab-close.dirty')`), false, 'pinch made the document dirty')
  await pinch(app, { ...center, scaleFactor: 0.4, relativeSpeed: 800, gestureSourceType: 'mouse' })
  for (let i = 0; i < 40 && scale > 1.01; i++) { await sleep(50); scale = await app.evaluate('visualViewport.scale') }
  assert.ok(scale <= 1.01, `pinching back did not return to 1×: ${scale}`)
  console.log('PASS pinch zoom: a trackpad pinch magnifies the page and pinching back returns to 1×')
} finally {
  await stopBuiltElectron(app)
  await rm(root, { recursive: true, force: true })
}
