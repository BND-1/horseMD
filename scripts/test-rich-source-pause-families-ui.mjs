// Real Electron regression for the rich/source "mismatch" pause families found
// by scripts/fuzz-rich-source-ui.mjs on 2026-10-02 (0.13.235). Each case used
// to raise 「检测到富文本与源码不一致」 (or strand the edit until Save fell into
// the recovery-copy prompt). Every case now must:
//   - raise no mismatch / save-paused warning,
//   - show the exact expected Markdown in source mode,
//   - write exactly those bytes on Save,
//   - reopen cold (fresh profile) to the same rich document.
// Input is real CDP mouse/keyboard, one character at a time.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-pause-families-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 9860)
// HORSEMD_APP_PATH=/Applications/HorseMD.app/Contents/MacOS/HorseMD runs the
// same cases against an installed (packaged) build.
const packagedLaunch = process.env.HORSEMD_APP_PATH
  ? { executable: process.env.HORSEMD_APP_PATH, entrypoint: null }
  : {}
const warningPattern = /检测到富文本与源码不一致|保存已暂停|无法安全映射|原文件未被覆盖|mismatch|Save paused/i
const TABLE = '| 名称 Name | 数量 Qty |\n| --- | ---: |\n| 苹果 apple | 3 |\n| 香蕉 banana | 5 |\n'

