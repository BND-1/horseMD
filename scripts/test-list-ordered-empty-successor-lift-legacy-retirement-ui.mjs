import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-ordered-successor-retirement-${process.pid}`
const file = join(root, 'indented.md')
const port = Number(process.env.CDP_PORT || 19680 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '\uFEFFbefore\r\n\r\n 1. alpha\r\n\r\n 2. \r\n\r\n 3. beta\r\n\r\nafter\r\n'
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
    const list = [...(editor?.querySelectorAll('ol') || [])].find((node) => (node.textContent || '').includes('alpha') && (node.textContent || '').includes('beta'))
    const items = [...(list?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
    return items.length === 3 && !(items[1]?.querySelector('p')?.textContent || '').replace(/\\u200B/g, '').trim()
  })()`), 'indented ordered fixture did not mount as three-item list')

  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceSyncCoordinatorTrace = []
    window.__hmListOrderedEmptySuccessorLiftTransactionTrace = []
    window.__hmListSubtreeTransactionTrace = []
  })()`)
  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const list = [...(editor?.querySelectorAll('ol') || [])].find((node) => (node.textContent || '').includes('alpha'))
    const items = [...(list?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
    const p = items[1]?.querySelector(':scope > .children > .content-dom > p') || items[1]?.querySelector('p')
    const rect = p?.getBoundingClientRect()
    return rect && !(p.textContent || '').replace(/\\u200B/g, '').trim()
      ? { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
      : null
  })()`)
  assert.ok(point)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 18 })

  await waitFor(() => app.evaluate(`(() =>
    (window.__hmListOrderedEmptySuccessorLiftTransactionTrace || []).some((entry) =>
      entry.phase === 'plan' && entry.family === 'list-ordered-empty-successor-lift' &&
      entry.reason === 'ordered-successor-lift-range-unmapped' &&
      entry.recognized === true && entry.legacyBlocked === true
    )
  )()`), 'indented ordered successor family did not fail closed')
  await sleep(250)

  const state = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const list = [...(editor?.querySelectorAll('ol') || [])].find((node) => (node.textContent || '').includes('alpha'))
    const items = [...(list?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
    return {
      owner: (window.__hmListOrderedEmptySuccessorLiftTransactionTrace || []).slice(-30),
      broad: (window.__hmListSubtreeTransactionTrace || []).slice(-30),
      preserve: (window.__hmPreserveLog || []).slice(-30).map(({ source, previous, next, markdown, ...entry }) => entry),
      coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-30),
      toasts: [...document.querySelectorAll('[class*="toast"]')].filter((node) => node.offsetParent).map((node) => node.textContent || ''),
      itemCount: items.length,
      texts: items.map((item) => (item.querySelector('p')?.textContent || '').replace(/\\u200B/g, '')),
      firstParagraphCount: items[0]?.querySelectorAll(':scope > .children > .content-dom > p').length || 0
    }
  })()`)
  const blocked = state.owner.filter((entry) =>
    entry.phase === 'plan' && entry.reason === 'ordered-successor-lift-range-unmapped'
  )
  assert.equal(blocked.length >= 1, true, JSON.stringify(state.owner))
  assert.equal(blocked.every((entry) => entry.recognized === true && entry.legacyBlocked === true), true)
  assert.equal(state.preserve.some((entry) => entry.reason === 'list-ordered-empty-successor-lifted'), false)
  assert.equal(state.preserve.some((entry) => entry.reason === 'transaction-list-subtree' || entry.reason === 'diverged-empty-ordered-backspace-lift'), false,
    `rejected focused family unexpectedly fell back: ${JSON.stringify(state.preserve)}`)
  assert.equal(state.coordinator.some((entry) => entry.phase === 'published'), false)
  assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === true), false)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), true, JSON.stringify(state.toasts))
  assert.equal(state.itemCount, 2, 'rich PM edit should remain applied')
  assert.deepEqual(state.texts, ['alpha', 'beta'])
  assert.equal(state.firstParagraphCount, 2, 'rich PM transient paragraph should remain visible')
  assert.equal(await readFile(file, 'utf8'), fixture, 'fail-closed successor lift overwrote disk')

  completed = true
  console.log('PASS ordered empty successor lift legacy retirement UI: one-space authored ordered rows are recognized by the exact two-Step family, block broad/legacy fallback, retain rich edit, warn, and leave disk untouched')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true })
}
