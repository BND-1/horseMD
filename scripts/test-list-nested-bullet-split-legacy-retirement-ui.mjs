import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-nested-bullet-split-retirement-${process.pid}`
const file = join(root, 'wide-marker-spacing.md')
const port = Number(process.env.CDP_PORT || 24120 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  +  gamma\r\n  + delta\r\n+ omega\r\n\r\nafter\r\n'
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
    return (editor?.textContent || '').includes('gamma') && (editor?.textContent || '').includes('delta') &&
      (editor?.querySelectorAll('ul ul').length || 0) === 1
  })()`), 'wide marker-spacing nested split fixture did not mount')

  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceSyncCoordinatorTrace = []
    window.__hmListNestedBulletSplitTransactionTrace = []
    window.__hmListNestedFirstChildBulletOutdentTransactionTrace = []
    window.__hmListNestedLastChildBulletOutdentTransactionTrace = []
    window.__hmListNestedSingleChildBulletOutdentTransactionTrace = []
    window.__hmListSubtreeTransactionTrace = []
  })()`)
  const placed = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const item = [...(editor?.querySelectorAll('ul ul li') || [])].find((candidate) => {
      const p = candidate.querySelector(':scope > .children > .content-dom > p') || candidate.querySelector('p')
      return (p?.textContent || '') === 'gamma'
    })
    const p = item?.querySelector(':scope > .children > .content-dom > p') || item?.querySelector('p')
    const text = [...(p?.childNodes || [])].find((node) => node.nodeType === Node.TEXT_NODE)
    if (!text) return false
    const range = document.createRange()
    range.setStart(text, 2)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.equal(placed, true)
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 80 })

  await waitFor(() => app.evaluate(`(() =>
    (window.__hmListNestedBulletSplitTransactionTrace || []).some((entry) =>
      entry.phase === 'plan' && entry.family === 'list-nested-bullet-item-split' &&
      entry.reason === 'nested-bullet-split-source-row-unproven' &&
      entry.recognized === true && entry.legacyBlocked === true
    )
  )()`), 'wide marker-spacing nested split did not fail closed')
  await sleep(250)

  const state = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const directParagraph = (item) => item?.querySelector(':scope > .children > .content-dom > p') || item?.querySelector('p')
    const nested = [...(editor?.querySelectorAll('ul ul') || [])]
    return {
      owner: (window.__hmListNestedBulletSplitTransactionTrace || []).slice(-40),
      first: (window.__hmListNestedFirstChildBulletOutdentTransactionTrace || []).slice(-40),
      last: (window.__hmListNestedLastChildBulletOutdentTransactionTrace || []).slice(-40),
      single: (window.__hmListNestedSingleChildBulletOutdentTransactionTrace || []).slice(-40),
      broad: (window.__hmListSubtreeTransactionTrace || []).slice(-40),
      preserve: (window.__hmPreserveLog || []).slice(-40).map(({ source, previous, next, markdown, ...entry }) => entry),
      coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-40),
      toasts: [...document.querySelectorAll('[class*="toast"]')].filter((node) => node.offsetParent).map((node) => node.textContent || ''),
      nestedTexts: nested.flatMap((list) => [...list.querySelectorAll(':scope > .milkdown-list-item-block > li')]
        .map((item) => directParagraph(item)?.textContent || ''))
    }
  })()`)
  const blocked = state.owner.filter((entry) => entry.phase === 'plan' && entry.reason === 'nested-bullet-split-source-row-unproven')
  assert.equal(blocked.length >= 1, true, JSON.stringify(state.owner))
  assert.equal(blocked.every((entry) => entry.recognized === true && entry.legacyBlocked === true), true)
  assert.deepEqual(state.nestedTexts, ['ga', 'mma', 'delta'])
  assert.equal(state.preserve.some((entry) => entry.reason === 'list-nested-bullet-item-split'), false)
  assert.equal(state.preserve.some((entry) => entry.reason === 'transaction-list-subtree'), false)
  assert.equal(state.first.some((entry) => entry.phase === 'published' && entry.ok === true), false)
  assert.equal(state.last.some((entry) => entry.phase === 'published' && entry.ok === true), false)
  assert.equal(state.single.some((entry) => entry.phase === 'published' && entry.ok === true), false)
  assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === true), false)
  assert.equal(state.coordinator.some((entry) => entry.phase === 'published'), false)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), true, JSON.stringify(state.toasts))
  assert.equal(await readFile(file, 'utf8'), fixture, 'fail-closed nested split overwrote disk')

  completed = true
  console.log('PASS nested bullet split legacy retirement UI: two-space marker padding is recognized by the exact splitListItem family, blocks outdent/broad/legacy fallback, retains rich split, warns, and leaves disk untouched')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true })
}
