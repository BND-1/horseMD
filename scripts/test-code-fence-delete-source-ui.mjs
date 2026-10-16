import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-code-fence-delete-${process.pid}`
const file = join(root, 'code-fence-delete.md')
const port = Number(process.env.CDP_PORT || 10044)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const keyDelay = Number(process.env.CODE_FENCE_KEY_DELAY || 65)

const initial = [
  '# 反引号删除回归',
  '',
  '即时源码占位',
  '',
  '即时保存占位',
  '',
  '单反引号占位',
  '',
  '三反引号占位',
  '',
  '反复围栏占位',
  '',
  '围栏输入规则占位',
  '',
  '单加三保留单个占位',
  '',
  '单加三全部删除占位',
  '',
  '后文保留',
  ''
].join('\n')

const expected = initial
  .replace('即时源码占位', '')
  .replace('即时保存占位', '')
  .replace('单反引号占位', '单反引号删除完成')
  .replace('三反引号占位', '三反引号删除完成')
  .replace('反复围栏占位', '反复围栏删除完成')
  .replace('围栏输入规则占位', '围栏输入规则删除完成')
  .replace('单加三保留单个占位', '`')
  .replace('单加三全部删除占位', '单加三全部删除完成')

async function waitFor(check, message, attempts = 120) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', ...point, button: 'left', clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', ...point, button: 'left', clickCount: 1
  })
}

async function clickTextEnd(evaluate, send, text) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      if (node.nodeValue === ${JSON.stringify(text)}) {
        const range = document.createRange()
        range.setStart(node, node.nodeValue.length)
        range.collapse(true)
        const rect = range.getBoundingClientRect()
        return { x: rect.left, y: rect.top + Math.max(3, rect.height / 2) }
      }
    }
    return null
  })()`)
  assert.ok(point, `missing rich paragraph: ${text}`)
  await click(send, point)
  await pressKey(send, { key: 'End', code: 'End', delayMs: keyDelay })
}

async function clearText(evaluate, send, text) {
  await clickTextEnd(evaluate, send, text)
  for (const _character of [...text]) {
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: keyDelay })
  }
}

async function typeBacktick(send) {
  const common = {
    key: '`',
    code: 'Backquote',
    windowsVirtualKeyCode: 192,
    nativeVirtualKeyCode: 192
  }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', {
    type: 'char', ...common, text: '`', unmodifiedText: '`'
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(keyDelay)
}

async function typeSpace(send) {
  const common = {
    key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32
  }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', {
    type: 'char', ...common, text: ' ', unmodifiedText: ' '
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(keyDelay)
}

async function typeAndDeleteBackticks(evaluate, send, placeholder, count, finalText, rounds = 1) {
  await clearText(evaluate, send, placeholder)
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < count; index += 1) await typeBacktick(send)
    for (let index = 0; index < count; index += 1) {
      await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: keyDelay })
    }
  }
  await typeTextLikeUser(send, finalText, { delayMs: keyDelay })
}

async function typeSettledSingleBacktickAndDelete(evaluate, send, placeholder) {
  await clearText(evaluate, send, placeholder)
  await typeBacktick(send)
  // The regression requires the raw source (`) / escaped canonical (\`)
  // baseline to be committed before the deletion transaction arrives.
  await sleep(600)
  await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: keyDelay })
}

async function typeUndoAndDeleteFence(evaluate, send) {
  await clearText(evaluate, send, '围栏输入规则占位')
  for (let index = 0; index < 3; index += 1) await typeBacktick(send)
  await typeSpace(send)
  await sleep(250)
  // With closure-driven inline code, ``` + Space is no longer intercepted as
  // a premature inline mark and correctly activates Crepe's code-block input
  // rule. One Backspace converts that empty code block back to a paragraph;
  // a second Backspace would intentionally join it with the previous block.
  await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: keyDelay })
  await typeTextLikeUser(send, '围栏输入规则删除完成', { delayMs: keyDelay })
}

async function typeOneThenTripleAndDelete(
  evaluate,
  send,
  placeholder,
  deleteCount,
  finalText = '',
  settleBeforeFinalDelete = false
) {
  await clearText(evaluate, send, placeholder)
  await typeBacktick(send)
  for (let index = 0; index < 3; index += 1) await typeBacktick(send)
  const firstDeleteRun = settleBeforeFinalDelete ? Math.max(0, deleteCount - 1) : deleteCount
  for (let index = 0; index < firstDeleteRun; index += 1) {
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: keyDelay })
  }
  if (settleBeforeFinalDelete && deleteCount > firstDeleteRun) {
    // Let the lone raw backtick become the committed authored-source baseline,
    // then delete it. This is the exact source/canonical divergence that used
    // to make the next save fail closed and lock source mode.
    await sleep(600)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: keyDelay })
  }
  if (finalText) await typeTextLikeUser(send, finalText, { delayMs: keyDelay })
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

