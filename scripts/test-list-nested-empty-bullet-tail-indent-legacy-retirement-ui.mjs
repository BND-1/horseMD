import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-nested-empty-tail-indent-retirement-${process.pid}`
const file = join(root, 'wide-spacing.md')
const port = Number(process.env.CDP_PORT || 21220 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '\uFEFFbefore\r\n\r\n-  alpha\r\n-  beta\r\n-  \r\n\r\nafter\r\n'
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
    const top = [...(editor?.querySelectorAll('ul') || [])].find((node) => !node.parentElement?.closest('ul'))
    const items = [...(top?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
    const last = items.at(-1)?.querySelector(':scope > .children > .content-dom > p') || items.at(-1)?.querySelector('p')
    return items.length === 3 && (editor?.textContent || '').includes('alpha') &&
      (editor?.textContent || '').includes('beta') && !(last?.textContent || '').replace(/\\u200B/g, '').trim()
  })()`), 'wide-spacing fixture did not mount as three-item bullet list')

  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceSyncCoordinatorTrace = []
    window.__hmListNestedEmptyBulletTailIndentTransactionTrace = []
    window.__hmListSubtreeTransactionTrace = []
  })()`)

  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const top = [...(editor?.querySelectorAll('ul') || [])].find((node) => !node.parentElement?.closest('ul'))
    const items = [...(top?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
    const p = items.at(-1)?.querySelector(':scope > .children > .content-dom > p') || items.at(-1)?.querySelector('p')
    const rect = p?.getBoundingClientRect()
    return rect && !(p.textContent || '').replace(/\\u200B/g, '').trim()
      ? { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
      : null
  })()`)
  assert.ok(point, 'wide-spacing empty tail not hit-testable')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await pressKey(app.send, { key: 'Tab', code: 'Tab', delayMs: 80 })

  await waitFor(() => app.evaluate(`(() =>
    (window.__hmListNestedEmptyBulletTailIndentTransactionTrace || []).some((entry) =>
      entry.phase === 'plan' && entry.family === 'list-nested-empty-bullet-tail-indent' &&
      entry.reason === 'nested-empty-bullet-indent-source-row-unproven' &&
      entry.recognized === true && entry.legacyBlocked === true
    )
  )()`), 'wide-spacing nested indent did not fail closed')
  await sleep(250)

  const state = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const top = [...(editor?.querySelectorAll('ul') || [])].find((node) => !node.parentElement?.closest('ul'))
    const topItems = [...(top?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
    return {
      owner: (window.__hmListNestedEmptyBulletTailIndentTransactionTrace || []).slice(-40),
      broad: (window.__hmListSubtreeTransactionTrace || []).slice(-40),
      preserve: (window.__hmPreserveLog || []).slice(-40).map(({ source, previous, next, markdown, ...entry }) => entry),
      coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-40),
      toasts: [...document.querySelectorAll('[class*="toast"]')]
        .filter((node) => node.offsetParent)
        .map((node) => node.textContent || ''),
      topCount: topItems.length,
      nestedCount: editor?.querySelectorAll('ul ul').length || 0
    }
  })()`)

  const blocked = state.owner.filter((entry) =>
    entry.phase === 'plan' && entry.reason === 'nested-empty-bullet-indent-source-row-unproven'
  )
  assert.equal(blocked.length >= 1, true, JSON.stringify(state.owner))
  assert.equal(blocked.every((entry) => entry.recognized === true && entry.legacyBlocked === true), true)
  assert.equal(state.preserve.some((entry) => entry.reason === 'list-nested-empty-bullet-tail-indented'), false)
  assert.equal(state.preserve.some((entry) => entry.reason === 'transaction-list-subtree'), false,
    `rejected focused indent unexpectedly fell back to broad mapper: ${JSON.stringify(state.preserve)}`)
  assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === true), false)
  assert.equal(state.coordinator.some((entry) => entry.phase === 'published'), false,
    `rejected focused indent unexpectedly published: ${JSON.stringify(state.coordinator)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), true,
    `fail-closed warning missing: ${JSON.stringify(state.toasts)}`)
  assert.equal(state.topCount, 2, 'rich PM Tab sink should remain applied')
  assert.equal(state.nestedCount, 1, 'rich PM nested list should remain visible after source rejection')
  assert.equal(await readFile(file, 'utf8'), fixture, 'fail-closed nested indent overwrote disk')

  completed = true
  console.log('PASS nested empty bullet tail indent legacy retirement UI: two-space authored markers are recognized by the exact sink family, block broad/legacy fallback, retain rich indent, warn, and leave disk untouched')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true })
}
