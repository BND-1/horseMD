import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const dir = '/tmp/horsemd-issue-84-image-alt'
const file = join(dir, 'image-alt.md')
const port = Number(process.env.CDP_PORT || 9484)
const source = [
  '# 图片说明回归',
  '',
  '![测试图片](image/test.png)',
  '',
  '![替代说明](image/with-title.png "图片标题")',
  '',
  '![1.50](image/legacy.png "旧版图片说明")',
  '',
  '保存测试正文'
].join('\n')

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)

const visibleSource = (evaluate) => evaluate(`(() =>
  [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
)()`)

async function waitFor(check, message, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

async function saveWithFab(evaluate) {
  await waitFor(() => evaluate(`(() => {
    const button = document.querySelector('.hm-save-fab')
    if (!button) return false
    button.click()
    return true
  })()`), 'Save action did not become available')
}

async function appendRichText(evaluate, send, text) {
  assert.equal(await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const index = node.nodeValue.indexOf('保存测试正文')
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index + node.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      return true
    }
    return false
  })()`), true, 'Could not place the rich-text caret after the body text')
  await send('Input.insertText', { text })
}

function assertImages(markdown) {
  assert.ok(markdown.includes('![测试图片](image/test.png)'), 'Plain image alt text changed')
  assert.ok(markdown.includes('![替代说明](image/with-title.png "图片标题")'), 'Image alt/title pair changed')
  assert.ok(markdown.includes('![1.50](image/legacy.png "旧版图片说明")'), 'Legacy resized image changed')
  assert.ok(!markdown.includes('![1.00](image/test.png)'), 'Plain image alt text was replaced with the resize ratio')
}

async function main() {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, source, 'utf8')

  const app = await launchBuiltElectron({
    profileDir: join(dir, 'profile'),
    port,
    appArgs: [file],
    executable: process.env.HORSEMD_APP_PATH || undefined,
    entrypoint: process.env.HORSEMD_APP_PATH ? null : undefined
  })
  const { evaluate, send } = app

  try {
    await waitFor(
      () => evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent)`),
      'Rich editor did not become visible'
    )

    for (let index = 0; index < 10; index += 1) {
      await appendRichText(evaluate, send, String(index))
      await saveWithFab(evaluate)
      const expectedSuffix = Array.from({ length: index + 1 }, (_, value) => value).join('')
      await waitFor(async () => (await readFile(file, 'utf8')).includes(`保存测试正文${expectedSuffix}`), 'Document was not saved')
      assertImages(await readFile(file, 'utf8'))

      assert.equal(await toggleSource(evaluate), true, 'Could not switch to source mode')
      assertImages(await waitFor(() => visibleSource(evaluate), 'Source editor did not open'))
      assert.equal(await toggleSource(evaluate), true, 'Could not return to rich mode')
    }

    console.log('PASS issue 84 UI: 10 rich-edit/save/source round trips preserve image alt text, titles, and legacy resize ratios')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