async function openApp(profile, appPort, reopened = false) {
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
        ? editor?.textContent.includes('反复围栏删除完成')
        : editor?.textContent.includes('反复围栏占位')
    })()`),
    'backtick deletion fixture did not mount'
  )
  await sleep(400)
  return app
}

async function assertSourceOpened(app, stage, expectedSource = expected) {
  assert.equal(await toggleSource(app.evaluate), true, `${stage}: source toggle button missing`)
  const source = await waitFor(
    () => visibleSource(app.evaluate),
    `${stage}: source mode stayed locked after deleting backticks`,
    30
  ).catch(async (error) => {
    const diagnostics = await app.evaluate(`(() => ({
      rich: [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent,
      toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent),
      sourceVisible: !![...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
    }))()`)
    console.error(`${stage} diagnostics:`, diagnostics)
    throw error
  })
  assert.equal(source, expectedSource, `${stage}: deleted backticks or rich edits did not reach source`)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, initial)

  let app
  try {
    app = await openApp('edit', port)
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      if (${JSON.stringify(process.env.TRANSACTION_TRACE === '1')}) {
        window.__hmSourceTransactionTrace = []
        window.__hmSourceTransactionLog = []
      }
    })()`)

    // Boundary A: delete the committed lone raw backtick and switch source
    // immediately, before a forced save can mask a non-forced flush failure.
    await typeSettledSingleBacktickAndDelete(app.evaluate, app.send, '即时源码占位')
    const afterImmediateSourceDelete = initial.replace('即时源码占位', '')
    await assertSourceOpened(app, 'immediate source switch after final backspace', afterImmediateSourceDelete)
    assert.equal(await toggleSource(app.evaluate), true, 'could not return to rich after immediate source boundary')

    // Boundary B: run the same empty-line transition and save immediately.
    // This is isolated before the larger scenario so a later edit cannot heal
    // or obscure the first fail-closed transaction.
    await typeSettledSingleBacktickAndDelete(app.evaluate, app.send, '即时保存占位')
    const afterImmediateSaveDelete = afterImmediateSourceDelete.replace('即时保存占位', '')
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'immediate-save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'immediate save stayed paused after final backspace')
    assert.equal(await readFile(file, 'utf8'), afterImmediateSaveDelete, 'immediate save retained the deleted raw backtick')

    await typeAndDeleteBackticks(app.evaluate, app.send, '单反引号占位', 1, '单反引号删除完成')
    await typeAndDeleteBackticks(app.evaluate, app.send, '三反引号占位', 3, '三反引号删除完成')
    await typeAndDeleteBackticks(app.evaluate, app.send, '反复围栏占位', 3, '反复围栏删除完成', 2)
    await typeUndoAndDeleteFence(app.evaluate, app.send)
    await typeOneThenTripleAndDelete(app.evaluate, app.send, '单加三保留单个占位', 3)
    await typeOneThenTripleAndDelete(
      app.evaluate,
      app.send,
      '单加三全部删除占位',
      4,
      '单加三全部删除完成',
      true
    )

    // Save first: the reported failure surfaced here before source mode became
    // unopenable. A successful save must clear the dirty button and write the
    // exact current rich document without a sticky source-sync warning.
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save stayed paused after backtick deletion')
      .catch(async (error) => {
        const diagnostics = await app.evaluate(`(() => ({
          rich: [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.innerHTML,
          toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent),
          log: window.__hmPreserveLog
        }))()`)
        console.error('save diagnostics:', JSON.stringify(diagnostics, null, 2))
        throw error
      })
    const firstSaved = await readFile(file, 'utf8')
    if (firstSaved !== expected) {
      const evidence = await app.evaluate(`({
        preservation: window.__hmPreserveLog || [],
        mapped: window.__hmSourceTransactionLog || [],
        transactions: window.__hmSourceTransactionTrace || []
      })`)
      console.error('first-save preservation tail:', JSON.stringify(evidence.preservation.slice(-40), null, 2))
      if (process.env.TRANSACTION_TRACE === '1') {
        console.error('TRANSACTION_TRACE', JSON.stringify(evidence, null, 2))
      }
    }
    assert.equal(firstSaved, expected, 'first save retained deleted backticks or stale rich text')
    const syncWarning = await app.evaluate(`([...document.querySelectorAll('[class*="toast"]')]
      .some((node) => /保存已暂停|Save paused/.test(node.textContent || '')))`) 
    assert.equal(syncWarning, false, 'save displayed the source-sync fail-closed warning')

    await assertSourceOpened(app, 'first source switch')
    assert.equal(await toggleSource(app.evaluate), true, 'could not return to rich mode')
    await assertSourceOpened(app, 'second source switch')
    assert.equal(await toggleSource(app.evaluate), true, 'could not return to rich before save')

    // Make one more ordinary rich edit after the mode round-trip, then save
    // again to prove the editor did not only recover once.
    await clickTextEnd(app.evaluate, app.send, '后文保留')
    await typeTextLikeUser(app.send, 'X', { delayMs: keyDelay })
    const expectedAfterSecondSave = expected.replace('后文保留', '后文保留X')
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'second save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'second save stayed paused')
    assert.equal(await readFile(file, 'utf8'), expectedAfterSecondSave, 'second save lost the post-recovery edit')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1, true)
    assert.equal(await toggleSource(app.evaluate), true, 'could not inspect reopened source')
    const reopenedSource = await waitFor(() => visibleSource(app.evaluate), 'reopened source did not appear')
    assert.equal(reopenedSource, expectedAfterSecondSave, 'full reopen changed the saved backtick transaction')

    console.log('PASS backtick deletion sync: single/triple/repeated backticks can be deleted, switched, saved, and reopened')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
