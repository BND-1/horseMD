import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-ordered-successor-chain-retirement-${process.pid}`
const file = join(root, 'indented-chain.md')
const port = Number(process.env.CDP_PORT || 20500 + (process.pid % 20))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '\uFEFFbefore\r\n\r\n 1. alpha\r\n\r\n 2. \r\n\r\n 3. beta\r\n\r\n 4. gamma\r\n\r\nafter\r\n'
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
    const list = [...(editor?.querySelectorAll(':scope > ol') || [])].find((node) => (node.textContent || '').includes('alpha') && (node.textContent || '').includes('gamma'))
    const items = [...(list?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
    return items.length === 4 && !(items[1]?.querySelector('p')?.textContent || '').replace(/\\u200B/g, '').trim()
  })()`), 'indented four-item ordered fixture did not mount')

  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceSyncCoordinatorTrace = []
    window.__hmListOrderedEmptySuccessorChainTransactionTrace = []
    window.__hmListOrderedEmptySuccessorLiftTransactionTrace = []
    window.__hmListSubtreeTransactionTrace = []
  })()`)
  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const list = [...(editor?.querySelectorAll(':scope > ol') || [])].find((node) => (node.textContent || '').includes('alpha'))
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
    (window.__hmListOrderedEmptySuccessorChainTransactionTrace || []).some((entry) =>
      entry.phase === 'plan' && entry.family === 'list-ordered-empty-successor-chain-lift' &&
      entry.recognized === true && entry.legacyBlocked === true
    )
  )()`), 'indented successor-chain family did not fail closed')
  await sleep(250)

  const state = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const list = [...(editor?.querySelectorAll(':scope > ol') || [])].find((node) => (node.textContent || '').includes('alpha'))
    const items = [...(list?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
    return {
      chain: (window.__hmListOrderedEmptySuccessorChainTransactionTrace || []).slice(-40),
      single: (window.__hmListOrderedEmptySuccessorLiftTransactionTrace || []).slice(-40),
      broad: (window.__hmListSubtreeTransactionTrace || []).slice(-40),
      preserve: (window.__hmPreserveLog || []).slice(-40).map(({ source, previous, next, markdown, ...entry }) => entry),
      coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-40),
      toasts: [...document.querySelectorAll('[class*="toast"]')].filter((node) => node.offsetParent).map((node) => node.textContent || ''),
      itemCount: items.length,
      texts: items.map((item) => (item.querySelector(':scope > .children > .content-dom > p')?.textContent || '').replace(/\\u200B/g, '')),
      firstParagraphCount: items[0]?.querySelectorAll(':scope > .children > .content-dom > p').length || 0
    }
  })()`)
  const blocked = state.chain.filter((entry) => entry.phase === 'plan' && entry.recognized === true)
  assert.equal(blocked.length >= 1, true, JSON.stringify(state.chain))
  assert.equal(blocked.every((entry) => entry.legacyBlocked === true), true)
  assert.equal(blocked.some((entry) => entry.reason === 'ordered-successor-chain-range-unmapped'), true,
    `unexpected focused rejection: ${JSON.stringify(blocked)}`)
  assert.equal(state.preserve.some((entry) => entry.reason === 'list-ordered-empty-successor-chain-lifted'), false)
  assert.equal(state.preserve.some((entry) =>
    entry.reason === 'list-ordered-empty-successor-lifted' ||
    entry.reason === 'transaction-list-subtree' ||
    entry.reason === 'diverged-empty-ordered-backspace-lift' ||
    entry.reason === 'diverged-empty-ordered-backspace-successor-chain'
  ), false, `rejected chain unexpectedly fell back: ${JSON.stringify(state.preserve)}`)
  assert.equal(state.coordinator.some((entry) => entry.phase === 'published'), false)
  assert.equal(state.single.some((entry) => entry.phase === 'published' && entry.ok === true), false)
  assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === true), false)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), true, JSON.stringify(state.toasts))
  assert.equal(state.itemCount, 3, 'rich PM chain edit should remain applied')
  assert.deepEqual(state.texts, ['alpha', 'beta', 'gamma'])
  assert.equal(state.firstParagraphCount, 2, 'rich PM transient paragraph should remain visible')
  assert.equal(await readFile(file, 'utf8'), fixture, 'fail-closed successor chain overwrote disk')

  completed = true
  console.log('PASS ordered empty successor-chain legacy retirement UI: one-space authored four-item rows are recognized by the exact merge+relabel chain family, block single/broad/legacy fallback, retain rich edit, warn and leave disk untouched')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true })
}
