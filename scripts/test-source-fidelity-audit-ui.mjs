import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const dir = '/tmp/horsemd-source-fidelity-audit'
const file = join(dir, 'source-fidelity-audit.md')
const port = Number(process.env.CDP_PORT || 9497)

const original = [
  '---',
  'name: source-fidelity-audit',
  'description: 保留 YAML 原始写法',
  '---',
  '',
  'SETEXT_TARGET',
  '=============',
  '',
  '普通段落保留 0~9、\\*转义\\*、**粗体**、_斜体_ 和 `inline_code`。',
  '',
  '[HorseMD][horse] 与引用链接共存。',
  '[shortcut] 简写引用与 SHORTCUT_AFTER 共存。',
  '',
  '[horse]: https://github.com/BND-1/horseMD "HorseMD"',
  '[shortcut]: https://example.com/shortcut',
  '',
  'REF_AFTER 位于引用定义之后。',
  '',
  'HR_BEFORE',
  '',
  '---',
  '',
  'HR_AFTER 位于分隔线之后。',
  '',
  '> 引用中的 BLOCKQUOTE_TARGET。',
  '',
  '- 紧凑一',
  '  - 子项 LIST_CHILD',
  '- 紧凑二',
  '',
  '1) 有序一',
  '2) 有序二',
  '',
  '- [ ] 待办 TASK_TARGET',
  '',
  'HTML 前 <font color=#F36208>HTML_COLOR</font> 后 HTML_AFTER。',
  '',
  '实体 ENTITY_AFTER：&copy;、&amp;、&hellip;；自动链接 <https://example.com/path>。',
  '',
  'A | B',
  ':--- | ---:',
  'TABLE_CELL | second<br>line',
  '',
  '```js',
  'const code = \"0~9\"',
  '```',
  '',
  'CODE_AFTER 位于围栏之后。',
  '',
  '$$',
  'M R S_R = \\frac{-\\Delta I}{\\Delta R}',
  '$$',
  '',
  'MATH_AFTER 位于公式之后。',
  '',
  '尾随空格硬换行  ',
  '下一行。',
  '',
  '',
  'FINAL_TARGET 保留结尾。',
  ''
].join('\n')

const edits = [
  'SETEXT_TARGET',
  'REF_AFTER',
  'SHORTCUT_AFTER',
  'HR_AFTER',
  'BLOCKQUOTE_TARGET',
  'LIST_CHILD',
  'TASK_TARGET',
  'HTML_AFTER',
  'ENTITY_AFTER',
  'TABLE_CELL',
  'CODE_AFTER',
  'MATH_AFTER',
  'FINAL_TARGET'
]

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const placeCaretAfter = (evaluate, needle) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  if (!editor) return false
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    const index = node.nodeValue.indexOf(${JSON.stringify(needle)})
    if (index < 0) continue
    const range = document.createRange()
    range.setStart(node, index + ${JSON.stringify(needle)}.length)
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

async function main() {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, original, 'utf8')

  const app = await launchBuiltElectron({
    profileDir: join(dir, 'profile'),
    port,
    appArgs: [file]
  })
  const { evaluate, send } = app

  try {
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'rich editor did not open'
    )
    assert.equal(await toggleSource(evaluate), true)
    assert.equal(await waitFor(() => visibleSource(evaluate), 'source mode did not open'), original)
    assert.equal(await toggleSource(evaluate), true)
    await evaluate(`window.__hmPreserveLog = []`)

    let expected = original
    for (const needle of edits) {
      assert.equal(
        await placeCaretAfter(evaluate, needle),
        true,
        `could not place caret after ${needle}`
      )
      const inserted = 'X'
      await send('Input.insertText', { text: inserted })
      await sleep(250)
      expected = expected.replace(needle, needle + inserted)

      assert.equal(await toggleSource(evaluate), true, `could not inspect source after ${needle}`)
      const source = await waitFor(() => visibleSource(evaluate), `source did not open after ${needle}`)
      if (source !== expected) {
        console.error('source-fidelity preservation log:', JSON.stringify(
          await evaluate(`window.__hmPreserveLog || []`),
          null,
          2
        ))
      }
      assert.equal(source, expected, `editing ${needle} changed bytes outside the selected rich-text position`)
      assert.equal(await toggleSource(evaluate), true, `could not return to rich mode after ${needle}`)
    }

    await waitFor(
      () => evaluate(`!!document.querySelector('.hm-save-fab')`),
      'save button did not appear'
    )
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(
      () => evaluate(`!document.querySelector('.hm-save-fab')`),
      'save did not finish'
    )
    assert.equal(await readFile(file, 'utf8'), expected, 'saved bytes differ from the audited source snapshot')
    console.log('PASS source fidelity audit UI: heterogeneous Markdown stays byte-local across rich edits')
  } finally {
    await stopBuiltElectron(app)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
