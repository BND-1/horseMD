import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import electronPath from 'electron'
import { connectCdp, sleep } from './lib/cdp.mjs'

if (process.platform !== 'darwin') {
  console.log('SKIP macOS window reopen: macOS only')
  process.exit(0)
}

const port = Number(process.env.CDP_PORT || 9706)
const profileDir = `/tmp/horsemd-macos-window-reopen-${process.pid}`
const fixture = join(process.cwd(), 'scripts', 'fixtures', 'list-conversion.md')
const executable = process.env.HORSEMD_EXECUTABLE || electronPath

async function waitFor(check, message, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return true
    await sleep(150)
  }
  throw new Error(message)
}

function launch(args = []) {
  return spawn(executable, [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    'out/main/index.cjs',
    ...args
  ], { cwd: process.cwd(), stdio: 'ignore' })
}

async function stop(child) {
  if (!child || child.exitCode != null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(2500).then(() => child.kill('SIGKILL'))
  ])
}

let primary = null
let second = null

try {
  await rm(profileDir, { recursive: true, force: true })
  primary = launch()

  let cdp = await connectCdp({ port, attempts: 80, intervalMs: 150 })
  await waitFor(
    () => cdp.evaluate(`document.querySelector('.app')?.offsetParent !== null`),
    'initial window did not render'
  )

  await waitFor(
    () => cdp.evaluate('typeof window.api?.windowClose === \'function\''),
    'desktop preload bridge did not load'
  )
  // A fresh scratch tab can be dirty, so this is the renderer's equivalent of
  // accepting the normal close-confirmation prompt.
  try {
    await cdp.evaluate('window.api.confirmAppClose()')
  } catch (error) {
    if (!/CDP connection closed/.test(String(error))) throw error
  }
  cdp.ws.close()
  await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return !targets.some((target) => target.type === 'page')
  }, 'macOS app did not close its final window')
  assert.equal(primary.exitCode, null, 'macOS process must stay alive after its final window closes')

  // A second invocation must be routed into the windowless primary process.
  // The primary creates a replacement window and opens the passed file after
  // the new renderer has completed its app-ready handshake.
  second = launch([fixture])
  cdp = await connectCdp({ port, attempts: 80, intervalMs: 150 })
  await waitFor(
    () => cdp.evaluate(`document.body?.innerText.includes('List conversion') === true`),
    'second launch did not recreate a window and open its Markdown file'
  )
  console.log('PASS macOS window reopen: second launch recreates a window and opens the file')
} finally {
  try { await stop(second) } catch {}
  try { await stop(primary) } catch {}
  await rm(profileDir, { recursive: true, force: true })
}
