import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const dir = '/tmp/horsemd-external-change-warning'
const file = join(dir, 'watched.md')
const port = Number(process.env.CDP_PORT || 9485)
const original = '# Watcher\n\n本地初始内容'
const externalClean = '# Watcher\n\n外部编辑器保存的内容'
const externalConflict = '# Watcher\n\n第二次外部编辑器保存的内容'

async function waitFor(check, message, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

async function main() {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, original, 'utf8')

  const app = await launchBuiltElectron({
    profileDir: join(dir, 'profile'),
    port,
    appArgs: [file],
    executable: process.env.HORSEMD_APP_PATH || undefined,
    entrypoint: process.env.HORSEMD_APP_PATH ? null : undefined
  })
  const { evaluate, send } = app

  try {
    await waitFor(
      () => evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent)`),
      'Rich editor did not become visible'
    )
    await evaluate(`(() => {
      window.__externalChangeAlerts = []
      window.alert = (message) => window.__externalChangeAlerts.push(message)
      return true
    })()`)
    await writeFile(file, externalClean, 'utf8')
    await waitFor(
      () => evaluate(`(() =>
        [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent.includes('外部编辑器保存的内容')
      )()`),
      'Clean tab did not auto-reload after an external save',
      70
    )
    assert.equal(await evaluate('window.__externalChangeAlerts.length'), 0, 'Clean tab should not show a conflict warning')

    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      editor?.focus()
      return Boolean(editor)
    })()`)
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 119
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 119
    })
    await send('Input.insertText', { text: '（HorseMD 未保存）' })
    await waitFor(
      () => evaluate('Boolean(document.querySelector(".hm-save-fab"))'),
      'Local rich-text edit did not become dirty'
    )

    await writeFile(file, externalConflict, 'utf8')
    const alert = await waitFor(
      () => evaluate('window.__externalChangeAlerts[0] || null'),
      'External file save did not show a conflict warning',
      70
    )
    assert.match(alert, /其他应用|another application/i, 'Warning did not identify an external save')
    assert.match(alert, /未保存|unsaved/i, 'Warning did not confirm local edits were retained')
    await sleep(1500)
    assert.equal(
      await evaluate('window.__externalChangeAlerts.length'),
      1,
      'One external save showed duplicate warnings'
    )

    const richText = await evaluate(`(() =>
      [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent || ''
    )()`)
    assert.match(richText, /HorseMD 未保存/, 'External save overwrote local unsaved rich-text content')
    assert.doesNotMatch(richText, /第二次外部编辑器保存的内容/, 'External disk content leaked into the dirty editor')

    console.log('PASS external-change warning UI: clean tabs auto-reload; dirty tabs warn once and retain local content after an external save')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
