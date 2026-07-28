import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const dir = '/tmp/horsemd-issue-77-source-preservation'
const file = join(dir, 'source-preservation.md')
const port = Number(process.env.CDP_PORT || 9477)

const source = [
  '# 一级标题',
  '## 二级标题',
  '这里是区间：0~9。',
  '',
  '- 第一项末尾\\',
  '  这是同一个列表项中的换行',
  '- 第二项',
  '',
  '这一段不要修改。'
].join('\n')

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  if (!button) return false
  button.click()
  return true
})()`)

const visibleSource = (evaluate) => evaluate(`(() =>
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)()`)

const placeCaretAfter = (evaluate, needle, inserted) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  if (!editor) return false
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let target = null
  let offset = 0
  while (walker.nextNode()) {
    const node = walker.currentNode
    const index = node.nodeValue.indexOf(${JSON.stringify(needle)})
    if (index >= 0) {
      target = node
      offset = index + ${JSON.stringify(needle)}.length
      break
    }
  }
  if (!target) return false
  const range = document.createRange()
  range.setStart(target, offset)
  range.collapse(true)
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  editor.focus()
  document.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    inputType: 'insertText',
    data: ${JSON.stringify(inserted)}
  }))
  document.dispatchEvent(new Event('selectionchange'))
  return true
})()`)

const saveDocument = async (evaluate, send) => {
  const point = await waitFor(() => evaluate(`(() => {
    const button = document.querySelector('.hm-save-fab')
    const rect = button?.getBoundingClientRect()
    return rect ? {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    } : null
  })()`), 'Save button did not appear after rich edits')
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'Save did not complete')
}

