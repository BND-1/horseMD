// Review markup (CriticMarkup) as written in a file: opening it used to
// rewrite the markers before parsing (normalizeReviewMarkupMarkdown:
// `{== a ==}` → ` {==a==} `, `{\~\~a\~>b\~\~}` unescaped, also inside code),
// so the editor held a document the source did not parse to and the first
// sync after a click rewrote lines the user never touched — dirty with no
// edit (same family as the one-line `$$` fix). Locked: a click + source
// switch changes nothing, an edit elsewhere leaves the review line's bytes,
// the highlight still renders.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { pressKey } from './lib/human-input.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-review-open-'))

async function session(name, content, run) {
  const file = join(root, `${name}.md`)
  await fs.writeFile(file, content)
  const app = await launchBuiltElectron({ profileDir: join(root, `profile-${name}`), port: 9700 + Math.floor(Math.random() * 200), appArgs: [file, '--horsemd-input-trace'] })
  const evaluate = (expression) => app.evaluate(expression)
  try {
    for (let i = 0; i < 80; i += 1) {
      if (await evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)?.pmViewDesc)`)) break
      await sleep(150)
    }
    await sleep(600)
    await evaluate(`(() => { window.__toasts = []; const seen = new WeakSet(); new MutationObserver(() => { for (const n of document.querySelectorAll('.hm-toast-msg')) { if (!seen.has(n)) { seen.add(n); window.__toasts.push(n.textContent) } } }).observe(document.body, { childList: true, subtree: true }) })()`)
    const h = {
      app,
      evaluate,
      key: (key, extra = {}) => pressKey(app.send, { key, ...extra }),
      // Real key presses (keyDown with the character): CodeMirror's input
      // handlers (bracket closing) see what a keyboard sends.
      type: async (text, gap = 20) => {
        for (const ch of [...text]) {
          const vk = ch.toUpperCase().charCodeAt(0)
          await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
          await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
          await sleep(gap)
        }
      },
      click: async ({ x, y }) => {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
        await sleep(150)
      },
      endOfText: (text) => evaluate(`((text) => {
        const pm = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
        const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const node = walker.currentNode
          const at = node.nodeValue.indexOf(text)
          if (at < 0) continue
          const range = document.createRange(); range.setStart(node, at + text.length); range.collapse(true)
          const rect = range.getClientRects()[0] || node.parentElement.getBoundingClientRect()
          return { x: Math.round(rect.right + 1), y: Math.round(rect.top + rect.height / 2) }
        }
        return null
      })(${JSON.stringify(text)})`),
      toasts: () => evaluate('window.__toasts.slice()'),
      source: async () => {
        const toggle = () => evaluate(`[...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && /源码|Source/.test(n.title || ''))?.click()`)
        await toggle()
        let value = null
        for (let i = 0; i < 50 && value == null; i += 1) { await sleep(100); value = await evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null`) }
        await toggle()
        for (let i = 0; i < 50; i += 1) { await sleep(100); if (!(await evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent))`))) break }
        return value
      },
      save: async () => {
        await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
        for (let i = 0; i < 80; i += 1) { if (!(await evaluate(`Boolean(document.querySelector('.hm-save-fab'))`))) return; await sleep(100) }
        throw new Error(`${name}: save did not finish: ${JSON.stringify(await evaluate('window.__toasts.slice()'))}`)
      }
    }
    await run(h, file)
  } finally {
    await stopBuiltElectron(app)
  }
}

const dirty = (h) => h.evaluate(`Boolean(document.querySelector('.tab.active .tab-close.dirty'))`)

try {
  const cases = {
    'highlight-edge-spaces': '段落一。\n\nA {== focus ==}{>>why<<} B\n\n段落二。\n',
    'escaped-substitution': '段落一。\n\nx {\\~\\~a\\~>b\\~\\~} y\n\n段落二。\n',
    'separator-escaped': '段落一。\n\nx {~~a\\~>b~~} y\n\n段落二。\n',
    'inside-code': '段落一。\n\n```\n{== a ==}{>>b<<}\n{\\~\\~a\\~>b\\~\\~}\n```\n\n段落二 `{\\~\\~c\\~>d\\~\\~}`。\n',
    'leading-spaces': '段落一。\n\n{==    x==}{>>c<<} 尾\n'
  }
  for (const [name, content] of Object.entries(cases)) {
    await session(name, content, async (h, file) => {
      await h.click(await h.endOfText('段落一'))
      await sleep(800)
      assert.equal(await h.source(), content, `${name}: a click + source switch keeps the authored bytes`)
      assert.equal(await dirty(h), false, `${name}: not dirty`)
      assert.deepEqual(await h.toasts(), [], `${name}: no warning`)
      // An edit elsewhere: only that paragraph changes.
      await h.click(await h.endOfText('段落一'))
      await h.type('Z')
      await sleep(1200)
      assert.equal(await h.source(), content.replace('段落一。', '段落一Z。'), `${name}: an edit elsewhere leaves the review line's bytes`)
      await h.save()
      assert.equal(await fs.readFile(file, 'utf8'), content.replace('段落一。', '段落一Z。'), `${name}: saved bytes`)
      assert.deepEqual((await h.toasts()).filter((t) => !/已保存|Saved/.test(t)), [], `${name}: no warning after the edit`)
    })
  }
  // The highlight still renders from the authored marker.
  await session('render', 'A {== focus ==}{>>why<<} B\n', async (h) => {
    const marks = await h.evaluate(`[...document.querySelectorAll('.hm-review-highlight')].map((n) => n.textContent).join('|')`)
    assert.ok(/focus/.test(marks), `highlight rendered: ${JSON.stringify(marks)}`)
  })
  console.log('PASS review markup open UI: highlight edge spaces, escaped substitutions (full / separator), markers inside code and a leading-space marker open as written — click + source switch keeps the bytes, not dirty, an edit elsewhere and the save change only that paragraph; the highlight renders')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
