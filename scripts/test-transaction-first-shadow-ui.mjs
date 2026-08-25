import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-transaction-first-shadow-${process.pid}`
const file = join(root, 'shadow.md')
const port = Number(process.env.CDP_PORT || 10172)
const authored = '# Shadow\n\nalpha\n\nbeta\n'
const expected = '# Shadow\n\nalphaX\n\nbeta\\*\n'

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

const shadowTrace = (evaluate) => evaluate(`window.__hmTransactionFirstTrace || []`)

const pauseToasts = (evaluate) => evaluate(`
  [...document.querySelectorAll('[class*="toast"]')]
    .map((node) => node.textContent || '')
    .filter((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text))
`)

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
      'shadow fixture did not mount'
    )
    await sleep(350)

    await evaluate(`(() => {
      window.__hmTransactionSourcePrimary = false
      window.__hmTransactionSourceShadow = true
      window.__hmTransactionFirstTrace = []
    })()`)

    await clickTextEnd(evaluate, send, 'alpha')
    await typeTextLikeUser(send, 'X', { delayMs: 40 })

    const ownedTrace = await waitFor(async () => {
      const trace = await shadowTrace(evaluate)
      return trace.find((entry) =>
        entry.phase === 'reconcile' &&
        entry.ownership === 'owned' &&
        entry.comparison === 'byte-equal'
      ) || null
    }, 'plain paragraph edit did not produce byte-equal shadow evidence')

    assert.equal(ownedTrace.publicationOwner, 'legacy', 'Phase 0 shadow must publish legacy bytes')
    assert.equal(ownedTrace.promotionEligible, true, 'byte-equal plain text should be promotion evidence')
    assert.deepEqual(ownedTrace.stepNames, ['ReplaceStep'])
    assert.ok(ownedTrace.sourceMapEntries >= 2, 'plain paragraphs should be covered by the SourceRangeMap')
    assert.equal(await pauseToasts(evaluate).then((items) => items.length), 0, 'shadow evidence must not show a sync warning')

    await evaluate(`window.__hmTransactionFirstTrace = []`)
    await clickTextEnd(evaluate, send, 'beta')
    await typeTextLikeUser(send, '*', { delayMs: 40 })

    const rejectedTrace = await waitFor(async () => {
      const trace = await shadowTrace(evaluate)
      return trace.find((entry) =>
        entry.phase === 'reconcile' &&
        entry.comparison === 'transaction-rejected'
      ) || null
    }, 'Markdown-sensitive edit did not remain transaction-rejected')

    assert.equal(rejectedTrace.transactionReason, 'syntax-sensitive-insert')
    assert.equal(rejectedTrace.publicationOwner, 'legacy', 'rejected shadow edit must stay on legacy publication')
    assert.equal(rejectedTrace.promotionEligible, false)
    assert.equal(await pauseToasts(evaluate).then((items) => items.length), 0, 'unsupported shadow edit must not show a sync warning')

    assert.equal(await toggleSource(evaluate), true, 'could not switch to source mode')
    const source = await waitFor(
      () => evaluate(`([...document.querySelectorAll('textarea.source-editor')]
        .find((node) => node.offsetParent)?.value ?? null)`),
      'source textarea did not appear'
    )
    assert.equal(source, expected, 'shadow rollout changed or lost the legacy-published source')

    console.log('PASS transaction-first shadow UI: plain ReplaceStep is byte-equal, Markdown syntax rejects, legacy remains publisher')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
