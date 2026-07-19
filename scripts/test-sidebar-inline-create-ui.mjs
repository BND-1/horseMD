import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 9663)

async function waitFor(evaluate, expression, label, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    if (await evaluate(expression)) return
    await sleep(125)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function clickToolbarButton(app, pattern) {
  const clicked = await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.sidebar-head-actions button')]
      .find((node) => ${pattern}.test(node.title || ''))
    button?.click()
    return !!button
  })()`)
  if (!clicked) throw new Error(`Missing sidebar toolbar button: ${pattern}`)
}

async function assertSingleInput(app, expectedValue) {
  await waitFor(
    app.evaluate,
    `(() => [...document.querySelectorAll('.creating-row input')].filter((node) => node.offsetParent).length === 1)()`,
    'one visible inline creation field'
  )
  const state = await app.evaluate(`(() => {
    const inputs = [...document.querySelectorAll('.creating-row input')].filter((node) => node.offsetParent)
    return { count: inputs.length, value: inputs[0]?.value || '', focused: document.activeElement === inputs[0] }
  })()`)
  if (state.count !== 1 ||
    (typeof expectedValue === 'string' ? state.value !== expectedValue : !state.value) ||
    !state.focused) {
    throw new Error(`Inline creation field is not ready: ${JSON.stringify(state)}`)
  }
}

async function replaceAndConfirm(app, value) {
  await app.evaluate(`(() => {
    const input = [...document.querySelectorAll('.creating-row input')].find((node) => node.offsetParent)
    if (!input) return false
    input.focus()
    input.select()
    return true
  })()`)
  await app.send('Input.insertText', { text: value })
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), 'horsemd-sidebar-create-'))
  const app = await launchBuiltElectron({
    profileDir: '/tmp/horsemd-sidebar-inline-create-ui',
    port,
    appArgs: [workspace]
  })

  try {
    await waitFor(app.evaluate, `document.querySelectorAll('.sidebar-head-actions button').length >= 3`, 'workspace toolbar')

    await clickToolbarButton(app, '/new file|新建文件/i')
    await assertSingleInput(app, 'untitled.md')
    const beforeFileCommit = await readdir(workspace)
    if (beforeFileCommit.length) throw new Error(`New file was created before confirmation: ${JSON.stringify(beforeFileCommit)}`)
    await replaceAndConfirm(app, 'renamed-file')
    await waitFor(app.evaluate, `!document.querySelector('.creating-row input')`, 'file creation commit')
    const afterFileCommit = await readdir(workspace)
    if (!afterFileCommit.includes('renamed-file.md')) {
      throw new Error(`Confirmed file was not created with its edited name: ${JSON.stringify(afterFileCommit)}`)
    }

    await clickToolbarButton(app, '/new folder|新建文件夹/i')
    await assertSingleInput(app)
    const beforeFolderCommit = await readdir(workspace)
    if (beforeFolderCommit.length !== 1) throw new Error(`New folder was created before confirmation: ${JSON.stringify(beforeFolderCommit)}`)
    await replaceAndConfirm(app, 'renamed-folder')
    await waitFor(app.evaluate, `!document.querySelector('.creating-row input')`, 'folder creation commit')
    const afterFolderCommit = await readdir(workspace)
    if (!afterFolderCommit.includes('renamed-folder')) {
      throw new Error(`Confirmed folder was not created with its edited name: ${JSON.stringify(afterFolderCommit)}`)
    }

    const rootCollapsed = await app.evaluate(`(() => {
      const root = [...document.querySelectorAll('.tree-row')]
        .find((node) => node.title === ${JSON.stringify(workspace)})
      root?.click()
      return !!root
    })()`)
    if (!rootCollapsed) throw new Error('Could not collapse the workspace root')
    await waitFor(
      app.evaluate,
      `(() => {
        const root = [...document.querySelectorAll('.tree-row')]
          .find((node) => node.title === ${JSON.stringify(workspace)})
        return !root?.querySelector('.tree-chevron')?.classList.contains('chevron-expanded')
      })()`,
      'collapsed workspace root'
    )
    await clickToolbarButton(app, '/new file|新建文件/i')
    await assertSingleInput(app, 'untitled.md')
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(app.evaluate, `!document.querySelector('.creating-row input')`, 'inline creation cancellation')
    const afterCancellation = await readdir(workspace)
    if (afterCancellation.includes('untitled.md')) {
      throw new Error(`Collapsed-root creation wrote a file before confirmation: ${JSON.stringify(afterCancellation)}`)
    }

    console.log('sidebar inline create UI ok:', { workspace, afterCancellation })
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(workspace, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
