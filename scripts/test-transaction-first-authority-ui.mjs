import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-transaction-first-authority-${process.pid}`
const file = join(root, 'authority.md')
const port = Number(process.env.CDP_PORT || 10182)
const authored = '# Authority\n\nalpha\n\nbeta\n\ngamma\n\ndelta\n\nsplitme\n\n- item\n'
const expected = '# Authority\n\nalphaX\n\nbeta\\*\n\ngamm\n\ndZZta\n\nspl\n\nitme\n\nitem\n'

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

async function clickTextEnd(evaluate, send, text) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    const node = [...(editor?.querySelectorAll('p') || [])]
      .find((candidate) => candidate.textContent === ${JSON.stringify(text)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return {
      x: Math.max(rect.left + 4, rect.right - 2),
      y: rect.top + rect.height / 2
    }
  })()`)
  assert.ok(point, `missing paragraph: ${text}`)
  await click(send, point)
  await pressKey(send, { key: 'End', code: 'End', delayMs: 25 })
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const authorityTrace = (evaluate) => evaluate(`window.__hmTransactionFirstTrace || []`)

const pauseToasts = (evaluate) => evaluate(`
  [...document.querySelectorAll('[class*="toast"]')]
    .map((node) => node.textContent || '')
    .filter((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text))
`)

async function waitForOwned(evaluate, label) {
  return waitFor(async () => {
    const trace = await authorityTrace(evaluate)
    return trace.find((entry) =>
      entry.phase === 'reconcile' &&
      entry.publicationOwner === 'transaction' &&
      entry.authorityDecision === 'authority-owned'
    ) || null
  }, `${label} did not publish through transaction-first authority`)
}

