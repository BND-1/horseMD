// Plain multi-line text (WeChat, Notepad: text/plain only) pastes as one
// paragraph per line (Notion, Feishu, Word, ProseMirror's own text paste).
// Milkdown's clipboard plugin parsed it as Markdown, where a single line
// break stays inside the paragraph: lines typed in WeChat became ONE block,
// so turning "one line" into a heading, or triple-click + bold, took all of
// them (user report 2026-11-15). Text with Markdown structure keeps its
// Markdown meaning; HTML clipboards keep the HTML path.
//
// Each case: a real Ctrl/Cmd+V (system clipboard + webContents.paste()), the
// expected top-level blocks, no mismatch warning, and the source parses to
// the editor's document.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { pressKey } from './lib/human-input.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-plain-paste-'))
const pm = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`

const DOC = ['# 笔记', '', '正文。', '', '| 对比 | 区别 |', '| :--- | :--- |', '| 策略 | 外部选定 |', '', '尾段', ''].join('\n')
const WECHAT = '今天去了超市\n  买了苹果和香蕉  \n\n\n晚上做饭\n记得早点睡\n'

async function session(name, run, doc = DOC) {
  const file = join(root, `${name}.md`)
  await fs.writeFile(file, doc)
  const inspectPort = 9300 + Math.floor(Math.random() * 150)
  const app = await launchBuiltElectron({ profileDir: join(root, `profile-${name}`), port: 9500 + Math.floor(Math.random() * 200), appArgs: [file, '--horsemd-input-trace', `--inspect=${inspectPort}`] })
  const evaluate = (expression) => app.evaluate(expression)
  const mainEval = async (expression) => {
    const [target] = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
    const reply = await new Promise((resolve) => {
      ws.addEventListener('message', (message) => { const data = JSON.parse(message.data); if (data.id === 1) resolve(data) })
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true } }))
    })
    ws.close()
    return reply.result?.result?.value
  }
  // What Ctrl/Cmd+V does: the OS clipboard (only the given flavors), a
  // trusted paste. The previous clipboard text is put back afterwards.
  const systemPaste = async (data) => {
    await mainEval(`(() => { const { clipboard, BrowserWindow } = require('electron'); globalThis.__hmPrevClip ??= clipboard.readText(); clipboard.write(${JSON.stringify(data)}); BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()).webContents.paste(); return true })()`)
    await sleep(500)
  }
  const restoreClipboard = () => mainEval(`(() => { const { clipboard } = require('electron'); if (globalThis.__hmPrevClip != null) clipboard.writeText(globalThis.__hmPrevClip); return true })()`).catch(() => {})
  try {
    for (let i = 0; i < 80; i += 1) {
      if (await evaluate(`Boolean((${pm})?.pmViewDesc) && Boolean(globalThis.__hmSourceReprintHarness)`)) break
      await sleep(150)
    }
    await sleep(600)
    await evaluate(`(() => { window.__toasts = []; const seen = new WeakSet(); new MutationObserver(() => { for (const n of document.querySelectorAll('.hm-toast-msg')) { if (!seen.has(n)) { seen.add(n); window.__toasts.push(n.textContent) } } }).observe(document.body, { childList: true, subtree: true }) })()`)
    const clickEndOf = async (text) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const point = await evaluate(`((text) => {
          const walker = document.createTreeWalker(${pm}, NodeFilter.SHOW_TEXT)
          while (walker.nextNode()) {
            const node = walker.currentNode
            const at = node.nodeValue.indexOf(text)
            if (at < 0) continue
            node.parentElement.scrollIntoView({ block: 'center' })
            const range = document.createRange(); range.setStart(node, at + text.length); range.collapse(true)
            const rect = range.getClientRects()[0] || node.parentElement.getBoundingClientRect()
            return { x: Math.round(rect.right), y: Math.round(rect.top + rect.height / 2) }
          }
          return null
        })(${JSON.stringify(text)})`)
        assert.ok(point, `text on screen: ${text}`)
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
        await sleep(200)
      }
    }
    const blocks = () => evaluate(`(() => { const out = []; (${pm}).pmViewDesc.node.forEach((n) => out.push(n.type.name + ':' + n.textContent)); return out })()`)
    const check = async (label) => {
      await sleep(1500)
      const toasts = await evaluate('window.__toasts.slice()')
      assert.deepEqual(toasts.filter((t) => /不一致|无法安全/.test(t)), [], `${label}: no mismatch warning`)
      const state = await evaluate(`(() => { const h = globalThis.__hmSourceReprintHarness; const s = h.liveSource(); return { source: s, equivalent: h.equivalent(s, h.liveDoc()) } })()`)
      assert.equal(state.equivalent, true, `${label}: the source parses to the editor's document:\n${state.source}`)
      return state.source
    }
    await run({ app, evaluate, clickEndOf, systemPaste, blocks, check, key: (key, extra = {}) => pressKey(app.send, { key, ...extra }) })
  } finally {
    await restoreClipboard()
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

const AFTER = ['paragraph:尾段']

// 1. WeChat text on an empty line (LF and Windows CRLF clipboards): one
//    paragraph per line; blank lines and edge blanks have no paragraph.
for (const [name, clip] of [['lf', WECHAT], ['crlf', WECHAT.replace(/\n/g, '\r\n')]]) {
  await session(`wechat-${name}`, async ({ clickEndOf, systemPaste, blocks, check, key }) => {
    await clickEndOf('正文。')
    await key('Enter', { text: '\r' })
    await sleep(300)
    await systemPaste({ text: clip })
    const got = await blocks()
    assert.deepEqual(got.slice(0, 6), ['heading:笔记', 'paragraph:正文。', 'paragraph:今天去了超市', 'paragraph:买了苹果和香蕉', 'paragraph:晚上做饭', 'paragraph:记得早点睡'], `one paragraph per line (${name}):\n${got.join('\n')}`)
    assert.deepEqual(got.slice(-1), AFTER)
    const source = await check(`WeChat text (${name})`)
    assert.match(source, /正文。\n\n今天去了超市\n\n买了苹果和香蕉\n\n晚上做饭\n\n记得早点睡\n\n\| 对比/, source)
  })
}

// 2. In the middle of a paragraph: the first line joins the text before the
//    caret, the last one the text after it.
await session('mid-paragraph', async ({ clickEndOf, systemPaste, blocks, check }) => {
  await clickEndOf('正文')
  await systemPaste({ text: '甲\n乙\n丙' })
  const got = await blocks()
  assert.deepEqual(got.slice(1, 4), ['paragraph:正文甲', 'paragraph:乙', 'paragraph:丙。'], got.join('\n'))
  await check('paste inside a paragraph')
})

// 3. Inline Markdown in a line stays (one parse per line), a line that would
//    be a block on its own (`1) …`, `=====`) is literal text.
await session('inline-and-literal', async ({ clickEndOf, systemPaste, blocks, check, key, evaluate }) => {
  await clickEndOf('正文。')
  await key('Enter', { text: '\r' })
  await sleep(300)
  await systemPaste({ text: '**重点**在这\n1) 第一件事\n=====\n最后一行' })
  const got = await blocks()
  assert.deepEqual(got.slice(2, 6), ['paragraph:重点在这', 'paragraph:1) 第一件事', 'paragraph:=====', 'paragraph:最后一行'], got.join('\n'))
  const strong = await evaluate(`(() => { let found = false; (${pm}).pmViewDesc.node.child(2).forEach((n) => { if (n.marks.some((m) => m.type.name === 'strong') && n.text === '重点') found = true }); return found })()`)
  assert.equal(strong, true, 'the bold mark of the first line')
  await check('inline Markdown + literal block syntax')
})

// 4. Each pasted line is its own block: turning one into a heading leaves
//    the others alone (the user's report).
await session('heading-one-line', async ({ clickEndOf, systemPaste, blocks, check, key, app }) => {
  await clickEndOf('正文。')
  await key('Enter', { text: '\r' })
  await sleep(300)
  await systemPaste({ text: WECHAT })
  await clickEndOf('买了苹果和香蕉')
  const mod = process.platform === 'darwin' ? 4 : 2
  await pressKey(app.send, { key: '2', code: 'Digit2', modifiers: mod | 1 /* Alt */ })
  await sleep(400)
  const got = await blocks()
  // Mod+Alt+2 is Milkdown's heading-2 shortcut.
  assert.deepEqual(got.slice(2, 6).map((b) => b.split(':')[0]), ['paragraph', 'heading', 'paragraph', 'paragraph'], got.join('\n'))
  assert.deepEqual(got.slice(2, 6).map((b) => b.split(':')[1]), ['今天去了超市', '买了苹果和香蕉', '晚上做饭', '记得早点睡'], got.join('\n'))
  await check('one pasted line made a heading')
})

// 5. Markdown structure keeps its Markdown meaning (unchanged path).
await session('markdown-unchanged', async ({ clickEndOf, systemPaste, blocks, check, key }) => {
  await clickEndOf('正文。')
  await key('Enter', { text: '\r' })
  await sleep(300)
  await systemPaste({ text: '## 小标题\n内容第一行\n内容第二行' })
  const got = await blocks()
  assert.deepEqual(got.slice(2, 4).map((b) => b.split(':')[0]), ['heading', 'paragraph'], got.join('\n'))
  assert.equal(got[3], 'paragraph:内容第一行\n内容第二行', 'Markdown: a single line break stays in the paragraph')
  await check('Markdown paste')
})

// 6. In a table cell the lines join the cell (a GFM cell is one line).
await session('table-cell', async ({ clickEndOf, systemPaste, check }) => {
  await clickEndOf('外部选定')
  await systemPaste({ text: '甲\n乙' })
  const source = await check('plain lines pasted into a table cell')
  assert.match(source, /\| 策略 \| 外部选定甲<br\s*\/?>乙 \|/, source)
})

await fs.rm(root, { recursive: true, force: true })
console.log('PASS plain text paste UI: WeChat-style lines (LF / CRLF) → one paragraph each, inside a paragraph the ends join, inline Markdown kept, block syntax literal, one line can become a heading alone, Markdown text unchanged, table cell joins with <br>; no warning, source = editor')
