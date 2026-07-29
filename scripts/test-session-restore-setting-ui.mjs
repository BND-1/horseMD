import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-session-restore-setting-${process.pid}`
const profile = join(root, 'profile')
const restoredFile = join(root, 'should-not-restore.md')
const explicitFile = join(root, 'explicit-open.md')
const port = 9820 + (process.pid % 70)
let app = null

const waitFor = async (check, message, attempts = 50) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

try {
  await mkdir(root, { recursive: true })
  await writeFile(restoredFile, '# SHOULD_NOT_RESTORE_98\n', 'utf8')
  await writeFile(explicitFile, '# EXPLICIT_OPEN_98\n', 'utf8')

  app = await launchBuiltElectron({ profileDir: profile, port, appArgs: [restoredFile] })
  const disabled = await app.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const visible = (node) => Boolean(node?.offsetParent)
    const text = (node) => node?.textContent?.replace(/\\s+/g, ' ').trim() || ''
    const settingsButton = [...document.querySelectorAll('button')]
      .find((node) => visible(node) && /settings|设置/i.test(node.title || text(node)))
    settingsButton?.click()
    await sleep(250)
    const general = [...document.querySelectorAll('button')]
      .find((node) => visible(node) && /^(general|通用)$/i.test(text(node)))
    general?.click()
    await sleep(180)
    const toggle = [...document.querySelectorAll('button[role="switch"]')]
      .find((node) => visible(node) && /restore previous documents|恢复上次打开的文档/i.test(node.getAttribute('aria-label') || ''))
    toggle?.click()
    await sleep(350)
    return {
      found: Boolean(settingsButton && general && toggle),
      value: JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}').restoreSession
    }
  })()`)
  assert.deepEqual(disabled, { found: true, value: false })
  await stopBuiltElectron(app, { removeProfile: false })
  app = null

  app = await launchBuiltElectron({
    profileDir: profile,
    port,
    cleanProfile: false
  })
  await sleep(700)
  const skipped = await app.evaluate(`(() => ({
    restored: document.body.textContent.includes('SHOULD_NOT_RESTORE_98'),
    setting: JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}').restoreSession
  }))()`)
  assert.deepEqual(skipped, { restored: false, setting: false })
  await stopBuiltElectron(app, { removeProfile: false })
  app = null

  app = await launchBuiltElectron({
    profileDir: profile,
    port,
    cleanProfile: false,
    appArgs: [explicitFile]
  })
  await waitFor(
    () => app.evaluate(`document.body.textContent.includes('EXPLICIT_OPEN_98')`),
    'explicit startup file was blocked when session restore was disabled'
  )

  console.log('PASS session restore setting UI: opt-out skips history while explicit startup files still open')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: false })
  await rm(root, { recursive: true, force: true })
}
