// `$$` math blocks edited in rich mode (Windows trace 2026-10-27: a 公式
// block from the slash menu, then typing → "检测到富文本与源码不一致").
// Crepe's remarkMathBlock rebuilt each math node as a LaTeX `code` node
// without `position`; the source reprint engine then sliced the document at
// `undefined` and printed it twice around the edit. Locked here: typing in a
// new 公式 block (slash menu, arrow keys, like the user) and in a block read
// from the file (LF and CRLF) — no warning, exact source, exact bytes saved,
// the authored `$$` lines untouched.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { pressKey } from './lib/human-input.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-math-edit-'))

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

// Open a math block's code (Crepe shows only the formula by default), put the
// caret at the end of `text` inside it.
async function editMath(h, text) {
  await h.evaluate(`[...document.querySelectorAll('.milkdown-code-block')].find((n) => n.offsetParent && n.querySelector('.language-button')?.textContent.trim() === 'LaTeX').querySelector('.preview-toggle-button').click()`)
  await sleep(500)
  const point = await h.evaluate(`((text) => {
    const line = [...document.querySelectorAll('.milkdown-code-block .cm-line')].find((n) => n.offsetParent && n.textContent.includes(text))
    const range = document.createRange(); range.selectNodeContents(line); range.collapse(false)
    const rect = range.getClientRects()[0] || line.getBoundingClientRect()
    return { x: Math.round(rect.right + 1), y: Math.round(rect.top + rect.height / 2) }
  })(${JSON.stringify(text)})`)
  await h.click(point)
}

