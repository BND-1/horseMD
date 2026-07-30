import assert from 'node:assert/strict'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const app = await launchBuiltElectron({
  profileDir: '/tmp/horsemd-background-cdp-ui',
  port: Number(process.env.CDP_PORT || 9661),
  appArgs: [join(process.cwd(), 'scripts', 'fixtures', 'inline-code-input.md')]
})

try {
  assert(app.child.spawnargs.includes('--horsemd-test-background'),
    'CDP launcher did not request a background test window')

  const initial = await app.evaluate(`(() => ({
    focused: document.hasFocus(),
    ready: document.readyState,
    editor: !![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  }))()`)
  assert.equal(initial.focused, false, 'Background test window took native focus')
  assert.equal(initial.ready, 'complete', 'Background renderer did not finish loading')
  assert.equal(initial.editor, true, 'Background renderer did not mount the editor')

  const placed = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    return true
  })()`)
  assert.equal(placed, true, 'Could not place a caret in the background editor')

  const marker = '后台逐字输入'
  await typeTextLikeUser(app.send, marker)
  await sleep(250)
  const typed = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    return editor?.textContent?.endsWith(${JSON.stringify(marker)}) || false
  })()`)
  assert.equal(typed, true, 'Per-character CDP input failed in the background window')

  console.log('PASS background CDP UI: hidden launch kept native focus and accepted per-character input')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
}
