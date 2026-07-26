import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

if (process.platform !== 'darwin') {
  console.log('SKIP clipboard IPC UI: native clipboard verification runs on macOS')
  process.exit(0)
}

const root = `/tmp/horsemd-clipboard-ipc-${process.pid}`
const fixture = join(root, 'clipboard.md')
const token = `HorseMD clipboard IPC ${Date.now()}`
const previousClipboard = execFileSync('pbpaste', { encoding: 'utf8' })
let app = null

try {
  await mkdir(root, { recursive: true })
  await writeFile(fixture, '# Clipboard\n', 'utf8')
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port: 9800 + (process.pid % 100),
    appArgs: [fixture]
  })
  const copied = await app.evaluate(`window.api.copyText(${JSON.stringify(token)})`)
  assert.equal(copied, true, 'clipboard IPC did not report success')
  assert.equal(execFileSync('pbpaste', { encoding: 'utf8' }), token, 'native clipboard did not receive copied text')
  console.log('PASS clipboard IPC UI: Electron native clipboard receives renderer copy requests')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  spawnSync('pbcopy', { input: previousClipboard })
  await rm(root, { recursive: true, force: true })
}