try {
  // 1. A block read from the file: only its content line changes.
  const lf = '# 公式\n\n段落一。\n\n$$\nx^2\n$$\n\n段落二。\n'
  await session('existing-lf', lf, async (h, file) => {
    await editMath(h, 'x^2')
    await h.type('+1')
    await sleep(1500)
    assert.deepEqual(await h.toasts(), [], 'no warning while typing in a math block from the file')
    const expected = '# 公式\n\n段落一。\n\n$$\nx^2+1\n$$\n\n段落二。\n'
    assert.equal(await h.source(), expected)
    await h.save()
    assert.equal(await fs.readFile(file, 'utf8'), expected, 'saved bytes')
  })

  // 2. CRLF file: the `$$` lines and every other line keep CRLF.
  const crlf = '# 公式\r\n\r\n$$\r\n\\int_0^1 x\\,dx\r\n$$\r\n\r\n尾。\r\n'
  await session('existing-crlf', crlf, async (h, file) => {
    await editMath(h, 'dx')
    await h.type(' + C')
    await sleep(1500)
    assert.deepEqual(await h.toasts(), [], 'no warning in a CRLF file')
    await h.save()
    assert.equal(await fs.readFile(file, 'utf8'), '# 公式\r\n\r\n$$\r\n\\int_0^1 x\\,dx + C\r\n$$\r\n\r\n尾。\r\n', 'saved bytes (CRLF kept)')
  })

  // 3. The user's path: an empty line, "/", arrow keys to 公式, Enter, type.
  const base = '## 测试一下\n\n第一段文字。\n\n```\nabc\n```\n\nlm\n'
  await session('slash', base, async (h, file) => {
    await h.click(await h.endOfText('lm'))
    await h.key('Enter')
    await h.type('/')
    await sleep(900)
    const items = await h.evaluate(`[...document.querySelectorAll('.milkdown-slash-menu li')].map((li) => li.textContent.trim())`)
    const target = items.findIndex((label) => /公式/.test(label))
    assert.ok(target > 0, `公式 in the slash menu: ${items.join(' | ')}`)
    for (let i = 0; i < target; i += 1) { await h.key('ArrowDown'); await sleep(60) }
    assert.match(await h.evaluate(`document.querySelector('.milkdown-slash-menu li.hover')?.textContent || ''`), /公式/)
    await h.key('Enter')
    await sleep(500)
    await h.type('opjpio', 15)
    await sleep(1500)
    assert.deepEqual(await h.toasts(), [], 'no warning after typing in a new 公式 block')
    const expected = base + '\n$$\nopjpio\n$$\n'
    assert.equal(await h.source(), expected)
    await h.save()
    assert.equal(await fs.readFile(file, 'utf8'), expected, 'saved bytes')
  })

  // 4. LaTeX line breaks (user report 2026-10-30): `\\` / a trailing `\` at
  // a line end in a $$ block. The serializer turned them into the two-space
  // hard-break spelling, so a full serialization changed the formula and the
  // sync check paused (富文本与源码不一致). The live document must serialize
  // to a Markdown that parses back to itself, and the bytes are saved as typed.
  const latex = '题目给了两条曲线\n\n$$\nE_1:y^2 = x^3 +a_1 x + b \\pmod {p_1}\n$$\n'
  await session('latex-breaks', latex, async (h, file) => {
    await editMath(h, '{p_1}')
    await h.type('\\\\')
    await h.key('Enter')
    await h.type('E_2')
    await sleep(1500)
    assert.deepEqual(await h.toasts(), [], 'no warning after typing \\\\ in a math block')
    const faithful = await h.evaluate(`(() => { const x = globalThis.__hmSourceReprintHarness; const doc = x.liveDoc(); const md = x.serialize(doc); return { md, same: x.equivalent(md, doc) } })()`)
    assert.ok(faithful.same, `full serialization keeps the formula: ${JSON.stringify(faithful.md)}`)
    assert.match(faithful.md, /\{p_1\}\\\\\nE_2/)
    const expected = '题目给了两条曲线\n\n$$\nE_1:y^2 = x^3 +a_1 x + b \\pmod {p_1}\\\\\nE_2\n$$\n'
    assert.equal(await h.source(), expected)
    await h.save()
    assert.equal(await fs.readFile(file, 'utf8'), expected, 'saved bytes')
  })

  // 5. The user's real case: a NEW (untitled) document — its source is
  // generated from the serialization on every sync, so the formula went
  // through every line pass (hard-break spelling, escape restoration,
  // `<br />` / empty-item clean-up) and `\\` at a line end paused the sync
  // on each keystroke. `$$` + Enter as the user typed it.
  await session('untitled-latex', '占位\n', async (h) => {
    await h.evaluate(`[...document.querySelectorAll('button')].find((n) => /command palette|命令面板/i.test(n.title || n.getAttribute('aria-label') || ''))?.click()`)
    for (let i = 0; i < 40 && !(await h.evaluate(`Boolean(document.querySelector('.palette input'))`)); i += 1) await sleep(100)
    await h.evaluate(`document.querySelector('.palette input').focus()`)
    await h.app.send('Input.insertText', { text: '新建文件' })
    await sleep(250)
    await h.evaluate(`[...document.querySelectorAll('.palette-item')].find((n) => n.querySelector('.pi-title')?.textContent.trim() === '新建文件')?.click()`)
    for (let i = 0; i < 60 && !(await h.evaluate(`/未命名|Untitled/.test(document.querySelector('.tab.active')?.textContent || '')`)); i += 1) await sleep(100)
    await sleep(800)
    const box = await h.evaluate(`(() => { const b = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent).getBoundingClientRect(); return { x: Math.round(b.left + 60), y: Math.round(b.top + 20) } })()`)
    await h.click(box)
    const ins = async (text) => { for (const ch of [...text]) { await h.app.send('Input.insertText', { text: ch }); await sleep(30) } }
    await ins('题目给了两条曲线')
    await h.key('Enter')
    await ins('$$')
    await h.key('Enter')
    await sleep(700)
    assert.ok(await h.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent).querySelector('.milkdown-code-block .cm-content'))`), '$$ + Enter made a 公式 block')
    await ins('E_1:y^2 = x^3 + b')
    await sleep(800)
    await ins('\\\\')
    await sleep(1200)
    await h.key('Enter')
    await ins(' <br /> - d \\{a\\}')
    await sleep(1500)
    const fails = await h.evaluate('(globalThis.__hmSourceIntegrityTrace || []).filter((e) => e.ok === false).map((e) => e.preservationReason)')
    assert.deepEqual(await h.toasts(), [], 'no warning typing \\\\ + Enter in a new document')
    assert.deepEqual(fails, [], `no failed sync check: ${fails}`)
    const live = await h.evaluate('globalThis.__hmSourceReprintHarness.liveSource()')
    assert.ok(live.includes('$$\nE_1:y^2 = x^3 + b\\\\\n <br /> - d \\{a\\}\n$$'), `formula kept in the generated source: ${JSON.stringify(live)}`)
  })

  console.log('PASS math block edit UI: a new document\'s formula keeps \\\\ / <br /> / \\{ (no warning, no failed check); LaTeX \\\\ line breaks survive a full serialization;  typing in a slash-menu 公式 block and in $$ blocks from LF / CRLF files keeps the source exact, no mismatch warning')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