const cases = [
  {
    name: 'quote with bold: type inside bold',
    doc: '> quote **bold** here\n\nafter\n',
    click: ['bold', 2],
    actions: [['type', 'Z']],
    expected: '> quote **boZld** here\n\nafter\n'
  },
  {
    name: 'two-line quote: type on second line',
    doc: '> 引用段落 quoted paragraph\n> 第二行 second quoted line\n\nafter\n',
    click: ['second quoted line', 18],
    actions: [['type', ' x']],
    expected: '> 引用段落 quoted paragraph\n> 第二行 second quoted line x\n\nafter\n'
  },
  {
    name: 'lazy quote continuation',
    doc: '> 引用段落 quoted paragraph\n第二行 lazy line\n\nafter\n',
    click: ['lazy line', 9],
    actions: [['type', ' x']],
    expected: '> 引用段落 quoted paragraph\n第二行 lazy line x\n\nafter\n'
  },
  {
    name: 'quote *e* input rule (BOM + CRLF)',
    doc: '﻿before\r\n\r\n > quoted alpha\r\n\r\nafter\r\n',
    click: ['quoted alpha', 12],
    actions: [['type', '*e*']],
    expected: '﻿before\r\n\r\n > quoted alpha*e*\r\n\r\nafter\r\n',
    sourceView: '\uFEFFbefore\n\n > quoted alpha*e*\n\nafter\n'
  },
  {
    name: 'table at end of file: space in last cell',
    doc: TABLE,
    click: ['5', 1],
    actions: [['type', ' x']],
    expected: '| 名称 Name | 数量 Qty |\n| --- | ---: |\n| 苹果 apple | 3 |\n| 香蕉 banana | 5 x |\n'
  },
  {
    name: 'table: Enter inside a cell',
    doc: `${TABLE}\nafter\n`,
    click: ['苹果 apple', 2],
    actions: [['enter'], ['type', 'Z']],
    expected: '| 名称 Name | 数量 Qty |\n| --- | ---: |\n| 苹果<br>Z apple | 3 |\n| 香蕉 banana | 5 |\n\nafter\n'
  },
  {
    name: 'table: Enter at end of last cell',
    doc: `${TABLE}\n---\n\nafter\n`,
    click: ['5', 1],
    actions: [['enter'], ['type', 'Z']],
    expected: '| 名称 Name | 数量 Qty |\n| --- | ---: |\n| 苹果 apple | 3 |\n| 香蕉 banana | 5<br>Z |\n\n---\n\nafter\n'
  },
  {
    name: 'paragraph: Enter inside inline code',
    doc: 'Lead 、`inline code` tail.\n\nafter\n',
    click: ['inline code', 9],
    actions: [['type', ' alpha'], ['enter'], ['type', 'Q']],
    expected: 'Lead 、`inline co alpha`\n\n`Qde` tail.\n\nafter\n'
  },
  {
    name: 'paragraph: Enter inside bold',
    doc: 'Lead **bold word** tail.\n\nafter\n',
    click: ['bold word', 4],
    actions: [['enter'], ['type', 'Q']],
    expected: 'Lead **bold**\n\n**Q word** tail.\n\nafter\n'
  },
  {
    name: 'leading space typed then deleted',
    doc: 'first para\n\n最后一段 final paragraph.\n',
    click: ['最后一段', 0],
    actions: [['type', ' 42'], ['backspace', 3]],
    expected: 'first para\n\n最后一段 final paragraph.\n'
  },
  {
    name: 'leading space typed then Backspace-joined into previous paragraph',
    doc: 'first para\n\n最后一段 final paragraph.\n',
    click: ['最后一段', 0],
    actions: [['type', ' 42'], ['backspace', 4]],
    expected: 'first para最后一段 final paragraph.\n'
  },
  {
    name: 'nested list: Enter right before a space',
    doc: '- 第二项 second\n  - 嵌套 nested A\n  - 嵌套 nested B\n- 第三项 third\n\nafter\n',
    click: ['嵌套 nested B', 9],
    actions: [['enter']],
    expected: '- 第二项 second\n  - 嵌套 nested A\n  - 嵌套 nested\n  - \u200B B\n- 第三项 third\n\nafter\n'
  },
  {
    name: 'paragraph: Enter right before inline code',
    doc: 'Lead text 、`inline code` tail.\n\nafter\n',
    click: ['inline code', 0],
    actions: [['enter'], ['type', 'Q']],
    expected: 'Lead text 、\n\nQ`inline code` tail.\n\nafter\n'
  },
  // 0.13.237 (fuzz seed 36): a selected horizontal rule removed by Backspace,
  // or replaced by typing (the text joins the next paragraph). Canonical
  // spells `---` as `***`, which the legacy diff could not anchor.
  {
    name: 'selected horizontal rule: Backspace',
    doc: 'intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n---\n\nfinal para.\n',
    click: ['2', 1],
    actions: [['key', { key: 'ArrowDown' }], ['backspace', 1]],
    expected: 'intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nfinal para.\n'
  },
  {
    name: 'selected horizontal rule: type over it',
    doc: 'intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n---\n\nfinal para.\n',
    click: ['2', 1],
    actions: [['key', { key: 'ArrowDown' }], ['type', 'beta']],
    expected: 'intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nbetafinal para.\n'
  },
  // Milkdown's text stringify fast path skipped escaping for text ending in
  // whitespace (here: before inline code), so Tab's four leading spaces were
  // written raw and reopened as an indented code block (CORRUPT, seed 36).
  {
    name: 'Tab at paragraph start before inline code',
    doc: 'first para\n\nsecond `code` here\n',
    click: ['second', 0],
    actions: [['key', { key: 'Tab' }]],
    expected: 'first para\n\n\u200B    second `code` here\n'
  },
  // Rich undo across a source-mode edit that broke the table (extra header
  // cell → paragraph) restores the exact pre-edit bytes, and later edits keep
  // syncing (history-source-restore.js; seed 36 stranded every later edit).
  {
    name: 'undo across a source edit that broke a table',
    doc: 'intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter\n',
    click: ['intro', 5],
    actions: [
      ['sourceType', ['| A | B |', ' x']],
      ['click', ['after', 5]],
      ['undo'],
      ['click', ['after', 5]],
      ['type', '!']
    ],
    expected: 'intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter!\n'
  },
  // Irregular tables left by a source edit (fuzz seeds 31/34/35): the editor
  // pads short rows; authored bytes keep their own pipes, and cell edits map.
  {
    name: 'irregular table (short row): Enter + type in a cell',
    doc: 'intro\n\n| A | B |\n| --- | --- |\n| 1 |\n| 3 | 4 |\n\nafter\n',
    click: ['3', 1],
    actions: [['enter'], ['type', 'x']],
    expected: 'intro\n\n| A | B |\n| --- | --- |\n| 1 |\n| 3<br>x | 4 |\n\nafter\n'
  },
  // Engine-primary versions of the blockquote transient sequences (the owner
  // tests pin the fallback path with the engine switched off).
  {
    name: 'quoted list: Enter twice exits, then type (CRLF)',
    doc: '> intro\r\n>\r\n> 1. one\r\n> 2. two\r\n\r\nafter\r\n',
    click: ['two', 3],
    actions: [['enter'], ['enter'], ['type', 'X']],
    expected: '> intro\r\n>\r\n> 1. one\r\n> 2. two\r\n>\r\n> X\r\n\r\nafter\r\n',
    sourceView: '> intro\n>\n> 1. one\n> 2. two\n>\n> X\n\nafter\n'
  },
  // MacBook Air user report (2026-10-07): Enter at the end of item 3, commit a
  // phrase with the IME, delete it with fast Backspaces and once more on the
  // empty item. The fast Backspaces arrive as one batch; the reprint kept the
  // following items' old numbers (`3. 5. 6.`) and strict numbering refused it.
  {
    name: 'ordered list: Enter, IME phrase, fast Backspaces back to the original',
    doc: '包括：\n\n1. 招标文件；\n2. 最终技术标或投标文件；\n3. 资信材料清单或最终资信文件；\n4. 费用测算表；\n5. 中标通知书。\n\n## 二\n',
    click: ['资信材料清单或最终资信文件；', 14],
    actions: [['enter'], ['ime', ['sjgls', '数据给老师']], ['backspaceFast', 6]],
    expected: '包括：\n\n1. 招标文件；\n2. 最终技术标或投标文件；\n3. 资信材料清单或最终资信文件；\n4. 费用测算表；\n5. 中标通知书。\n\n## 二\n'
  },
  // MacBook Air user report #2 (2026-10-07): Enter after item 4, type `；`,
  // then pause on the uncommitted pinyin. The 260ms dirty-reconcile timer
  // flushed mid-composition; the reprint (correctly) skips composing states,
  // so an old list owner rejected the transient text and warned.
  {
    name: 'ordered list: Enter, punctuation, pause on uncommitted IME pinyin',
    doc: '包括：\n\n1. 招标文件；\n2. 最终技术标或投标文件；\n3. 资信材料清单或最终资信文件；\n4. 费用测算表；\n5. 中标通知书。\n\n## 二\n',
    click: ['费用测算表；', 6],
    actions: [['enter'], ['ime', ['so e j pi', '宋鹅洁癖', 600, '；']]],
    expected: '包括：\n\n1. 招标文件；\n2. 最终技术标或投标文件；\n3. 资信材料清单或最终资信文件；\n4. 费用测算表；\n5. ；宋鹅洁癖\n6. 中标通知书。\n\n## 二\n'
  },
  // Typora parity (Typora 0.11.18, checked 2026-10-09 with the same keys):
  // emptying a paragraph keeps its line, Backspace on the empty line removes
  // the extra blank lines, typing into it writes one blank line each side.
  {
    name: 'empty a paragraph: its line stays (Typora)',
    doc: '# 测试\n\n你好\n\n再见\n',
    click: ['你好', 2],
    actions: [['backspace', 2]],
    expected: '# 测试\n\n\n\n再见\n'
  },
  {
    name: 'empty a paragraph, Backspace the empty line (Typora)',
    doc: '# 测试\n\n你好\n\n再见\n',
    click: ['你好', 2],
    actions: [['backspace', 2], ['backspace', 1]],
    expected: '# 测试\n\n再见\n'
  },
  {
    name: 'empty a paragraph, type into the empty line (Typora)',
    doc: '# 测试\n\n你好\n\n再见\n',
    click: ['你好', 2],
    actions: [['backspace', 2], ['type', 'Q']],
    expected: '# 测试\n\nQ\n\n再见\n'
  }
]

