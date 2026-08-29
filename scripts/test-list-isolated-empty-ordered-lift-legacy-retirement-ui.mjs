import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-isolated-ordered-retirement-${process.pid}`
const file = join(root, 'indented-ordered.md')
const port = Number(process.env.CDP_PORT || 18620 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '\uFEFFbefore\r\n\r\n- literal\r\n\r\n 1. \r\n\r\n- right\r\n\r\nafter\r\n'
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
    const children = [...(editor?.children || [])]
    const index = children.findIndex((node) => node.tagName === 'OL')
    if (index < 1 || index + 1 >= children.length) return false
    const ordered = children[index]
    const paragraph = ordered.querySelector('li p')
    return children[index - 1]?.tagName === 'UL' && children[index + 1]?.tagName === 'UL' &&
      (children[index - 1].textContent || '').includes('literal') &&
      (children[index + 1].textContent || '').includes('right') &&
      !(paragraph?.textContent || '').replace(/\\u200B/g, '').trim()
  })()`), 'indented top-level ordered fixture did not mount as isolated ordered list')

  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceSyncCoordinatorTrace = []
    window.__hmListIsolatedEmptyOrderedLiftTransactionTrace = []
    window.__hmListEmptyItemFirstTransactionTrace = []
    window.__hmListEmptyItemTailTransactionTrace = []
    window.__hmListEmptyItemTransactionTrace = []
    window.__hmListSubtreeTransactionTrace = []
  })()`)

  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const ordered = [...(editor?.children || [])].find((node) => node.tagName === 'OL')
    const paragraph = ordered?.querySelector('li p')
    const rect = paragraph?.getBoundingClientRect()
    return rect && !(paragraph.textContent || '').replace(/\\u200B/g, '').trim()
      ? { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
      : null
  })()`)
  assert.ok(point, 'indented ordered empty item not hit-testable')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 18 })

  await waitFor(() => app.evaluate(`(() =>
    (window.__hmListIsolatedEmptyOrderedLiftTransactionTrace || []).some((entry) =>
      entry.phase === 'plan' &&
      entry.family === 'list-isolated-empty-ordered-lift' &&
      entry.reason === 'isolated-ordered-lift-row-count' &&
      entry.recognized === true && entry.legacyBlocked === true
    )
  )()`), 'indented ordered authored row did not fail closed')
  await sleep(250)

  const state = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const direct = [...(editor?.children || [])]
    const firstBullet = direct.find((node) => node.tagName === 'UL' && (node.textContent || '').includes('literal'))
    return {
      owner: (window.__hmListIsolatedEmptyOrderedLiftTransactionTrace || []).slice(-40),
      first: (window.__hmListEmptyItemFirstTransactionTrace || []).slice(-40),
      tail: (window.__hmListEmptyItemTailTransactionTrace || []).slice(-40),
      interior: (window.__hmListEmptyItemTransactionTrace || []).slice(-40),
      broad: (window.__hmListSubtreeTransactionTrace || []).slice(-40),
      preserve: (window.__hmPreserveLog || []).slice(-40).map(({ source, previous, next, markdown, ...entry }) => entry),
      coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-40),
      toasts: [...document.querySelectorAll('[class*="toast"]')]
        .filter((node) => node.offsetParent)
        .map((node) => node.textContent || ''),
      topOrdered: direct.filter((node) => node.tagName === 'OL').length,
      firstBulletItems: [...(firstBullet?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
        .map((item) => item.querySelector('p')?.textContent || '')
    }
  })()`)

  const blocked = state.owner.filter((entry) =>
    entry.phase === 'plan' && entry.reason === 'isolated-ordered-lift-row-count'
  )
  assert.equal(blocked.length >= 1, true, JSON.stringify(state.owner))
  assert.equal(blocked.every((entry) => entry.recognized === true && entry.legacyBlocked === true), true)
  assert.equal(state.preserve.some((entry) => entry.reason === 'list-isolated-empty-ordered-lifted'), false)
  assert.equal(state.preserve.some((entry) => entry.reason === 'diverged-isolated-empty-ordered-backspace-lift'), false,
    `legacy unexpectedly rescued rejected isolated lift: ${JSON.stringify(state.preserve)}`)
  assert.equal(state.coordinator.some((entry) => entry.phase === 'published'), false,
    `rejected isolated lift unexpectedly published: ${JSON.stringify(state.coordinator)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), true,
    `fail-closed warning missing: ${JSON.stringify(state.toasts)}`)
  assert.equal(state.topOrdered, 0, 'rich PM lift should remain applied after fail-closed source rejection')
  assert.equal(state.firstBulletItems.includes('literal'), true)
  assert.equal(state.firstBulletItems.includes(''), true)
  assert.equal(state.first.some((entry) => entry.phase === 'published'), false)
  assert.equal(state.tail.some((entry) => entry.phase === 'published'), false)
  assert.equal(state.interior.some((entry) => entry.phase === 'published'), false)
  assert.equal(state.broad.some((entry) => entry.phase === 'published'), false)
  assert.equal(await readFile(file, 'utf8'), fixture, 'fail-closed isolated ordered lift overwrote disk')

  completed = true
  console.log('PASS isolated empty ordered lift legacy retirement UI: one-space authored ordered marker is recognized by the exact PM family, blocks legacy fallback, keeps the rich lift, warns, and leaves source/disk untouched')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true })
}
