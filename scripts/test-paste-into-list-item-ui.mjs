// #171 (Windows, 0.13.259): Enter at the end of a list item, then Ctrl+V of a
// fenced code block → 「检测到富文本与源码不一致」(source-list-structure-mismatch).
// Three causes, locked here in a CRLF file that has a code block nested in a
// list item further up (its `- name:` line is YAML, not a list item):
//   1. the list-slot check read that nested fence as text and its `- name:`
//      line as a list item, so every later list was compared with the wrong
//      list (the parser now confirms a difference before it stops a sync);
//   2. when the pasted bytes could not be kept, the paste skipped the source
//      reprint and went to the legacy owners, which cannot place a block
//      inside a list item;
//   3. pasted lines kept the clipboard's line endings (a CRLF file became
//      mixed).
// Each case: no warning, the source parses to the editor's document, CRLF
// only, and the code sits inside the item.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { pressKey } from './lib/human-input.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-paste-list-'))
const pm = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`

const DOC = [
  '# 设计模式',
  '',
  '- 配置示例',
  '  - 子项',
  '',
  '    ```yaml',
  '    - name: build',
  '      run: npm ci',
  '    ```',
  '',
  '正文。',
  '',
  '## 工厂',
  '',
  '- 做法：父类定义流程',
  '- 解决：扩展靠新增子类',
  '- 例子：`Collection.iterator()`',
  '',
  '抽象工厂',
  '',
  '- 做法：一个工厂',
  ''
].join('\r\n')

const CODE = '```\nclass Wrapper implements Target {\n    private final Something inner;\n\n    public void doIt() {\n        inner.doIt();\n    }\n}\n\n```\n'

async function session(name, run, doc = DOC) {
  const file = join(root, `${name}.md`)
  await fs.writeFile(file, doc)
  const inspectPort = 9300 + Math.floor(Math.random() * 150)
  const app = await launchBuiltElectron({ profileDir: join(root, `profile-${name}`), port: 9500 + Math.floor(Math.random() * 200), appArgs: [file, '--horsemd-input-trace', `--inspect=${inspectPort}`] })
  const evaluate = (expression) => app.evaluate(expression)
  // Main process (Node inspector): the system clipboard + webContents.paste(),
  // what Ctrl+V does — a trusted paste with the OS clipboard's line endings.
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
  const systemPaste = (text) => mainEval(`(() => { const { clipboard, BrowserWindow } = require('electron'); const previous = clipboard.readText(); clipboard.writeText(${JSON.stringify(text)}); const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()); win.webContents.paste(); setTimeout(() => clipboard.writeText(previous), 800); return true })()`)
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
            return { x: Math.round(rect.right + 2), y: Math.round(rect.top + rect.height / 2) }
          }
          return null
        })(${JSON.stringify(text)})`)
        assert.ok(point, `text on screen: ${text}`)
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
        await sleep(200)
      }
    }
    const paste = (text) => evaluate(`((text) => {
      const data = new DataTransfer(); data.setData('text/plain', text)
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
      ;(${pm}).dispatchEvent(event)
      return event.defaultPrevented
    })(${JSON.stringify(text)})`)
    const check = async (label, opts = {}) => {
      await sleep(1500)
      const toasts = await evaluate('window.__toasts.slice()')
      assert.deepEqual(toasts.filter((t) => /不一致|无法安全/.test(t)), [], `${label}: no mismatch warning`)
      const state = await evaluate(`(() => { const h = globalThis.__hmSourceReprintHarness; const s = h.liveSource(); return { source: s, equivalent: h.equivalent(s, h.liveDoc()) } })()`)
      assert.equal(state.equivalent, true, `${label}: the source parses to the editor's document:\n${state.source}`)
      if (!opts.allowLoneCr) assert.doesNotMatch(state.source, /(^|[^\r])\n|\r(?!\n)/, `${label}: CRLF only:\n${JSON.stringify(state.source)}`)
      return state.source
    }
    await run({ app, evaluate, clickEndOf, paste, systemPaste, check, key: (key, extra = {}) => pressKey(app.send, { key, ...extra }) })
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

