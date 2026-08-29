import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-empty-item-tail-retirement-${process.pid}`
const file = join(root, 'loose-tail.md')
const port = Number(process.env.CDP_PORT || 16180 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '\uFEFFbefore\r\n\r\n- left\r\n\r\n- \r\n\r\nafter\r\n'
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const waitFor = async (check, message, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

let app = null
let completed = false
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(() => app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const list = [...(editor?.querySelectorAll('ul') || [])]
      .find((node) => node.offsetParent && (node.textContent || '').includes('left'))
    const items = [...(list?.querySelectorAll('li') || [])]
    return items.length === 2 && !(items.at(-1)?.querySelector('p')?.textContent || '').trim()
  })()`), 'loose tail list did not mount')

  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceSyncCoordinatorTrace = []
    window.__hmListEmptyItemTailTransactionTrace = []
    window.__hmListEmptyItemTransactionTrace = []
  })()`)
  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const list = [...(editor?.querySelectorAll('ul') || [])]
      .find((node) => node.offsetParent && (node.textContent || '').includes('left'))
    const paragraph = [...(list?.querySelectorAll('li') || [])].at(-1)?.querySelector('p')
    const rect = paragraph?.getBoundingClientRect()
    return rect && !(paragraph.textContent || '').trim()
      ? { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
      : null
  })()`)
  assert.ok(point, 'loose tail empty item not hit-testable')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 20 })

  await waitFor(() => app.evaluate(`(() =>
    (window.__hmListEmptyItemTailTransactionTrace || []).some((entry) =>
      entry.phase === 'plan' &&
      entry.family === 'list-empty-item-tail-remove' &&
      entry.reason === 'list-empty-item-tail-authored-row-unproven' &&
      entry.recognized === true && entry.legacyBlocked === true
    )
  )()`), 'loose tail authored rows did not fail closed')
  await sleep(250)

  const state = await app.evaluate(`(() => ({
    owner: (window.__hmListEmptyItemTailTransactionTrace || []).slice(-40),
    interior: (window.__hmListEmptyItemTransactionTrace || []).slice(-40),
    preserve: (window.__hmPreserveLog || []).slice(-40).map(({ source, previous, next, markdown, ...entry }) => entry),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-40),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || ''),
    visibleSource: Boolean([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)),
    items: [...([...(document.querySelectorAll('.ProseMirror'))].find((node) => node.offsetParent)?.querySelectorAll('li') || [])]
      .map((item) => [...item.querySelectorAll('p')].map((p) => p.textContent || ''))
  }))()`)
  const blocked = state.owner.filter((entry) =>
    entry.phase === 'plan' && entry.reason === 'list-empty-item-tail-authored-row-unproven'
  )
  assert.equal(blocked.length >= 1, true, JSON.stringify(state.owner))
  assert.equal(blocked.every((entry) => entry.recognized === true && entry.legacyBlocked === true), true)
  assert.equal(state.preserve.some((entry) => entry.reason === 'empty-list-item-removed'), false,
    `legacy unexpectedly rescued loose tail list: ${JSON.stringify(state.preserve)}`)
  assert.equal(state.preserve.some((entry) => entry.reason === 'list-empty-item-tail-removed'), false,
    `failed tail owner unexpectedly preserved: ${JSON.stringify(state.preserve)}`)
  assert.equal(state.coordinator.some((entry) => entry.phase === 'published'), false,
    `failed tail owner unexpectedly published: ${JSON.stringify(state.coordinator)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), true,
    `fail-closed warning missing: ${JSON.stringify(state.toasts)}`)
  assert.equal(state.visibleSource, false)
  assert.equal(await readFile(file, 'utf8'), fixture, 'fail-closed loose tail overwrote disk')
  assert.deepEqual(state.items, [['left', '']],
    'rich PM tail removal should remain visible while durable source stays unchanged')
  assert.equal(state.interior.some((entry) => entry.phase === 'published'), false,
    `interior owner unexpectedly published loose tail: ${JSON.stringify(state.interior)}`)

  completed = true
  console.log('PASS list tail empty-item legacy retirement UI: loose authored tail rows are recognized by the focused tail family, block legacy fallback, retain the rich edit, warn, and leave source/disk untouched')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true })
}
