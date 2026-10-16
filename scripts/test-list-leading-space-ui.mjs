// Regression: multiple leading spaces typed inside an ordered/bullet list
// item must never leak the serializer's `&#x20;` entity into authored source
// (RS-14 family, list-item variant). The paragraph-level U+200B sentinel
// contract must also apply inside list items.
import assert from 'node:assert/strict'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-leading-space-${process.pid}`
const file = join(root, 'list-space.md')
const port = Number(process.env.CDP_PORT || 9880)
const delay = Number(process.env.KEY_DELAY || 80)
const initial = 'A\n\n1. 测试\n\n- 无序项\n\n1. \n'

async function waitFor(check, message, attempts = 120) {
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

async function clickListItemEnd(evaluate, send, text) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = [...(editor?.querySelectorAll('li p') || [])]
      .find((candidate) => candidate.textContent === ${JSON.stringify(text)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    return { x: Math.max(rect.left + 5, rect.right - 3), y: rect.top + Math.max(3, Math.min(12, rect.height / 2)) }
  })()`)
  assert.ok(point, `missing list item: ${text}`)
  await click(send, point)
  await pressKey(send, { key: 'End', code: 'End', delayMs: 40 })
  await sleep(200)
}

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

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  let app
  if (process.env.FILE) {
    await copyFile(process.env.FILE, file)
  } else {
    await writeFile(file, initial, 'utf8')
  }
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'p'), port, appArgs: [file] })
    const { evaluate, send } = app
    await evaluate(`(() => { window.__hmPreserveLog = [] })()`)
    await waitFor(() => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`), 'editor did not mount')
    await sleep(600)

    if (process.env.FILE) {
      // Diverged-tail scenario on the real user file: empty list item, then
      // leading spaces + text. The appended canonical rows must not leak
      // `&#x20;`.
      await clickListItemEnd(evaluate, send, '')
      for (const key of ['1', '.', ' ']) {
        await send('Input.insertText', { text: key })
        await sleep(delay)
      }
      for (let i = 0; i < 4; i += 1) {
        await send('Input.insertText', { text: ' ' })
        await sleep(delay)
      }
      await typeTextLikeUser(send, '分叉空格', { delayMs: delay })
      await sleep(600)
    } else {
      await clickListItemEnd(evaluate, send, '测试')
      for (let i = 0; i < 4; i += 1) {
        await send('Input.insertText', { text: ' ' })
        await sleep(delay)
      }
      await typeTextLikeUser(send, '新内容', { delayMs: delay })
      await sleep(500)

      await clickListItemEnd(evaluate, send, '')
      for (let i = 0; i < 4; i += 1) {
        await send('Input.insertText', { text: ' ' })
        await sleep(delay)
      }
      await typeTextLikeUser(send, '前置空格', { delayMs: delay })
      await sleep(500)
    }

    assert.equal(await toggleSource(evaluate), true, 'source toggle failed')
    const source = await waitFor(() => visibleSource(evaluate), 'source textarea missing')
    if (source.includes('&#x20;')) {
      const log = await evaluate(`(window.__hmPreserveLog || []).slice(-6).map((entry) => ({
        reason: entry.reason,
        nextTail: entry.next?.slice(-80),
        markdownTail: entry.markdown?.slice(-80)
      }))`)
      console.error('preserve log:', JSON.stringify(log, null, 1))
    }
    const itemLine = source.split('\n').find((line) => line.includes('测试')) || ''
    assert.ok(
      !source.includes('&#x20;'),
      `list-item leading spaces leaked the &#x20; entity: ${JSON.stringify(source)}`
    )
    if (process.env.FILE) {
      assert.ok(
        source.includes('分叉空格'),
        `empty-item leading spaces lost the typed content: ${JSON.stringify(source)}`
      )
    } else {
      assert.ok(
        source.includes('前置空格'),
        `empty-item leading spaces lost the typed content: ${JSON.stringify(source)}`
      )
      assert.ok(
        itemLine.includes('测试') && itemLine.includes('新内容'),
        `list item lost the typed content: ${JSON.stringify(itemLine)}`
      )
    }
    console.log('PASS list leading space: no &#x20; entity, content survived, item line:', JSON.stringify(itemLine))
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
