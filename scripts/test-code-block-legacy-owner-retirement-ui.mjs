import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'
import {
  clearCodeBlockExitDiagnostics,
  openCodeBlockExitApp,
  readCodeBlockExitDiagnostics,
  waitFor
} from './lib/code-block-exit-test.mjs'

const root = `/tmp/horsemd-code-block-legacy-retirement-${process.pid}`
const file = join(root, 'collision.md')
const profile = join(root, 'profile')
const port = Number(process.env.CDP_PORT || 15320 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '\uFEFFbefore\r\n\r\n~~~js\r\nconsole.log(1)\r\n~~~\r\n\r\nafter\r\n'
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const focusCodeBlockTextEnd = async (app) => {
  const point = await app.evaluate(`(() => {
    const content = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
      ?.querySelector('.milkdown-code-block .cm-content')
    const line = content?.querySelector('.cm-line:last-child')
    const rect = line?.getBoundingClientRect()
    return rect ? {
      x: Math.max(rect.left + 2, rect.right - 2),
      y: (rect.top + rect.bottom) / 2
    } : null
  })()`)
  if (!point) return false
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    ...point
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    ...point
  })
  await pressKey(app.send, { key: 'End', code: 'End', delayMs: 20 })
  return true
}

let app = null
let completed = false
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await openCodeBlockExitApp({
    file,
    profileDir: profile,
    port,
    packagedAppPath
  })
  await clearCodeBlockExitDiagnostics(app)
  assert.equal(await focusCodeBlockTextEnd(app), true)

  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 20 })
  await typeTextLikeUser(app.send, '~~~', { delayMs: 30 })
  await waitFor(() => app.evaluate(`(() => {
    const content = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
      ?.querySelector('.milkdown-code-block .cm-content')
    const lines = [...(content?.querySelectorAll('.cm-line') || [])]
      .map((node) => node.textContent || '')
    return lines.includes('console.log(1)') && lines.at(-1) === '~~~'
  })()`), 'physical collision did not form an independent final code line')
  await sleep(1400)

  const state = await readCodeBlockExitDiagnostics(app)
  const blocked = state.owner.filter((entry) =>
    entry.phase === 'plan' &&
    entry.family === 'code-block-content-replace' &&
    entry.reason === 'code-block-source-fence-collision'
  )
  assert.equal(blocked.length >= 1, true, JSON.stringify(state.owner))
  assert.equal(blocked.every((entry) =>
    entry.recognized === true && entry.legacyBlocked === true
  ), true, JSON.stringify(blocked))
  assert.equal(state.preserve.some((entry) =>
    entry.reason === 'fenced-code-block-content-change'
  ), false, `collision unexpectedly published source: ${JSON.stringify(state.preserve)}`)
  assert.equal(state.coordinator.some((entry) =>
    entry.phase === 'published' &&
    (entry.family === 'code-block-content-replace' || entry.owner === 'legacy')
  ), false, `collision reached Coordinator publication: ${JSON.stringify(state.coordinator)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), true,
    `collision did not report a fail-closed warning: ${JSON.stringify(state.toasts)}`)
  assert.equal(await app.evaluate(`Boolean(
    [...document.querySelectorAll('textarea.source-editor')]
      .find((node) => node.offsetParent)
  )`), false, 'fail-closed callback switched to a stale source textarea')
  assert.equal(await readFile(file, 'utf8'), fixture,
    'fail-closed collision overwrote the authored file')

  completed = true
  console.log('PASS code-block legacy retirement UI: a physical tilde-fence collision is recognized by the transaction owner, blocks legacy fallback, keeps the rich edit visible, warns, and leaves source/disk untouched')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true })
}
