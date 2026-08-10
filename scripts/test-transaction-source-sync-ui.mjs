import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-transaction-source-sync-${process.pid}`
const file = join(root, 'transaction-source.md')
const port = Number(process.env.CDP_PORT || 10134)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const lineEnding = process.env.TRANSACTION_CRLF === '1' ? '\r\n' : '\n'
const bom = process.env.TRANSACTION_BOM === '1' ? '\uFEFF' : ''

const authored = bom + ['# 事务同步', '', '正文', '', '> 引用', '', '- 项目', ''].join(lineEnding)
const expected = bom + ['# 事务同步', '', '正文追加undo', '', '> 引用改', '', '- 项新项', ''].join(lineEnding)
// HTMLTextAreaElement exposes normalized LF values even when the backing
// source snapshot and disk bytes remain CRLF. Disk assertions below prove the
// authored line-ending convention survives the rich edit.
const expectedSourceView = expected.replaceAll('\r\n', '\n')

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

async function clickTextEnd(evaluate, send, selector, text) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = [...(editor?.querySelectorAll(${JSON.stringify(selector)}) || [])]
      .find((candidate) => candidate.textContent === ${JSON.stringify(text)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: Math.max(rect.left + 4, rect.right - 2), y: rect.top + rect.height / 2 }
  })()`)
  assert.ok(point, `missing rich block: ${text}`)
  await click(send, point)
  await pressKey(send, { key: 'End', code: 'End', delayMs: 25 })
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(
    () => app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return editor?.textContent.includes('事务同步')
    })()`),
    'transaction fixture did not mount'
  )
  await sleep(350)
  return app
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
      window.__hmSourceTransactionLog = []
      window.__hmSourceTransactionTrace = []
      window.__hmPreserveLog = []
      window.__hmTransactionSourcePrimary = true
    })()`)

    await clickTextEnd(evaluate, send, 'p', '正文')
    await typeTextLikeUser(send, '追加', { delayMs: 35 })

    await clickTextEnd(evaluate, send, 'blockquote p', '引用')
    await typeTextLikeUser(send, '改', { delayMs: 35 })

    await clickTextEnd(evaluate, send, 'li p', '项目')
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 35 })
    await typeTextLikeUser(send, '新项', { delayMs: 35 })

    // Undo/redo is a real ProseMirror transaction family, not a cache rewind.
    // It must update the same source bytes and preserve the document EOL style.
    await clickTextEnd(evaluate, send, 'p', '正文追加')
    await typeTextLikeUser(send, 'undo', { delayMs: 35 })
    await pressKey(send, { key: 'z', code: 'KeyZ', modifiers: 4, delayMs: 35 })
    await pressKey(send, { key: 'z', code: 'KeyZ', modifiers: 12, delayMs: 35 })

    assert.equal(await toggleSource(evaluate), true, 'could not switch to source mode')
    const source = await waitFor(
      () => evaluate(`([...document.querySelectorAll('textarea.source-editor')]
        .find((node) => node.offsetParent)?.value ?? null)`),
      'source textarea did not appear'
    ).catch(async (error) => {
      console.error('source-open diagnostics', JSON.stringify(await evaluate(`({
        transaction: window.__hmSourceTransactionLog || [],
        preservation: window.__hmPreserveLog || [],
        toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent),
        rich: [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent || ''
      })`), null, 2))
      throw error
    })
    const evidence = await evaluate(`({
      transaction: window.__hmSourceTransactionLog || [],
      trace: window.__hmSourceTransactionTrace || [],
      semantic: window.__hmSourceTransactionSemantic || null,
      preservation: window.__hmPreserveLog || [],
      richText: [...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent)?.textContent || ''
    })`)
    if (source !== expectedSourceView) {
      console.error('transaction source mismatch', JSON.stringify({ source, expectedSourceView, evidence }, null, 2))
    }
    assert.equal(source, expectedSourceView, 'transaction-mapped source differs from authored expectation')
    assert.ok(
      evidence.transaction.filter((entry) => entry.ok && entry.reason === 'plain-text-transactions').length >= 6,
      `plain-text transactions were not the active path: ${JSON.stringify(evidence)}`
    )
    assert.equal(
      evidence.preservation.length,
      0,
      `ordinary text edits unexpectedly fell back to canonical preservation: ${JSON.stringify(evidence.preservation)}`
    )

    assert.equal(await toggleSource(evaluate), true, 'could not return to rich mode')
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    assert.equal(await readFile(file, 'utf8'), expected, 'disk source differs after transaction-first save')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    assert.equal(await toggleSource(app.evaluate), true, 'could not inspect source after reopen')
    const reopened = await waitFor(
      () => app.evaluate(`([...document.querySelectorAll('textarea.source-editor')]
        .find((node) => node.offsetParent)?.value ?? null)`),
      'reopened source textarea did not appear'
    )
    assert.equal(reopened, expectedSourceView, 'transaction source did not survive cold reopen')
    assert.equal(await readFile(file, 'utf8'), expected, 'cold reopen normalized the authored disk line endings')

    console.log(`PASS transaction-first source sync (${bom ? 'BOM+' : ''}${lineEnding === '\r\n' ? 'CRLF' : 'LF'}): paragraph/quote/list/undo-redo edits persist exactly`)
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