const visiblePm = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`
const docJson = (app) => app.evaluate(`(() => { const node = ${visiblePm}?.pmViewDesc?.node; return node ? JSON.stringify(node.toJSON()) : null })()`)

// Editor-only differences with no Markdown encoding (see the fuzzer).
const normalize = (json) => {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return node
    if (node.attrs) {
      node.attrs = { ...node.attrs }
      delete node.attrs.id
      delete node.attrs.spread
      delete node.attrs.colwidth
      if (node.type === 'list_item') delete node.attrs.label
    }
    if (Array.isArray(node.content)) {
      node.content = node.content.map(walk)
      if (node.type === 'table') {
        // The live editor pads short authored rows; a cold reopen may not yet.
        const width = Math.max(0, ...node.content.map((row) => row.content?.length || 0))
        for (const row of node.content) {
          const cells = row.content || []
          for (let column = cells.length; cells.length && column < width; column += 1) {
            const model = node.content.find((other) => other.content?.[column])?.content[column]
            cells.push({ type: cells[0].type, ...(model?.attrs ? { attrs: { ...model.attrs } } : {}), content: [{ type: 'paragraph' }] })
          }
        }
      }
      if (node.type === 'doc') node.content = node.content.filter((child) => !(child.type === 'paragraph' && !child.content?.length))
      // Inside a quote or list item, an empty paragraph next to real content
      // has no Markdown spelling either (source reprint design §5).
      if ((node.type === 'list_item' || node.type === 'blockquote') && node.content.some((child) => !(child.type === 'paragraph' && !child.content?.length))) {
        node.content = node.content.filter((child) => !(child.type === 'paragraph' && !child.content?.length))
      }
    }
    return node
  }
  return JSON.stringify(walk(JSON.parse(json)))
}

const waitFor = async (check, message, attempts = 80) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const clickText = async (app, text, offset) => {
  const point = await app.evaluate(`((text, offset) => {
    const pm = ${visiblePm}
    const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const index = node.nodeValue.indexOf(text)
      if (index < 0) continue
      node.parentElement.scrollIntoView({ block: 'center' })
      const range = document.createRange()
      range.setStart(node, index + offset)
      range.collapse(true)
      const rect = range.getClientRects()[0] || node.parentElement.getBoundingClientRect()
      return { x: Math.round(rect.left + 1), y: Math.round(rect.top + rect.height / 2) }
    }
    return null
  })(${JSON.stringify(text)}, ${offset})`)
  assert.ok(point, `text not found: ${text}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await app.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
  await sleep(150)
}

