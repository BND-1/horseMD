import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const dir = '/tmp/horsemd-large-doc-source-preservation'
const file = join(dir, 'large-source-preservation.md')
const port = Number(process.env.CDP_PORT || 9496)

const paragraphs = Array.from({ length: 1000 }, (_, index) =>
  `保真段落 ${index}：区间 0~9，重复文本 alpha beta；` +
  '这一整段用于跨过分块阈值，同时避免用数千个标题干扰被测加载路径。'.repeat(3)
)

const sourceLf = [
  '# 大文档保真审计',
  '## 连续标题不应被加空行',
  '审计起点：0~9。',
  '',
  '- 紧凑列表一',
  '- 紧凑列表二',
  '',
  ...paragraphs.flatMap((paragraph) => [paragraph, '']),
  '',
  '大文档审计终点'
].join('\n')
const source = '\uFEFF' + sourceLf.replace(/\n/g, '\r\n')
const sourceForTextarea = source.replace(/\r\n?/g, '\n')

async function waitFor(check, message, attempts = 400) {
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

async function main() {
  assert.ok(source.length > 120000, `fixture did not cross chunk threshold: ${source.length}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, source, 'utf8')

  const app = await launchBuiltElectron({
    profileDir: join(dir, 'profile'),
    port,
    appArgs: [file]
  })
  const { evaluate, send } = app

  try {
    await waitFor(
      () => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return !!editor && editor.textContent.includes('大文档审计终点')
      })()`),
      'chunked rich editor did not finish loading'
    )

    assert.equal(await toggleSource(evaluate), true, 'source toggle was unavailable before editing')
    assert.equal(
      await waitFor(() => visibleSource(evaluate), 'source editor did not open before editing'),
      sourceForTextarea,
      'the source textarea did not show the complete chunked document'
    )
    assert.equal(await toggleSource(evaluate), true, 'could not return to rich mode before editing')
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'rich editor did not return before the first edit'
    )
    assert.equal(
      await evaluate(`!!document.querySelector('.hm-save-fab')`),
      false,
      'opening and switching a chunked document marked it dirty'
    )
    assert.equal(
      await readFile(file, 'utf8'),
      source,
      'opening and switching a chunked document wrote to disk'
    )

    const caretPlaced = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      if (!editor) return false
      const needle = '审计起点'
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode
        const index = node.nodeValue.indexOf(needle)
        if (index < 0) continue
        const range = document.createRange()
        range.setStart(node, index + needle.length)
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
    assert.equal(caretPlaced, true, 'could not place caret in the first chunk')
    await send('Input.insertText', { text: 'X' })
    await sleep(500)

    assert.equal(await toggleSource(evaluate), true, 'source toggle was unavailable')
    const actual = await waitFor(() => visibleSource(evaluate), 'source editor did not open')
    const expectedAfterRich = source.replace('审计起点', '审计起点X')
    assert.equal(
      actual,
      expectedAfterRich.replace(/\r\n?/g, '\n'),
      'the first rich edit after chunked loading was lost or normalized untouched source'
    )

    const sourceEdited = await evaluate(`(() => {
      const textarea = [...document.querySelectorAll('textarea.source-editor')]
        .find((node) => node.offsetParent)
      if (!textarea) return false
      const index = textarea.value.indexOf('紧凑列表二')
      if (index < 0) return false
      const at = index + '紧凑列表二'.length
      textarea.setSelectionRange(at, at)
      textarea.setRangeText('Y', at, at, 'end')
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Y' }))
      return true
    })()`)
    assert.equal(sourceEdited, true, 'could not edit the CRLF document in source mode')
    await sleep(500)

    assert.equal(await toggleSource(evaluate), true, 'could not return to rich mode')
    await waitFor(
      () => evaluate(`!!document.querySelector('.hm-save-fab')`),
      'save button did not appear after the large-document edit'
    )
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(
      () => evaluate(`!document.querySelector('.hm-save-fab')`),
      'large-document save did not finish'
    )
    assert.equal(
      await readFile(file, 'utf8'),
      expectedAfterRich.replace('紧凑列表二', '紧凑列表二Y'),
      'saving rich/source edits changed bytes or line endings outside the edits'
    )

    console.log('PASS large document source preservation: first rich edit stays local after chunked loading')
  } finally {
    await stopBuiltElectron(app)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