// 1–2. Enter after the last item, paste a fenced block (LF and CRLF clipboard).
for (const [name, clip] of [['lf', CODE], ['crlf', CODE.replace(/\n/g, '\r\n')]]) {
  await session(`item-${name}`, async ({ clickEndOf, paste, check, key }) => {
    await clickEndOf('iterator()')
    await key('Enter', { text: '\r' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(await paste(clip), true, 'the Markdown paste handler took the paste')
    const source = await check(`paste into a list item (${name} clipboard)`)
    assert.match(source, /- 例子：`Collection\.iterator\(\)`\r\n-[^\r\n]*\r\n(?:\r\n)?  ```\r\n  class Wrapper implements Target \{\r\n/, `the code is inside the new item:\n${source}`)
    assert.match(source, /\r\n\r\n抽象工厂\r\n/, 'the next paragraph is still separate')
  })
}

// 3. A new empty line under a paragraph, paste a fenced block: blank lines
//    around it, the file's CRLF (the clipboard has LF).
await session('top-level', async ({ clickEndOf, paste, check, key }) => {
  await clickEndOf('正文。')
  await key('Enter', { text: '\r' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(await paste('```\ncode line\n```\n'), true)
  const source = await check('paste on a new line')
  assert.match(source, /正文。\r\n\r\n```\r\ncode line\r\n```\r\n\r\n## 工厂/, source)
})

// 4. The legacy owners (reprint off) after the nested fence: a list edit
//    below it is compared with its own list.
await session('legacy-list-edit', async ({ evaluate, clickEndOf, check, key, app }) => {
  await evaluate('globalThis.__hmSourceReprintPrimary = false')
  await clickEndOf('iterator()')
  await key('Enter', { text: '\r' })
  for (const ch of '新的一项') { await app.send('Input.insertText', { text: ch }); await new Promise((resolve) => setTimeout(resolve, 30)) }
  const source = await check('list edit through the legacy owners')
  // (On Windows the click can land inside the code span: the new item then
  // continues the code mark — still the editor's document, exactly saved.)
  assert.match(source, /- 例子：`Collection\.iterator\(\)`\r\n- `?新的一项`?\r\n/, source)
})

// 5. The user's file as 0.13.259 left it: an earlier paste glued a fence to
//    the list above with a lone CR (`常用\r```` + LF lines). A paste into a
//    later list item must not stop on it.
const GLUED = DOC.replace('正文。\r\n', '- 缺点：插件系统常用\r```\nclass A {}\n```\n\n\r\n正文。\r\n')
await session('lone-cr', async ({ clickEndOf, paste, check, key }) => {
  await clickEndOf('iterator()')
  await key('Enter', { text: '\r' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(await paste(CODE), true)
  const source = await check('paste into a list item below a lone-CR fence', { allowLoneCr: true })
  assert.ok(source.startsWith(GLUED.slice(0, GLUED.indexOf('## 工厂'))), 'the bytes above the edit are untouched')
  assert.match(source, /- 例子：`Collection\.iterator\(\)`\r\n-[^\r\n]*\r\n(?:\r\n)?  ```\r\n/, source)
}, GLUED)

// 6. A real Ctrl+V: the system clipboard (CRLF on Windows) through
//    webContents.paste().
await session('system-clipboard', async ({ clickEndOf, systemPaste, check, key }) => {
  await clickEndOf('iterator()')
  await key('Enter', { text: '\r' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(await systemPaste(CODE), true)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const source = await check('system clipboard paste into a list item')
  assert.match(source, /- 例子：`Collection\.iterator\(\)`\r\n-[^\r\n]*\r\n(?:\r\n)?  ```\r\n  class Wrapper/, source)
})

// 7. A two-line quote pasted into a table cell (fuzz seed 30):
//    its soft line break has no spelling in a one-line cell; it becomes <br>.
const TABLE = ['# 表格', '', '| 对比 | 区别 |', '| :--- | :--- |', '| 策略 | 外部选定 |', '', '尾段', ''].join('\r\n')
// (Plain multi-line text fills cells like a pasted grid, #152.)
for (const [name, clip] of [['quote', '> 引用第一行\r\n> 第二行\r\n'], ['quote-lf', '> 引用第一行\n> 第二行']]) {
  await session(`cell-${name}`, async ({ clickEndOf, paste, check }) => {
    await clickEndOf('外部选定')
    await paste(clip)
    const source = await check(`two-line ${name} pasted into a table cell`)
    assert.match(source, /\| 策略 \| 外部选定(?:> )?[^|\r\n]*<br\s*\/?>[^|\r\n]*第二行 \|\r\n/, source)
  }, TABLE)
}

// 8. A Markdown table from a Windows clipboard (CRLF) pasted in the middle of
//    a paragraph (fuzz seed 13): the CR stopped the Markdown detection, the
//    table went in as text and Milkdown's conversion pulled the rest of the
//    paragraph into its last cell. It is a table, and the rest stays a
//    paragraph.
const PARA = ['# 表格', '', '前半段后半段', '第二行', '', '尾段', ''].join('\r\n')
for (const [name, clip] of [['crlf', '| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\n'], ['lf', '| a | b |\n| --- | --- |\n| 1 | 2 |\n']]) {
  await session(`table-mid-paragraph-${name}`, async ({ evaluate, clickEndOf, paste, check }) => {
    await clickEndOf('前半段')
    assert.equal(await paste(clip), true, 'the Markdown paste handler took the table')
    const source = await check(`table pasted mid-paragraph (${name} clipboard)`)
    const cells = await evaluate(`(() => { const t = globalThis.__hmSourceReprintHarness.liveDoc().toJSON().content.find((n) => n.type === 'table'); return t ? t.content.at(-1).content.map((c) => JSON.stringify(c.content)) : null })()`)
    assert.ok(cells && !cells.join('').includes('后半段'), `the rest of the paragraph is not in the table: ${cells}`)
    assert.match(source, /前半段\r\n\r\n\| a \| b \|\r\n[\s\S]*\| 1 \| 2 \|\r\n\r\n后半段\r\n第二行\r\n/, source)
  }, PARA)
}

// 9. Two lines of plain text pasted in the middle of a heading (fuzz seed
//    40): a heading is one line, so it ends at the line break and the rest
//    becomes a paragraph below it.
const HEADING = ['# 文档', '', '### 2. 谁来响应会变', '', '- 观察者', ''].join('\r\n')
await session('heading', async ({ evaluate, clickEndOf, paste, check }) => {
  await clickEndOf('2. ')
  await paste('纯文本第一行\r\n纯文本第二行\r\n\r\n第三行')
  const source = await check('two lines pasted into a heading')
  const heading = await evaluate(`globalThis.__hmSourceReprintHarness.liveDoc().toJSON().content.find((n) => n.type === 'heading' && n.attrs.level === 3)`)
  assert.ok(!(heading.content || []).some((n) => n.type === 'hardbreak'), `no line break left in the heading: ${JSON.stringify(heading)}`)
  assert.match(source, /### 2\. ?纯文本第一行\r\n\r\n纯文本第二行/, source)
}, HEADING)

await fs.rm(root, { recursive: true, force: true })
console.log('PASS paste into list item (#171): fenced code into a new item (LF/CRLF clipboard), a new top-level line, a legacy list edit below a fence nested in a list, a paste below a lone-CR fence, a system-clipboard Ctrl+V, a two-line quote pasted into a table cell, a CRLF / LF Markdown table pasted mid-paragraph, and two lines pasted into a heading — no warning, exact CRLF source')
