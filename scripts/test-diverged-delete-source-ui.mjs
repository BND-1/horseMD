import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-diverged-delete-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10010)
const sleepMs = (ms) => sleep(ms)

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleepMs(100)
  }
  throw new Error(message)
}

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const selectRichRange = (evaluate, start, end) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  if (!editor) return 'NO-EDITOR'
  editor.focus()
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  const find = (needle, atEnd) => {
    for (const node of nodes) {
      const index = node.nodeValue.indexOf(needle)
      if (index < 0) continue
      return { node, index: atEnd ? index + needle.length : index }
    }
    return null
  }
  const s = find(${JSON.stringify(start)}, false)
  const e = find(${JSON.stringify(end)}, true)
  if (!s || !e) return 'NO-SELECT'
  const range = document.createRange()
  range.setStart(s.node, s.index)
  range.setEnd(e.node, e.index)
  const sel = getSelection()
  sel.removeAllRanges(); sel.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return sel.toString()
})()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file]
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
    'editor did not open'
  )
  await sleepMs(800)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  // The authored line keeps a mid-line `* ` as paragraph text, but the
  // canonical serializer escapes it (`\*`). Deleting the bold text must still
  // reach the authored source: otherwise the deletion silently resurrects
  // after save and the user's file grows the deleted content back.
  await writeFile(file, '# 测试\n\n前段。* **输入设备：** 内容\n\n第二段保留。\n')
  let app
  try {
    app = await openApp('edit', port)
    assert.equal(
      await selectRichRange(app.evaluate, '输入设备', '内容'),
      '输入设备： 内容',
      'could not select the bold text inside the diverged paragraph'
    )
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await sleepMs(700)

    assert.equal(await toggleSource(app.evaluate), true, 'could not switch to source mode')
    const raw = await waitFor(() => visibleSource(app.evaluate), 'source textarea did not appear')
    assert.equal(
      raw.includes('输入设备'),
      false,
      'a rich-text deletion must vanish from source even when the visible stream diverges'
    )
    assert.equal(
      raw,
      '# 测试\n\n前段。* \n\n第二段保留。\n',
      'the authored literal `*` spelling must survive the diverged deletion'
    )

    // Back to rich, save, and verify the deletion is durable on disk.
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch back to rich mode')
    await sleepMs(500)
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    const saved = await readFile(file, 'utf8')
    assert.equal(
      saved,
      '# 测试\n\n前段。* \n\n第二段保留。\n',
      'saving must persist the rich-text deletion instead of resurrecting it'
    )

    // Full reopen: the file must stay byte-identical and render the deletion.
    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    const rich = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return editor?.textContent.includes('输入设备') ? 'STILL-THERE' : 'DELETED'
    })()`)
    assert.equal(rich, 'DELETED', 'the reopened document must not show the deleted text')
    assert.equal(await toggleSource(app.evaluate), true, 'could not inspect source after reopen')
    const reopened = await waitFor(() => visibleSource(app.evaluate), 'source textarea did not appear after reopen')
    assert.equal(
      reopened,
      '# 测试\n\n前段。* \n\n第二段保留。\n',
      'full reopen must not normalize or resurrect the diverged paragraph'
    )

    console.log('PASS diverged delete source sync: deletion survives mode switch, save, and full reopen')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
