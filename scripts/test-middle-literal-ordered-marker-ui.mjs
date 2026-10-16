import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const sourceFixture = process.env.FILE || '/Users/yangtingyi/vibe_everything/test/无序列表测试.md'
const root = `/tmp/horsemd-middle-literal-ordered-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 10950 + (process.pid % 40))

const waitFor = async (check, message, attempts = 160) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const rawKey = async (send, key, code, keyCode, text = key) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) {
    await send('Input.dispatchKeyEvent', { type: 'char', ...common, text, unmodifiedText: text })
  }
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(100)
}

const placeCaretAfter = async (app, text) => {
  const placed = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.nodeValue !== ${JSON.stringify(text)}) continue
      const range = document.createRange()
      range.setStart(node, node.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
    return false
  })()`)
  assert.equal(placed, true, `could not place caret after ${text}`)
  await sleep(220)
}

const toggleSource = async (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await copyFile(sourceFixture, file)
  const fixtureSource = await readFile(file, 'utf8')
  const anchor = '- 看了呢分\n\n2. 斛律v哦'
  assert.ok(fixtureSource.includes(anchor), 'fixture is missing the real failure anchor')
  await writeFile(file, fixtureSource.replace(anchor, '- 看了呢分\n\n123\n\n2. 斛律v哦'), 'utf8')
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`),
    'editor did not mount'
  )
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
  })()`)

  await placeCaretAfter(app, '123')
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  await rawKey(app.send, '1', 'Digit1', 49)
  await rawKey(app.send, '.', 'Period', 190)
  await sleep(900)

  const diagnostics = await app.evaluate(`(() => {
    const focus = (value) => {
      const text = String(value || '')
      const at = text.indexOf('123')
      return at >= 0 ? text.slice(Math.max(0, at - 80), at + 140) : text.slice(0, 220)
    }
    return {
      preserve: (window.__hmPreserveLog || []).slice(-12).map(({ reason, preserved }) => ({ reason, preserved })),
      integrity: (window.__hmSourceIntegrityTrace || []).slice(-12).map(({ ok, semanticOk, listSlotsMatch, preservationReason, candidate, canonical }) => ({
        ok,
        semanticOk,
        listSlotsMatch,
        preservationReason,
        candidate: focus(candidate),
        canonical: focus(canonical)
      })),
      toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
    }
  })()`)
  console.log('MIDDLE_LITERAL_ORDERED_AFTER_INPUT:', JSON.stringify(diagnostics))

  assert.equal(
    diagnostics.integrity.some((entry) => entry.ok === false),
    false,
    'literal bare ordered marker produced an integrity failure'
  )
  assert.equal(
    diagnostics.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'literal bare ordered marker showed a sync warning'
  )
  assert.equal(await toggleSource(app), true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open')
  const normalized = source.replace(/\r\n/g, '\n')
  assert.ok(
    normalized.includes('123\n\n1\\.\n\n2. 斛律v哦'),
    'source did not preserve the literal `1.` as `1\\.` between 123 and the following ordered item'
  )
  console.log('PASS middle literal ordered marker: `1.` stays escaped and source-equivalent')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
