// MacBook Air 0.13.244 trace (2026-10-12): in a document typed from scratch
// (generated-scratch path — the serializer output is the source) a hard break
// at the very start or end of a paragraph/heading paused every later edit.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const visiblePm = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`
const shiftEnter = { key: 'Enter', text: '\r', modifiers: 8 }
const cases = [
  {
    name: 'paragraph start',
    build: [['type', '标题'], ['enter'], ['type', '价格优势：'], ['enter'], ['type', '尾']],
    edit: [['click', ['价格优势', 0]], ['key', shiftEnter], ['click', ['尾', 1]], ['type', 'X']],
    // A leading plain newline is one more blank line (Typora writes the same).
    expected: '# 标题\n\n\n价格优势：\n\n尾X\n'
  },
  {
    name: 'heading start',
    build: [['type', '标题'], ['enter'], ['type', '### 还没上'], ['enter'], ['type', '尾']],
    edit: [['click', ['还没上', 0]], ['key', shiftEnter], ['click', ['尾', 1]], ['type', 'X']],
    // Shift+Enter in a heading is Enter (Typora): an empty paragraph above.
    expected: '# 标题\n\n\n\n### 还没上\n\n尾X\n'
  },
  {
    name: 'paragraph end after deleting the second line',
    build: [['type', '标题'], ['enter'], ['type', '第一行'], ['key', shiftEnter], ['type', '第二行'], ['enter'], ['type', '尾']],
    edit: [['click', ['第二行', 3]], ['backspace', 3], ['click', ['尾', 1]], ['type', 'X']],
    expected: '# 标题\n\n第一行\n\n尾X\n'
  }
]
const waitFor = async (check, message, attempts = 80) => {
  for (let index = 0; index < attempts; index += 1) { const value = await check(); if (value) return value; await sleep(100) }
  throw new Error(message)
}
const root = await mkdtemp(join(tmpdir(), 'horsemd-edge-break-scratch-'))
let failures = 0
for (const [index, testCase] of cases.entries()) {
  const file = join(root, `scratch-${index}.md`)
  await writeFile(file, '')
  const app = await launchBuiltElectron({
    profileDir: join(root, `profile-${index}`), cleanProfile: false,
    port: 29900 + index + process.pid % 50, appArgs: [file, '--horsemd-input-trace']
  })
  const clickText = async (text, offset) => {
    const point = await app.evaluate(`((text, offset) => {
      const walker = document.createTreeWalker(${visiblePm}, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode
        const at = node.nodeValue.indexOf(text)
        if (at < 0) continue
        const range = document.createRange(); range.setStart(node, at + offset); range.collapse(true)
        const rect = range.getClientRects()[0] || node.parentElement.getBoundingClientRect()
        return { x: Math.round(rect.left + 1), y: Math.round(rect.top + rect.height / 2) }
      }
      return null
    })(${JSON.stringify(text)}, ${offset})`)
    assert.ok(point, `text not found: ${text}`)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await sleep(150)
  }
  const run = async (actions) => {
    for (const [action, value] of actions) {
      if (action === 'type') await typeTextLikeUser(app.send, value, { delayMs: 40 })
      if (action === 'enter') await pressKey(app.send, { key: 'Enter', text: '\r' })
      if (action === 'key') await pressKey(app.send, value)
      if (action === 'click') await clickText(...value)
      if (action === 'backspace') for (let count = 0; count < value; count += 1) await pressKey(app.send, { key: 'Backspace' })
      await sleep(250)
    }
  }
  try {
    await waitFor(() => app.evaluate(`Boolean(${visiblePm})`), 'editor did not mount')
    await sleep(1200)
    await app.evaluate(`(() => {
      window.__toasts = []
      const seen = new WeakSet()
      new MutationObserver(() => {
        for (const node of document.querySelectorAll('.hm-toast-msg')) if (!seen.has(node)) { seen.add(node); window.__toasts.push(node.textContent) }
      }).observe(document.body, { childList: true, subtree: true });
      (${visiblePm}).focus()
    })()`)
    await run(testCase.build)
    await sleep(600)
    await run(testCase.edit)
    await sleep(1200)
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button not shown')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(async () => (await readFile(file, 'utf8')) === testCase.expected, `saved bytes differ: ${JSON.stringify(await readFile(file, 'utf8'))}`, 40)
    const toasts = await app.evaluate('window.__toasts.slice()')
    assert.equal(toasts.some((text) => warningPattern.test(text)), false, `warning: ${JSON.stringify(toasts)}`)
    assert.deepEqual(await app.evaluate('(globalThis.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).map(e => e.preservationReason)'), [])
    console.log(`ok   scratch: ${testCase.name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL scratch: ${testCase.name}: ${String(error?.message || error).slice(0, 500)}`)
    console.log('     state:', JSON.stringify(await app.evaluate(`({
      toasts: window.__toasts, fab: !!document.querySelector('.hm-save-fab'),
      doc: JSON.stringify(${visiblePm}.pmViewDesc.node.toJSON()).slice(0, 600),
      coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-4).map(e => [e.phase, e.owner, e.reason].join('/')),
      integrity: (window.__hmSourceIntegrityTrace || []).slice(-3).map(e => [e.ok, e.validationSite, e.preservationReason, JSON.stringify(e.candidate)].join('|'))
    })`)).slice(0, 1800))
    console.log('     bad:', JSON.stringify(await app.evaluate(`(globalThis.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).slice(-1).map(e => ({ reason: e.preservationReason, site: e.validationSite, candidate: e.candidate }))`)).slice(0, 500))
  } finally {
    await stopBuiltElectron(app)
  }
}
console.log(failures ? `FAIL edge hard break (scratch): ${failures}/${cases.length} failed` : `PASS edge hard break (scratch): ${cases.length} typed-from-scratch documents keep editing and save clean bytes after a start/end hard break`)
process.exit(failures ? 1 : 0)
