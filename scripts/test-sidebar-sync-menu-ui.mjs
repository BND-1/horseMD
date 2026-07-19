import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-sidebar-sync-menu-'))
const workspace = join(root, 'notes')
const notePath = join(workspace, 'welcome.md')
const markerPath = join(workspace, '.horsemd', 'workspace.json')
const executable = process.env.HORSEMD_TEST_EXECUTABLE || undefined

async function waitFor(evaluate, expression, label, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    if (await evaluate(expression)) return
    await sleep(125)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function openContextMenu(app, path) {
  await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.tree-row')]
      .find((node) => node.title === ${JSON.stringify(path)})
    if (!row) return false
    const rect = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 24,
      clientY: rect.top + 12
    }))
    return true
  })()`)
  await waitFor(app.evaluate, `!!document.querySelector('.context-menu')`, 'sidebar context menu')
}

try {
  await mkdir(workspace, { recursive: true })
  await writeFile(notePath, '# Sidebar sync menu\n', 'utf8')
  const app = await launchBuiltElectron({
    executable,
    entrypoint: executable ? null : undefined,
    profileDir: join(root, 'profile'),
    port: 9664,
    appArgs: [workspace]
  })

  try {
    await waitFor(
      app.evaluate,
      `(() => [...document.querySelectorAll('button')]
        .some((node) => /show files|显示文件浏览器/i.test(node.title || '')))()`,
      'file-browser activity button'
    )
    await app.evaluate(`(() => {
      [...document.querySelectorAll('button')]
        .find((node) => /show files|显示文件浏览器/i.test(node.title || ''))?.click()
      return true
    })()`)
    await waitFor(app.evaluate, `!![...document.querySelectorAll('.tree-row')].find((node) => node.title === ${JSON.stringify(workspace)})`, 'workspace tree root')

    await openContextMenu(app, workspace)
    const rootAction = await app.evaluate(`(() => [...document.querySelectorAll('.context-menu button')]
      .some((node) => /add to sync|添加到同步区/i.test(node.textContent || '')))()`)
    assert.equal(rootAction, true, 'root folder should expose the sync action')
    await app.evaluate(`document.body.click()`)

    await openContextMenu(app, notePath)
    const fileAction = await app.evaluate(`(() => {
      const action = [...document.querySelectorAll('.context-menu button')]
        .find((node) => /add to sync|添加到同步区/i.test(node.textContent || ''))
      action?.click()
      return !!action
    })()`)
    assert.equal(fileAction, true, 'file menu should offer syncing its workspace folder')
    for (let index = 0; index < 40; index += 1) {
      try {
        const marker = JSON.parse(await readFile(markerPath, 'utf8'))
        if (marker.workspaceId) break
      } catch {}
      await sleep(125)
      if (index === 39) throw new Error('Sync marker was not created from the sidebar action')
    }

    await openContextMenu(app, workspace)
    const registeredState = await app.evaluate(`(() => {
      const action = [...document.querySelectorAll('.context-menu button')]
        .find((node) => /already added to sync|已添加到同步区/i.test(node.textContent || ''))
      return { found: !!action, disabled: !!action?.disabled }
    })()`)
    assert.deepEqual(registeredState, { found: true, disabled: true }, 'registered folder should show a non-actionable sync status')
  } finally {
    await stopBuiltElectron(app)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('PASS sidebar sync menu UI: root/file entry, registration, visible registered state')
