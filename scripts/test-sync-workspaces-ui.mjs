import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-sync-ui-'))
const profileDir = join(root, 'profile')
const notes = join(root, 'notes')
const markerPath = join(notes, '.horsemd', 'workspace.json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function openSyncSettings(app) {
  await app.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const visible = (element) => {
      if (!element) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    }
    const buttons = [...document.querySelectorAll('button')].filter(visible)
    const settings = buttons.find((button) => /settings|设置/i.test(button.title || button.textContent || ''))
    if (!settings) throw new Error('Missing Settings entry')
    settings.click()
    await sleep(350)
    const sync = [...document.querySelectorAll('.settings-nav-item')].filter(visible)
      .find((button) => /cloud sync|云同步/i.test(button.textContent || ''))
    if (!sync) throw new Error('Missing Cloud sync navigation item')
    sync.click()
    await sleep(350)
  })()`)
}

try {
  await mkdir(notes, { recursive: true })
  await writeFile(join(notes, 'welcome.md'), '# Sync test\n', 'utf8')

  let app = await launchBuiltElectron({
    profileDir,
    port: 9468,
    appArgs: [notes]
  })
  try {
    await openSyncSettings(app)
    const initial = await app.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.sync-folder-row')]
      return rows.map((row) => ({ text: row.textContent.replace(/\\s+/g, ' ').trim(), action: row.querySelector('button')?.textContent.trim() }))
    })()`)
    assert.equal(initial.length, 1)
    assert.match(initial[0].text, /local only|仅本地/i)
    assert.match(initial[0].action, /enable sync|开启同步/i)

    const connectionForms = await app.evaluate(`(async () => {
      const options = [...document.querySelectorAll('.sync-connection-option')]
      if (options.length !== 2) throw new Error('Expected separate WebDAV and S3 connection options')
      const webdav = options.find((item) => /WebDAV/i.test(item.textContent || ''))
      const s3 = options.find((item) => /S3/i.test(item.textContent || ''))
      if (!webdav || !s3) throw new Error('Missing WebDAV or S3 connection option')
      webdav.click()
      await new Promise(requestAnimationFrame)
      const webdavForm = document.querySelector('.sync-form')
      if (!webdavForm) throw new Error('Missing WebDAV connection form')
      const webdavPlaceholders = [...webdavForm.querySelectorAll('input')].map((input) => input.placeholder)
      s3.click()
      await new Promise(requestAnimationFrame)
      const forms = [...document.querySelectorAll('.sync-form')]
      const s3Form = forms.find((form) => form.querySelector('#sync-s3-bucket'))
      const s3Placeholders = [...(s3Form?.querySelectorAll('input') || [])].map((input) => input.placeholder)
      return { webdavPlaceholders, s3Placeholders }
    })()`)
    assert.equal(connectionForms.webdavPlaceholders.some((field) => /https:\/\/cloud\.example\.com/i.test(field)), true)
    assert.equal(connectionForms.s3Placeholders.some((field) => /horsemd-sync/i.test(field)), true)

    await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('.sync-folder-row button')]
        .find((item) => /enable sync|开启同步/i.test(item.textContent || ''))
      if (!button) throw new Error('Missing Enable sync action')
      button.click()
    })()`)
    await sleep(500)
    const enabled = await app.evaluate(`(() => {
      const row = document.querySelector('.sync-folder-row')
      return row?.textContent?.replace(/\\s+/g, ' ').trim() || ''
    })()`)
    assert.match(enabled, /ready to connect|已准备好连接云端/i)
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    assert.match(marker.workspaceId, /^[0-9a-f-]{36}$/i)
  } finally {
    await stopBuiltElectron(app)
  }

  app = await launchBuiltElectron({
    profileDir,
    port: 9468,
    cleanProfile: false,
    appArgs: [notes]
  })
  try {
    await openSyncSettings(app)
    const restored = await app.evaluate(`(() => document.querySelector('.sync-folder-row')?.textContent?.replace(/\\s+/g, ' ').trim() || '')()`)
    assert.match(restored, /ready to connect|已准备好连接云端/i)
  } finally {
    await stopBuiltElectron(app)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('PASS sync workspaces UI: local-only folder, opt-in registration and restart persistence')
