import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-mixed-rich-source-${process.pid}`
const file = join(root, 'mixed.md')
const port = Number(process.env.CDP_PORT || 10024)
const keyDelay = Number(process.env.MIXED_EDIT_KEY_DELAY || 45)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''

const authored = [
  '# 检查',
  '',
  '>',
  '',
  '>',
  '',
  '## 目录',
  '',
  '- 管理层',
  '- 综合行政部',
  '- 4. 技术部',
  '',
  '## 说明',
  '',
  '- 适用标准：**ISO 9001:2015**',
  '- 而为',
  ''
].join('\n')

const expected = authored
  .replace('## 目录', '## 目录新增')
  .replace('- 综合行政部', '- ')
  .replace('- 而为', '- 而为新增')

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...point,
    button: 'left',
    clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...point,
    button: 'left',
    clickCount: 1
  })
}

const pointForText = (evaluate, selector, target) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.offsetParent)
  const node = [...(editor?.querySelectorAll(${JSON.stringify(selector)}) || [])]
    .find((candidate) => candidate.textContent === ${JSON.stringify(target)})
  if (!node) return null
  const rect = node.getBoundingClientRect()
  return {
    x: Math.max(rect.left + 5, rect.right - 3),
    y: rect.top + Math.max(3, Math.min(12, rect.height / 2))
  }
})()`)

async function clickTextEnd(evaluate, send, selector, text) {
  const point = await pointForText(evaluate, selector, text)
  assert.ok(point, `missing rich block: ${text}`)
  await click(send, point)
  await pressKey(send, { key: 'End', code: 'End', delayMs: keyDelay })
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

async function openApp(profile, appPort, { reopened = false } = {}) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(
    () => app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent)
      return ${JSON.stringify(reopened)}
        ? editor?.textContent.includes('目录新增') &&
          editor?.textContent.includes('而为新增') &&
          !editor?.textContent.includes('综合行政部')
        : editor?.textContent.includes('综合行政部') && editor?.textContent.includes('而为')
    })()`),
    'mixed fixture did not mount in rich mode'
  )
  await sleep(500)
  return app
}

async function assertSource(evaluate, stage) {
  const source = await waitFor(() => visibleSource(evaluate), `${stage}: source textarea did not appear`)
  if (source !== expected) {
    const diagnostics = await evaluate(`(() => ({
      preserve: (window.__hmPreserveLog || []).slice(-80)
        .map(({ source, previous, next, markdown, ...entry }) => entry),
      integrity: (window.__hmSourceIntegrityTrace || []).slice(-80).map((entry) => ({
        ok: entry.ok,
        semanticOk: entry.semanticOk,
        listSlotsMatch: entry.listSlotsMatch,
        preservationReason: entry.preservationReason,
        validationSite: entry.validationSite
      })),
      coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-80),
      journal: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-120),
      listOwner: (window.__hmListSubtreeTransactionTrace || []).slice(-120),
      listItemOwner: (window.__hmListItemTransactionTrace || []).slice(-120),
      plainOwner: (window.__hmTransactionFirstTrace || []).slice(-120),
      flush: (window.__hmFlushTrace || []).slice(-80),
      toasts: [...document.querySelectorAll('[class*="toast"]')]
        .filter((node) => node.offsetParent)
        .map((node) => node.textContent || '')
    }))()`)
    console.error(`--- ${stage} actual ---\n${source}--- expected ---\n${expected}`)
    console.error(`--- ${stage} diagnostics ---\n${JSON.stringify(diagnostics)}`)
  }
  assert.equal(source, expected, `${stage}: rich edits did not reach the authored source exactly`)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, authored)

  let app
  try {
    app = await openApp('edit', port)
    const { evaluate, send } = app
    await evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceSyncCoordinatorTrace = []
      window.__hmSourceSyncTransactionJournalTrace = []
      window.__hmListSubtreeTransactionTrace = []
      window.__hmListItemTransactionTrace = []
      window.__hmTransactionFirstTrace = []
      window.__hmFlushTrace = []
    })()`)

    // Perform three edits in separate blocks faster than Milkdown's delayed
    // markdownUpdated callback. Every inserted character and Backspace travels
    // through Chromium's incremental input path, matching human typing.
    await clickTextEnd(evaluate, send, 'h2', '目录')
    await typeTextLikeUser(send, '新增', { delayMs: keyDelay })

    await clickTextEnd(evaluate, send, 'li p', '综合行政部')
    for (const _character of [...'综合行政部']) {
      await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: keyDelay })
    }

    await clickTextEnd(evaluate, send, 'li p', '而为')
    await typeTextLikeUser(send, '新增', { delayMs: keyDelay })

    // Switch immediately: no sleep is allowed to hide a stale callback race.
    assert.equal(await toggleSource(evaluate), true, 'could not request source mode')
    await assertSource(evaluate, 'immediate rich→source')
    const listItemOwnership = await evaluate(`(() => ({
      preserve: (window.__hmPreserveLog || []).filter((entry) =>
        entry.reason === 'list-item-paragraph-text-change'
      ),
      coordinator: (window.__hmSourceSyncCoordinatorTrace || []).filter((entry) =>
        entry.phase === 'published' && entry.family === 'list-item-paragraph-text-replace'
      ),
      owner: (window.__hmListItemTransactionTrace || []).filter((entry) =>
        entry.phase === 'published' && entry.family === 'list-item-paragraph-text-replace'
      )
    }))()`)
    assert.equal(listItemOwnership.preserve.length, 2,
      `both list-item text edits must use the focused owner: ${JSON.stringify(listItemOwnership)}`)
    const emptiedPublication = listItemOwnership.preserve.find((entry) =>
      entry.integrityProof?.emptied === true &&
      entry.integrityProof?.previousText === '综合行政部' &&
      entry.integrityProof?.nextText === ''
    )
    assert.ok(emptiedPublication,
      `empty list item did not retain its focused proof: ${JSON.stringify(listItemOwnership)}`)
    assert.equal(listItemOwnership.coordinator.length, 2)
    assert.equal(listItemOwnership.coordinator.every((entry) =>
      entry.boundary === 'transaction-list-item-paragraph-forced-flush'
    ), true)
    assert.equal(listItemOwnership.owner.length, 2)
    assert.equal(listItemOwnership.owner.some((entry) =>
      entry.journalId === emptiedPublication.integrityProof.journalId &&
      entry.boundary === 'transaction-list-item-paragraph-forced-flush'
    ), true)

    assert.equal(await toggleSource(evaluate), true, 'could not return to rich mode')
    await waitFor(
      () => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')]
          .find((node) => node.offsetParent)
        return editor?.textContent.includes('目录新增') &&
          editor?.textContent.includes('而为新增') &&
          !editor?.textContent.includes('综合行政部')
      })()`),
      'rich mode did not retain the synchronized edits'
    )

    assert.equal(await toggleSource(evaluate), true, 'could not inspect source a second time')
    await assertSource(evaluate, 'second source round-trip')
    assert.equal(await toggleSource(evaluate), true, 'could not return to rich before save')

    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    assert.equal(await readFile(file, 'utf8'), expected, 'disk content differs from the synchronized source')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1, { reopened: true })
    assert.equal(await toggleSource(app.evaluate), true, 'could not inspect source after reopen')
    await assertSource(app.evaluate, 'full reopen')

    console.log('PASS mixed rich/source transaction: cross-block add/delete/add survives immediate switch, save, and reopen')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
