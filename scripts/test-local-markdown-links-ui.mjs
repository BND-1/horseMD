import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

// An actual rich-editor event test. The file target deliberately does not
// exist: we only need to prove Cmd/Ctrl-click resolves the bare absolute
// Markdown href into the local-file IPC route and prevents browser navigation.
const dir = '/tmp/horsemd-local-markdown-links-ui'
const file = join(dir, 'source.md')
const missingTarget = join(dir, 'does-not-exist.md')
const port = Number(process.env.CDP_PORT || 9878)

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    if (await check()) return
    await sleep(50)
  }
  throw new Error(message)
}

async function main() {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, `# 本地链接\n\n[打开本地 Markdown](${missingTarget})\n`, 'utf8')

  const app = await launchBuiltElectron({
    profileDir: join(dir, 'profile'),
    port,
    appArgs: [file]
  })
  try {
    const { evaluate } = app
    await waitFor(
      () => evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent)`),
      'Rich editor did not become visible'
    )
    const result = await evaluate(`(() => {
      const anchor = [...document.querySelectorAll('.ProseMirror a')].find((node) => node.offsetParent)
      if (!anchor) return { found: false }
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        metaKey: true
      })
      const dispatched = anchor.dispatchEvent(event)
      return {
        found: true,
        href: anchor.getAttribute('href'),
        defaultPrevented: event.defaultPrevented,
        dispatched
      }
    })()`)
    assert.equal(result.found, true, 'Local Markdown link was not rendered')
    assert.equal(result.href, missingTarget, 'Test fixture did not retain the bare absolute path')
    assert.equal(result.defaultPrevented, true, 'Cmd/Ctrl-click on an absolute local path did not enter the local-file route')
    assert.equal(result.dispatched, false, 'Absolute local link was allowed to navigate the renderer')
    console.log('PASS local Markdown links UI: Cmd/Ctrl-click intercepts a bare absolute local path for the file-only IPC route')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