async function waitForLegacyFallback(evaluate, label) {
  return waitFor(async () => {
    const trace = await authorityTrace(evaluate)
    return trace.find((entry) =>
      entry.phase === 'reconcile' &&
      entry.publicationOwner === 'legacy' &&
      entry.authorityDecision !== 'authority-owned'
    ) || null
  }, `${label} did not remain on legacy fallback`)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, authored)

  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'),
      port,
      appArgs: [file]
    })
    const { evaluate, send } = app
    await waitFor(
      () => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')]
          .find((node) => node.offsetParent)
        return editor?.textContent.includes('alpha') && editor?.textContent.includes('beta')
      })()`),
      'authority fixture did not mount'
    )
    await sleep(350)

    await evaluate(`(() => {
      window.__hmTransactionSourcePrimary = false
      window.__hmTransactionSourceShadow = false
      window.__hmTransactionFirstAuthority = true
      window.__hmTransactionFirstTrace = []
      window.__hmSourceSyncCoordinatorTrace = []
    })()`)

    await clickTextEnd(evaluate, send, 'alpha')
    await typeTextLikeUser(send, 'X', { delayMs: 40 })
    const insertTrace = await waitForOwned(evaluate, 'plain insertion')
    assert.equal(insertTrace.transactionFamily, 'plain-paragraph-inline-replace')
    assert.equal(insertTrace.mode, 'authoritative')
    assert.equal(insertTrace.comparison, 'legacy-unavailable')
    assert.equal(insertTrace.promotionEligible, false, 'authority must not wait for legacy byte-equal evidence')
    assert.deepEqual(insertTrace.stepNames, ['ReplaceStep'])
    const coordinatorInsert = await waitFor(async () => {
      const trace = await evaluate(`window.__hmSourceSyncCoordinatorTrace || []`)
      return trace.find((entry) =>
        entry.phase === 'published' &&
        entry.boundary === 'transaction-first-early-authority' &&
        entry.owner === 'transaction' &&
        entry.family === 'plain-paragraph-inline-replace' &&
        entry.reason === 'plain-text-transactions'
      ) || null
    }, 'plain insertion bypassed SourceSyncCoordinator transaction publication')
    assert.ok(coordinatorInsert.revision >= 1)
    assert.equal(await pauseToasts(evaluate).then((items) => items.length), 0)

    await evaluate(`window.__hmTransactionFirstTrace = []`)
    await clickTextEnd(evaluate, send, 'beta')
    await typeTextLikeUser(send, '*', { delayMs: 40 })
    const syntaxTrace = await waitForLegacyFallback(evaluate, 'Markdown-sensitive insertion')
    assert.equal(syntaxTrace.transactionReason, 'syntax-sensitive-insert')
    assert.equal(syntaxTrace.publicationOwner, 'legacy')
    assert.equal(syntaxTrace.authorityEligible, false)
    assert.equal(await pauseToasts(evaluate).then((items) => items.length), 0)

    await evaluate(`window.__hmTransactionFirstTrace = []`)
    await clickTextEnd(evaluate, send, 'gamma')
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 40 })
    const deleteTrace = await waitForOwned(evaluate, 'plain deletion')
    assert.equal(deleteTrace.transactionFamily, 'plain-paragraph-inline-replace')
    assert.equal(deleteTrace.publicationOwner, 'transaction')

    await evaluate(`window.__hmTransactionFirstTrace = []`)
    await clickTextEnd(evaluate, send, 'delta')
    await pressKey(send, { key: 'Home', code: 'Home', delayMs: 25 })
    await pressKey(send, { key: 'ArrowRight', code: 'ArrowRight', delayMs: 25 })
    await pressKey(send, { key: 'ArrowRight', code: 'ArrowRight', modifiers: 8, delayMs: 25 })
    await pressKey(send, { key: 'ArrowRight', code: 'ArrowRight', modifiers: 8, delayMs: 25 })
    await typeTextLikeUser(send, 'ZZ', { delayMs: 40 })
    const replaceTrace = await waitForOwned(evaluate, 'rapid same-paragraph replacement')
    assert.ok(replaceTrace.chainLength >= 2, `rapid replacement chain missing: ${JSON.stringify(replaceTrace)}`)
    assert.equal(replaceTrace.publicationOwner, 'transaction')

    await evaluate(`window.__hmTransactionFirstTrace = []`)
    await clickTextEnd(evaluate, send, 'splitme')
    await pressKey(send, { key: 'Home', code: 'Home', delayMs: 25 })
    await pressKey(send, { key: 'ArrowRight', code: 'ArrowRight', delayMs: 25 })
    await pressKey(send, { key: 'ArrowRight', code: 'ArrowRight', delayMs: 25 })
    await pressKey(send, { key: 'ArrowRight', code: 'ArrowRight', delayMs: 25 })
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 40 })
    const splitTrace = await waitForLegacyFallback(evaluate, 'paragraph split')
    assert.equal(splitTrace.transactionReason, 'phase1-structural-slice')
    assert.equal(splitTrace.transactionFamily, null)
    assert.equal(splitTrace.publicationOwner, 'legacy')
    assert.equal(await pauseToasts(evaluate).then((items) => items.length), 0)

    await evaluate(`window.__hmTransactionFirstTrace = []`)
    await clickTextEnd(evaluate, send, 'item')
    await pressKey(send, { key: 'Home', code: 'Home', delayMs: 25 })
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 40 })
    const listTrace = await waitForLegacyFallback(evaluate, 'list Backspace')
    assert.notEqual(listTrace.transactionReason, 'plain-text-transactions')
    assert.equal(listTrace.publicationOwner, 'legacy')
    assert.equal(await pauseToasts(evaluate).then((items) => items.length), 0)

    assert.equal(await toggleSource(evaluate), true, 'could not switch to source mode')
    const source = await waitFor(
      () => evaluate(`([...document.querySelectorAll('textarea.source-editor')]
        .find((node) => node.offsetParent)?.value ?? null)`),
      'source textarea did not appear'
    )
    assert.equal(source, expected, 'authority rollout changed or lost final source bytes')

    console.log('PASS transaction-first authority UI: plain insert/delete/replace publish transaction bytes; syntax/split/list fall back to legacy')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