const setSourceMode = async (app, wanted) => {
  const visible = () => app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent))`)
  if ((await visible()) === wanted) return
  await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
    button?.click()
  })()`)
  await waitFor(async () => (await visible()) === wanted, `source mode did not become ${wanted}`, 60)
  await sleep(150)
}

const installToastRecorder = (app) => app.evaluate(`(() => {
  window.__toasts = []
  window.alert = (message) => window.__toasts.push(String(message))
  const seen = new WeakSet()
  new MutationObserver(() => {
    for (const node of document.querySelectorAll('.hm-toast-msg')) {
      if (!seen.has(node)) { seen.add(node); window.__toasts.push(node.textContent) }
    }
  }).observe(document.body, { childList: true, subtree: true })
})()`)

let port = basePort
let failures = 0
await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
// HM_CASE=<substring> runs only the matching cases.
for (const [index, testCase] of cases.entries()) {
  if (process.env.HM_CASE && !testCase.name.includes(process.env.HM_CASE)) continue
  const dir = join(root, `case-${index}`)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'doc.md')
  await writeFile(file, testCase.doc, 'utf8')
  let app = null
  let reopen = null
  try {
    app = await launchBuiltElectron({ profileDir: join(dir, 'profile'), port: port++, appArgs: [file, '--horsemd-input-trace'], ...packagedLaunch })
    await app.send('Runtime.enable')
    await waitFor(() => docJson(app), 'editor did not mount')
    await sleep(400)
    await installToastRecorder(app)
    await clickText(app, ...testCase.click)
    for (const [action, value] of testCase.actions) {
      if (action === 'type') await typeTextLikeUser(app.send, value, { delayMs: 40 })
      if (action === 'enter') await pressKey(app.send, { key: 'Enter', text: '\r' })
      if (action === 'key') await pressKey(app.send, value)
      if (action === 'click') await clickText(app, ...value)
      if (action === 'undo') await pressKey(app.send, { key: 'z', code: 'KeyZ', modifiers: process.platform === 'darwin' ? 4 : 2 })
      if (action === 'sourceType') {
        const [needle, text] = value
        await setSourceMode(app, true)
        await app.evaluate(`((needle) => {
          const area = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
          const offset = area.value.indexOf(needle) + needle.length
          area.focus()
          area.setSelectionRange(offset, offset)
          area.__horsemdSourceSelectionUser = true
        })(${JSON.stringify(needle)})`)
        for (const character of text) {
          await app.send('Input.insertText', { text: character })
          await sleep(40)
        }
        await sleep(500)
        await setSourceMode(app, false)
        await sleep(400)
      }
      if (action === 'ime') {
        const [pinyin, committed, pauseMs = 0, typedBefore = ''] = value
        // Characters typed just before the composition (no settle delay).
        for (const character of typedBefore) {
          await app.send('Input.insertText', { text: character })
          await sleep(100)
        }
        for (let length = 1; length <= pinyin.length; length += 1) {
          const text = pinyin.slice(0, length)
          await app.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
          await sleep(90)
        }
        // A user hesitating over the candidate list before committing.
        if (pauseMs) await sleep(pauseMs)
        await app.send('Input.insertText', { text: committed })
      }
      if (action === 'backspaceFast') {
        for (let count = 0; count < value; count += 1) {
          await pressKey(app.send, { key: 'Backspace' })
          await sleep(180)
        }
      }
      if (action === 'backspace') {
        for (let count = 0; count < value; count += 1) await pressKey(app.send, { key: 'Backspace' })
      }
      await sleep(250)
    }
    await sleep(900)
    const live = await docJson(app)
    await setSourceMode(app, true)
    const source = await app.evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent).value`)
    await setSourceMode(app, false)
    assert.equal(source, testCase.sourceView ?? testCase.expected, 'source view')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(async () => (await readFile(file, 'utf8')) === testCase.expected, `saved bytes differ: ${JSON.stringify(await readFile(file, 'utf8'))}`, 40)
    const toasts = await app.evaluate('window.__toasts.slice()')
    assert.equal(toasts.some((text) => warningPattern.test(text)), false, `warning: ${JSON.stringify(toasts)}`)
    await stopBuiltElectron(app, { removeProfile: true })
    app = null
    reopen = await launchBuiltElectron({ profileDir: join(dir, 'reopen'), port: port++, appArgs: [file, '--horsemd-input-trace'], ...packagedLaunch })
    await reopen.send('Runtime.enable')
    const reopened = await waitFor(() => docJson(reopen), 'reopen did not mount')
    await sleep(400)
    assert.equal(normalize(await docJson(reopen) || reopened), normalize(live), 'cold reopen document differs from the live document')
    console.log(`ok   ${testCase.name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${testCase.name}: ${String(error?.message || error).slice(0, 400)}`)
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    if (reopen) await stopBuiltElectron(reopen, { removeProfile: true })
  }
}
if (failures) {
  console.log(`FAIL rich/source pause families: ${failures}/${cases.length} failed (artifacts in ${root})`)
  process.exit(1)
}
await rm(root, { recursive: true, force: true })
console.log(`PASS rich/source pause families: ${cases.length} formerly-pausing edits (quote marks/soft breaks/lazy/*e*, table EOF space, in-cell Enter, Enter before/inside inline code and bold, leading-space sentinel lifecycle, nested Enter before a space, selected hr delete/overtype, Tab before inline code, undo across a source edit, irregular-table cell edits) publish exact bytes without warning and reopen identically`)