async function waitFor(check, message, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
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

    assert.equal(await toggleSource(evaluate), true, 'Source-mode toggle button not found')
    const untouched = await waitFor(() => visibleSource(evaluate), 'Source editor did not open')
    assert.equal(untouched, source, 'A no-edit rich/source round trip changed the original Markdown')

    assert.equal(await toggleSource(evaluate), true, 'Could not return to rich mode')
    let expected = source
    let sourceSnapshots = 1
    const edits = [
      ['一级标题', 'A'],
      ['二级标题', 'B'],
      ['0', 'C'],
      ['第一项末尾', 'D'],
      ['同一个列表项中的换行', 'E'],
      ['第二项', 'F'],
      ['这一段不要修改。', 'G']
    ]

    for (const [needle, inserted] of edits) {
      assert.equal(
        await placeCaretAfter(evaluate, needle, inserted),
        true,
        `Could not place the rich-text caret after ${needle}`
      )
      await send('Input.insertText', { text: inserted })
      await sleep(350)
      expected = expected.replace(needle, `${needle}${inserted}`)

      assert.equal(await toggleSource(evaluate), true, `Could not open source mode after editing ${needle}`)
      const snapshot = await waitFor(() => visibleSource(evaluate), 'Source editor did not reopen')
      sourceSnapshots += 1
      assert.equal(
        snapshot,
        expected,
        `Rich edit near ${needle} rewrote untouched Markdown formatting`
      )
      assert.equal(await toggleSource(evaluate), true, `Could not return to rich mode after editing ${needle}`)
    }

    // Finish ten independent source snapshots: after the broad edit coverage,
    // three no-edit round trips prove that merely switching keeps the exact
    // latest source snapshot stable too.
    while (sourceSnapshots < 10) {
      assert.equal(await toggleSource(evaluate), true, 'Could not open source mode for no-edit round trip')
      const snapshot = await waitFor(() => visibleSource(evaluate), 'Source editor did not reopen')
      sourceSnapshots += 1
      assert.equal(snapshot, expected, 'A no-edit round trip changed the latest original Markdown')
      assert.equal(await toggleSource(evaluate), true, 'Could not return to rich mode after no-edit round trip')
    }

    // The user's report concerns the actual source file, not only the source
    // textarea. Save through HorseMD's visible control and compare disk bytes.
    await saveDocument(evaluate, send)
    assert.equal(
      await readFile(file, 'utf8'),
      expected,
      'Saving a rich edit rewrote untouched Markdown on disk'
    )

    // A structural list edit previously took the canonical loose-list output
    // and inserted blank lines between every existing item. Add a real item
    // with Enter and verify the authored compact `-` style survives on disk.
    assert.equal(
      await placeCaretAfter(evaluate, '第二项F', ''),
      true,
      'Could not place caret at the end of the compact list'
    )
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    })
    await send('Input.insertText', { text: '新增项' })
    await sleep(450)
    expected = expected.replace('- 第二项F', '- 第二项F\n- 新增项')
    assert.equal(await toggleSource(evaluate), true, 'Could not inspect source after adding a compact-list item')
    const listItemSource = await waitFor(() => visibleSource(evaluate), 'Source did not open after adding a list item')
    assert.equal(
      listItemSource,
      expected,
      'Adding one list item changed existing markers or inserted loose-list blank lines'
    )
    assert.equal(await toggleSource(evaluate), true, 'Could not return to rich mode after compact-list check')
    await saveDocument(evaluate, send)
    assert.equal(
      await readFile(file, 'utf8'),
      expected,
      'Saving a new list item reformatted untouched source on disk'
    )

    // Source -> rich -> source is a separate synchronization path. A source
    // edit must become the rich editor's new raw baseline without canonicalizing
    // the earlier formatting.
    assert.equal(await toggleSource(evaluate), true, 'Could not open source mode for source/rich chain')
    const sourceEditorReady = await evaluate(`(() => {
      const textarea = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
      if (!textarea) return false
      textarea.focus()
      textarea.selectionStart = textarea.value.length
      textarea.selectionEnd = textarea.value.length
      // CDP changes selectionStart directly, so it does not produce React's
      // real mouseup/select signal. Mirror the user-intent marker set by
      // EditorArea before typing, otherwise settle retries may move this
      // synthetic caret while Input.insertText is in flight.
      textarea.__horsemdSourceSelectionUser = true
      return true
    })()`)
    assert.equal(sourceEditorReady, true, 'Could not focus source editor for source/rich chain')
    await send('Input.insertText', { text: 'H' })
    expected += 'H'
    await sleep(150)
    assert.equal(await toggleSource(evaluate), true, 'Could not sync source edit into rich mode')
    assert.equal(await toggleSource(evaluate), true, 'Could not return to source mode after source/rich chain')
    const chained = await waitFor(() => visibleSource(evaluate), 'Source editor did not reopen after source/rich chain')
    assert.equal(chained, expected, 'Source -> rich -> source chain rewrote untouched Markdown formatting')

    // The same source-preservation guarantee must apply when raw Markdown is
    // pasted into rich mode. Smart paste parses it into blocks, so this is the
    // path that originally lost the clipboard's exact source spelling.
    assert.equal(await toggleSource(evaluate), true, 'Could not return to rich mode before Markdown paste')
    assert.equal(await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      editor?.focus()
      return document.activeElement === editor
    })()`), true, 'Could not focus rich editor before selecting all')
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65
    })
    const pasted = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      if (!editor) return false
      const data = new DataTransfer()
      data.setData('text/plain', ${JSON.stringify(source)})
      data.setData('text/html', '<h1>一级标题</h1><h2>二级标题</h2><p>这里是区间：0~9。</p><ul><li>第一项末尾<br>这是同一个列表项中的换行</li><li>第二项</li></ul><p>这一段不要修改。</p>')
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
      editor.dispatchEvent(event)
      return event.defaultPrevented
    })()`)
    assert.equal(pasted, true, 'Smart Markdown paste did not handle the clipboard content')
    await sleep(500)
    assert.equal(await toggleSource(evaluate), true, 'Could not open source mode after Markdown paste')
    const pastedSource = await waitFor(() => visibleSource(evaluate), 'Source editor did not reopen after Markdown paste')
    assert.equal(pastedSource, source, 'Markdown paste rewrote the clipboard source spelling')

    // Conversely, an ordinary web clipboard can also expose a Markdown-like
    // text/plain fallback. Its actual HTML semantics must still win: keeping
    // the fallback here would discard the bold mark and image on a later
    // source-mode switch.
    assert.equal(await toggleSource(evaluate), true, 'Could not return to rich mode before web paste')
    assert.equal(await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      editor?.focus()
      return document.activeElement === editor
    })()`), true, 'Could not focus rich editor before structured web paste')
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65
    })
    const webPasted = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      if (!editor) return false
      const data = new DataTransfer()
      data.setData('text/plain', '文章开头\\n1. 这不是 Markdown 列表\\n文章结尾')
      data.setData('text/html', '<h2>微信二级标题</h2><p><strong>保留加粗正文</strong></p><img alt="微信图片" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">')
      editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
      return true
    })()`)
    assert.equal(webPasted, true, 'Could not dispatch structured web paste')
    await sleep(500)
    const webRich = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return {
        heading: editor?.querySelector('h2')?.textContent || '',
        bold: editor?.querySelector('strong')?.textContent || '',
        image: !!editor?.querySelector('img[alt="微信图片"]')
      }
    })()`)
    assert.deepEqual(webRich, { heading: '微信二级标题', bold: '保留加粗正文', image: true }, 'Structured web paste lost HTML semantics')
    assert.equal(await toggleSource(evaluate), true, 'Could not inspect source after web paste')
    const webSource = await waitFor(() => visibleSource(evaluate), 'Source editor did not reopen after web paste')
    assert.ok(webSource.includes('**保留加粗正文**'), 'Web paste source lost the HTML bold mark')
    assert.ok(webSource.includes('!['), 'Web paste source lost the HTML image')

    console.log(`PASS issue 77 UI: ${sourceSnapshots} source snapshots, source/rich chain, Markdown preservation, and structured web paste semantics`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
