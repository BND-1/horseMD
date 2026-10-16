import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-fast-nested-ordered-exit-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 10980 + (process.pid % 40))

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
  await sleep(55)
}

const focusParagraphEnd = async (app, anchorText) => {
  const ok = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    editor.focus()
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.textContent !== ${JSON.stringify(anchorText)}) continue
      const range = document.createRange()
      range.setStart(node, node.textContent.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
    return false
  })()`)
  assert.equal(ok, true, `could not focus paragraph ${anchorText}`)
  await sleep(180)
}

const diagnostics = (app) => app.evaluate(`(() => {
  const focus = (value) => {
    const text = String(value || '')
    const at = text.indexOf('二哥你来拿如果')
    return at >= 0 ? text.slice(Math.max(0, at - 100), at + 260) : text.slice(0, 360)
  }
  return {
    preserve: (window.__hmPreserveLog || []).slice(-16).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      markdown: focus(markdown)
    })),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-12).map(({ candidate, canonical, parsed, expected, ...entry }) => ({
      ...entry,
      candidate: focus(candidate),
      canonical: focus(canonical),
      parsed,
      expected
    })),
    semanticDiff: (window.__hmSourceIntegrityDiffTrace || []).slice(-12),
    toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
  }
})()`)

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

const fixture = [
  '# 测试', '',
  '1', '',
  '-   1. 二哥你来拿如果',
  '  - \u200B     就了解了呢',
  '  * 如果可能老顾客', '',
  '后文', ''
].join('\n')

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
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
    window.__hmSourceIntegrityDiffTrace = []
  })()`)

  await focusParagraphEnd(app, '二哥你来拿如果')
  // Intentionally do not wait for markdownUpdated between these Enters. This
  // reproduces the real callback where both ProseMirror structural transactions
  // are observed as one zero-visible canonical list change.
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  await sleep(1200)

  const before = await diagnostics(app)
  console.log('FAST_NESTED_EXIT_AFTER_INPUT:', JSON.stringify({
    reasons: before.preserve.map(({ reason, preserved }) => ({ reason, preserved })),
    integrity: before.integrity,
    semanticDiff: before.semanticDiff,
    toasts: before.toasts
  }))
  assert.equal(
    before.integrity.some((entry) => entry.ok === false),
    false,
    'rapid nested-list exit produced an integrity failure'
  )
  assert.equal(
    before.toasts.some((text) => /检测到富文本与源码不一致|保存已暂停|无法安全映射|Save paused/.test(text)),
    false,
    'rapid nested-list exit showed a source-sync warning'
  )
  assert.ok(
    before.preserve.some((entry) => entry.reason === 'diverged-nested-list-change' && entry.preserved),
    'rapid nested-list exit did not use the diverged nested-list mapper'
  )

  assert.equal(await toggleSource(app), true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open')
  console.log('FAST_NESTED_EXIT_SOURCE:', JSON.stringify(source))
  assert.ok(
    source.includes('-   1. 二哥你来拿如果\n- \n- \u200B     就了解了呢\n* 如果可能老顾客'),
    'source did not insert the outer empty bullet and promote the unchanged sentinel siblings to top-level'
  )
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'editor placeholder leaked into authored source')
  console.log('PASS rapid nested ordered exit: batched double-Enter stays source-equivalent')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
