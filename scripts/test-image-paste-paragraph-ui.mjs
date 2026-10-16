// MacBook Air 0.13.244 trace (2026-10-12, 11 warnings in one minute): an image
// pasted at the end of a text paragraph is an inline image with `title: ''`;
// the parser yields `title: null` for the same Markdown, so every later edit
// failed the document comparison. An empty title is no title.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const root = await mkdtemp(join(tmpdir(), 'horsemd-image-paste-'))
let failures = 0
for (const [index, scratch] of [true, false].entries()) {
  const label = scratch ? 'typed-from-scratch document' : 'saved file'
  const file = join(root, `doc-${index}.md`)
  await writeFile(file, scratch ? '' : '# 标题\n\n第一段文字。例如甲乙丙。\n\n尾段\n')
  const app = await launchBuiltElectron({
    profileDir: join(root, `profile-${index}`), cleanProfile: false,
    port: 29700 + index + process.pid % 50, appArgs: [file, '--horsemd-input-trace']
  })
  const send = app.send.bind(app)
  const waitFor = async (check, message, attempts = 80) => {
    for (let i = 0; i < attempts; i += 1) { const value = await check(); if (value) return value; await sleep(100) }
    throw new Error(message)
  }
  try {
    await waitFor(() => app.evaluate(`Boolean(${editor})`), 'editor did not mount')
    await sleep(1500)
    await app.evaluate(`(() => {
      window.__toasts = []
      const seen = new WeakSet()
      new MutationObserver(() => {
        for (const node of document.querySelectorAll('.hm-toast-msg')) if (!seen.has(node)) { seen.add(node); window.__toasts.push(node.textContent) }
      }).observe(document.body, { childList: true, subtree: true });
      (${editor}).focus()
    })()`)
    if (scratch) {
      await typeTextLikeUser(send, '标题'); await pressKey(send, { key: 'Enter', text: '\r' })
      await typeTextLikeUser(send, '第一段文字。例如甲乙丙。'); await pressKey(send, { key: 'Enter', text: '\r' })
      await typeTextLikeUser(send, '尾段'); await sleep(500)
    }
    const point = await app.evaluate(`(() => {
      const p = [...(${editor}).querySelectorAll('p')].find(n => n.textContent.includes('例如甲乙丙'))
      const r = p.getBoundingClientRect(); return {x:r.right - 2, y:r.top + r.height / 2}
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
    await sleep(200); await pressKey(send, { key: 'End' })
    await app.evaluate(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(png)}), c => c.charCodeAt(0))
      const data = new DataTransfer(); data.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
      ;(document.activeElement || ${editor}).dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    })()`)
    await waitFor(() => app.evaluate(`Boolean((${editor}).querySelector('p img'))`), 'pasted image did not appear in the paragraph')
    await sleep(1500)
    // Delete the sentence before the image (例如甲乙丙。), then keep typing.
    await pressKey(send, { key: 'ArrowLeft' })
    for (let i = 0; i < 6; i += 1) await pressKey(send, { key: 'ArrowLeft', modifiers: 8 })
    await pressKey(send, { key: 'Backspace' }); await sleep(800)
    await typeTextLikeUser(send, '改'); await sleep(1200)
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button not shown')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    const saved = await waitFor(async () => {
      const text = await readFile(file, 'utf8')
      return /改!\[image\.png\]/.test(text) && text
    }, `saved bytes differ: ${JSON.stringify(await readFile(file, 'utf8'))}`, 40)
    assert.match(saved, /^# 标题\n\n第一段文字。例改!\[image\.png\]\([^)\n]+\)\n\n尾段\n$/, `saved: ${JSON.stringify(saved)}`)
    const toasts = await app.evaluate('window.__toasts.slice()')
    assert.equal(toasts.some((text) => warningPattern.test(text)), false, `warning: ${JSON.stringify(toasts)}`)
    assert.deepEqual(await app.evaluate('(globalThis.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).map(e => e.preservationReason)'), [])
    console.log(`ok   image pasted into a paragraph: ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL image pasted into a paragraph: ${label}: ${String(error?.message || error).slice(0, 500)}`)
  } finally {
    await stopBuiltElectron(app)
  }
}
console.log(failures ? `FAIL image paste in paragraph: ${failures}/2 failed` : 'PASS image paste in paragraph: scratch and saved documents keep editing and save after an inline image paste (empty title = no title)')
process.exit(failures ? 1 : 0)
