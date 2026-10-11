// E2E for the cross-fence span owner (P5c, trace-86199 12:37 incident).
// Real gesture replication: select across a fenced code block, Backspace
// (delete span), Cmd+Z (undo restore) — before the owner these left the
// committed source silently desynced (fence survived in the editor but
// vanished from the source baseline). Locked: zero warnings, source bytes
// correct after BOTH directions, save + cold reopen clean.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-cross-fence-${process.pid}`
const file = join(root, 'span.md')
const port = Number(process.env.CDP_PORT || 9880)

const FENCE_BODY = 'Windows 电脑\n  └─ Clash Party / Mihomo\n       ├─ Tokyo-2-Xray'
const SOURCE = [
  '# AWS 部署测试',
  '',
  '**用途**: e2e',
  '',
  '## 1. 推荐架构',
  '',
  '```text',
  FENCE_BODY,
  '```',
  '',
  '### 区域选择',
  '',
  '| 优先级 | 区域 |',
  '|---|---|',
  '| 1 | 东京 |',
  ''
].join('\n')

async function waitFor(check, message, attempts = 120) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function click(send, point, modifiers = 0) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1, modifiers })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1, modifiers })
}

const visible = (evaluate, expr) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
  if (!editor) return null
  return (${expr})
})()`)

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const toastText = (evaluate) => evaluate(`document.querySelector('.hm-toast')?.textContent ?? null`)

const dumpOwnerTrace = async (evaluate, label) => {
  const trace = await evaluate(`(globalThis.__hmCrossFenceSpanTransactionTrace || []).slice(-6)`)
  const preserve = await evaluate(`(globalThis.__hmPreserveLog || []).slice(-4).map((e) => ({ reason: e.reason, preserved: e.preserved }))`)
  console.error(`[owner trace @ ${label}]`, JSON.stringify({ trace, preserve }, null, 1))
}

const lineStartPoint = (evaluate, selector) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
  const node = editor?.querySelector(${JSON.stringify(selector)})
  if (!node) return null
  const rect = node.getBoundingClientRect()
  return { x: rect.left + 2, y: rect.top + rect.height / 2 }
})()`)

let failure = null
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, SOURCE, 'utf8')

  const app = await launchBuiltElectron({
    profileDir: join(root, 'profile'), port,
    appArgs: [file, '--horsemd-input-trace']
  })
  try {
    const { evaluate, send } = app

    await waitFor(() => visible(evaluate, `editor.querySelector('pre, .cm-editor, .milkdown-code-block') ? 'ok' : editor.textContent.includes('Clash Party') ? 'text' : null`), 'editor with code block did not mount')

    // 1) Select from the start of `## 1. 推荐架构` to the start of
    //    `### 区域选择` (spans the whole fence), then Backspace.
    const headingPoint = await waitFor(
      () => lineStartPoint(evaluate, 'h2'),
      'heading for the span start not found'
    )
    await click(send, headingPoint)
    const nextPoint = await waitFor(
      () => lineStartPoint(evaluate, 'h3'),
      'heading for the span end not found'
    )
    await click(send, nextPoint, 8) // shift-click extends the selection
    await waitFor(
      () => evaluate(`(() => {
        const selection = String(window.getSelection?.()?.toString() || '')
        return selection.includes('推荐架构') && selection.includes('Clash Party') ? 'ok' : null
      })()`),
      'cross-fence selection did not extend to the fence body'
    )
    await pressKey(send, { key: 'Backspace' })

    // PM: the fence is gone; no warning toast.
    await waitFor(
      () => visible(evaluate, `!editor.textContent.includes('Clash Party') ? 'ok' : null`),
      'code block was not deleted in the editor'
    )
    await sleep(800)
    if (await toastText(evaluate)) await dumpOwnerTrace(evaluate, 'delete')
    assert.equal(await toastText(evaluate), null, 'warning toast after the delete span')

    // Source: the fence bytes are gone.
    assert.equal(await toggleSource(evaluate), true, 'source toggle missing')
    let source = await waitFor(visibleSource.bind(null, evaluate), 'source textarea did not appear (delete)')
    assert.ok(!source.includes('Clash Party'), `fence survived in source after delete:\n${source.slice(0, 300)}`)
    assert.ok(source.includes('### 区域选择'), 'suffix heading lost from source')
    await toggleSource(evaluate)
    await sleep(400)

    // 2) Undo: the fence comes back. Before the owner this was the silent
    //    desync (editor restored, source baseline did not).
    await pressKey(send, { key: 'z', modifiers: 4 })
    await waitFor(
      () => visible(evaluate, `editor.textContent.includes('Clash Party') ? 'ok' : null`),
      'undo did not restore the code block'
    )
    await sleep(800)
    if (await toastText(evaluate)) await dumpOwnerTrace(evaluate, 'undo')
    assert.equal(await toastText(evaluate), null, 'warning toast after the undo restore')

    assert.equal(await toggleSource(evaluate), true, 'source toggle missing (undo)')
    source = await waitFor(visibleSource.bind(null, evaluate), 'source textarea did not appear (undo)')
    assert.ok(source.includes('```text'), `fence opener missing after undo:\n${source.slice(0, 320)}`)
    assert.ok(source.includes(FENCE_BODY), 'fence body missing after undo')
    assert.ok(source.includes('## 1. 推荐架构'), 'heading missing after undo')
    await toggleSource(evaluate)
    await sleep(400)

    // 3) Save + disk bytes.
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    const disk = await readFile(file, 'utf8')
    assert.ok(disk.includes('```text') && disk.includes(FENCE_BODY), 'disk bytes missing the restored fence')
    assert.equal(disk, SOURCE, `round trip rewrote bytes:\n${disk}`)
    await stopBuiltElectron(app)
  } finally {
    await stopBuiltElectron(app).catch(() => {})
  }

  console.log('\ncross-fence span UI: all checks passed')
} catch (err) {
  failure = err
  console.error('\ncross-fence span UI FAILED:')
  console.error(err)
} finally {
  await rm(root, { recursive: true, force: true })
}
process.exit(failure ? 1 : 0)
