import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-empty-ordered-backspace-lift-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 11040 + (process.pid % 40))

const waitFor = async (check, message, attempts = 160) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const rawKey = async (send, key, code, keyCode) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(80)
}

const focusLastEmptyOrderedBefore = async (app, anchorText) => {
  const info = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return { ok: false, reason: 'no-editor' }
    const orderedLists = [...editor.querySelectorAll('ol')]
    for (const list of orderedLists) {
      const items = [...list.querySelectorAll(':scope > .milkdown-list-item-block > li')]
      const anchorIndex = items.findIndex((item) => (item.textContent || '').includes(${JSON.stringify(anchorText)}))
      if (anchorIndex <= 0) continue
      let target = null
      for (let index = anchorIndex - 1; index >= 0; index -= 1) {
        const item = items[index]
        const directParagraph = item.querySelector(':scope > .children > .content-dom > p')
        const text = (directParagraph?.textContent || '').replace(/\\u200B/g, '').trim()
        if (!text) {
          target = directParagraph || item
          break
        }
      }
      if (!target) continue
      editor.focus()
      const range = document.createRange()
      range.setStart(target, 0)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return {
        ok: true,
        itemCount: items.length,
        texts: items.map((item) => (item.textContent || '').replace(/\\u200B/g, '')),
        targetHtml: target.outerHTML
      }
    }
    return { ok: false, reason: 'target-not-found', html: editor.innerHTML.slice(0, 2200) }
  })()`)
  assert.equal(info.ok, true, `could not focus empty ordered item before ${anchorText}: ${JSON.stringify(info)}`)
  await sleep(220)
  return info
}

const diagnostics = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
    ...entry,
    markdown: String(markdown || '').slice(0, 420)
  })),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-12).map(({ candidate, canonical, parsed, expected, ...entry }) => ({
    ...entry,
    candidate: String(candidate || '').slice(0, 500),
    canonical: String(canonical || '').slice(0, 500)
  })),
  semanticDiff: (window.__hmSourceIntegrityDiffTrace || []).slice(-12),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
}))()`)

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

// The first list reproduces the 0.13.78 Backspace failure. The later authored
// nested list intentionally keeps source spelling that differs from Crepe's
// canonical serializer, forcing the same diverged-source preservation path as
// the real document instead of the simpler list-line mapper.
const fixture = [
  '# 删除回归', '',
  '2. ',
  '3. ',
  '4. 你离开你',
  '5. 斛律v哦', '', '', '',
  '- u高科技', '',
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
    () => app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return editor?.textContent?.includes('你离开你') || false
    })()`),
    'explicit Backspace fixture did not replace the startup document'
  )
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)

  const focused = await focusLastEmptyOrderedBefore(app, '你离开你')
  console.log('EMPTY_ORDERED_BACKSPACE_FOCUS:', JSON.stringify(focused))
  await rawKey(app.send, 'Backspace', 'Backspace', 8)
  await sleep(1200)

  const before = await diagnostics(app)
  console.log('EMPTY_ORDERED_BACKSPACE_AFTER_INPUT:', JSON.stringify({
    reasons: before.preserve.map(({ reason, preserved }) => ({ reason, preserved })),
    integrity: before.integrity,
    semanticDiff: before.semanticDiff,
    toasts: before.toasts
  }))
  assert.equal(
    before.integrity.some((entry) => entry.ok === false),
    false,
    'first Backspace on the empty ordered item produced an integrity failure'
  )
  assert.equal(
    before.toasts.some((text) => /检测到富文本与源码不一致|保存已暂停|无法安全映射|Save paused/.test(text)),
    false,
    'first Backspace on the empty ordered item showed a source-sync warning'
  )
  assert.ok(
    before.preserve.some((entry) => entry.reason === 'diverged-empty-ordered-backspace-lift' && entry.preserved),
    'first Backspace did not use the transient empty-ordered lift mapper'
  )

  assert.equal(await toggleSource(app), true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open')
  console.log('EMPTY_ORDERED_BACKSPACE_SOURCE:', JSON.stringify(source))
  assert.match(source, /(?:^|\n)2\. \n3\. 你离开你\n4\. 斛律v哦(?:\n|$)/, 'empty ordered item was not removed and suffix renumbered')
  assert.doesNotMatch(source, /(?:^|\n)3\. \n/, 'deleted empty ordered marker remained in source')
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'Crepe empty-paragraph placeholder leaked into authored source')
  assert.ok(
    source.includes('-   1. 二哥你来拿如果\n  - \u200B     就了解了呢\n  * 如果可能老顾客'),
    'unrelated diverged nested-list source spelling changed'
  )
  console.log('PASS empty ordered Backspace lift: first deletion stays source-equivalent')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
