// Pandoc export success dialog: 导出完成 + the file name and its folder,
// then 打开文件 (default, Enter) / 在文件夹中显示 / 关闭. Nothing opens by
// itself; the buttons open only the file main just wrote; an open that
// fails keeps the dialog with the reason. A fake `pandoc` (shell script)
// stands in for the real one; the save dialog and shell calls are replaced
// through the main-process inspector. macOS / Linux.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-pandoc-ui-'))
const bin = join(root, 'bin')
const doc = join(root, 'note.md')
const out = join(root, 'exported', '导出 测试.docx')
await fs.mkdir(bin)
await fs.mkdir(join(root, 'exported'))
await fs.writeFile(doc, '# Pandoc\n\nInline $E=mc^2$ math.\n')
// "old" next to the script → behaves like Pandoc 2.9 (no tex_math_dollars).
await fs.writeFile(join(bin, 'pandoc'), `#!/bin/sh
dir=$(dirname "$0")
case "$1" in
  --version) if [ -f "$dir/old" ]; then echo "pandoc 2.9.2.1"; else echo "pandoc 3.1.0"; fi; exit 0;;
  --list-extensions=gfm) echo "+smart"; [ -f "$dir/old" ] || echo "+tex_math_dollars"; exit 0;;
esac
out=""
while [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then shift; out="$1"; fi; shift; done
cat > "$out"
`, { mode: 0o755 })

const inspectPort = 9350 + Math.floor(Math.random() * 40)
async function mainEval(expression) {
  const [target] = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  const reply = await new Promise((resolve) => {
    ws.addEventListener('message', (message) => { const data = JSON.parse(message.data); if (data.id === 1) resolve(data) })
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true } }))
  })
  ws.close()
  if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails))
  return reply.result?.result?.value
}

const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'),
  port: 9600 + Math.floor(Math.random() * 200),
  appArgs: [doc, `--inspect=${inspectPort}`],
  env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
})
const dialogState = () => app.evaluate(`(() => {
  const box = document.querySelector('.hm-pandoc-status')
  if (!box) return null
  return {
    title: box.querySelector('h2')?.textContent || '',
    file: box.querySelector('.hm-pandoc-file')?.textContent || '',
    dir: box.querySelector('.hm-pandoc-dir')?.textContent || '',
    warning: box.querySelector('p.warning')?.textContent || '',
    error: box.querySelector('p.error')?.textContent || '',
    buttons: [...box.querySelectorAll('.hm-pandoc-status-actions button')].map((b) => b.textContent),
    focused: document.activeElement?.closest('.hm-pandoc-status') ? document.activeElement.textContent : ''
  }
})()`)
const waitFor = async (check, what, ms = 10000) => {
  const start = Date.now()
  let state
  while (Date.now() - start < ms) { state = await dialogState(); if (check(state)) return state; await sleep(100) }
  throw new Error(`${what}: ${JSON.stringify(state)}`)
}
const calls = () => mainEval('globalThis.__hmPandocCalls.splice(0)')
const exportWord = async () => {
  const clicked = await mainEval(`(() => {
    const { Menu } = require('electron')
    const find = (items) => { for (const item of items) { if (/Word \\(\\.docx\\)/.test(item.label || '')) return item; if (item.submenu) { const hit = find(item.submenu.items); if (hit) return hit } } }
    const item = find(Menu.getApplicationMenu().items)
    item.click()
    return item.label
  })()`)
  assert.match(clicked, /Word/)
  return waitFor((s) => s && /导出完成|Export complete/.test(s.title), 'success dialog')
}
const clickButton = async (pattern) => {
  const rect = await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.hm-pandoc-status-actions button')].find((b) => ${pattern}.test(b.textContent))
    const r = button.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await app.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  }
}
// A real key press: keyDown carries the character (Enter = "\r"), which is
// what activates a focused button.
const key = async (name, code, keyCode) => {
  const text = name === 'Enter' ? '\r' : undefined
  await app.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, ...(text ? { text, unmodifiedText: text } : {}) })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })
}

try {
  for (let i = 0; i < 60; i += 1) {
    if (await app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)?.textContent.includes('Inline'))`)) break
    await sleep(200)
  }
  await mainEval(`(() => {
    const { dialog, shell } = require('electron')
    globalThis.__hmPandocCalls = []
    globalThis.__hmOpenError = ''
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(out)} })
    shell.showItemInFolder = (path) => { globalThis.__hmPandocCalls.push(['folder', path]) }
    shell.openPath = async (path) => { globalThis.__hmPandocCalls.push(['open', path]); return globalThis.__hmOpenError }
    return true
  })()`)

  // 1. The dialog: name + folder + three buttons, 打开文件 focused, nothing opened.
  let state = await exportWord()
  assert.equal(state.file, '导出 测试.docx')
  assert.ok(state.dir.includes(join(root, 'exported')), `folder line: ${state.dir}`)
  assert.deepEqual(state.buttons.map((b) => b.trim()), ['关闭', '在文件夹中显示', '打开文件'])
  assert.equal(state.focused.trim(), '打开文件', 'the default action has focus')
  assert.equal(state.warning, '', 'no warning with a current Pandoc')
  assert.deepEqual(await calls(), [], 'nothing opens before the user chooses')
  assert.equal(await fs.readFile(out, 'utf8'), '# Pandoc\n\nInline $E=mc^2$ math.\n')
  if (process.env.HM_PANDOC_UI_SHOT) {
    const shot = await app.send('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(process.env.HM_PANDOC_UI_SHOT, Buffer.from(shot.data ?? shot.result?.data, 'base64'))
  }

  // 2. 在文件夹中显示 reveals that file and closes the dialog.
  await clickButton('/在文件夹中显示/')
  await waitFor((s) => s === null, 'closed after show in folder')
  assert.deepEqual(await calls(), [['folder', out]])

  // 3. Enter on the focused default opens the file.
  await exportWord()
  await key('Enter', 'Enter', 13)
  await waitFor((s) => s === null, 'closed after open')
  assert.deepEqual(await calls(), [['open', out]])

  // 4. An open that fails keeps the dialog with the reason; Esc closes it.
  await exportWord()
  await mainEval(`globalThis.__hmOpenError = 'No application is associated with the specified file'`)
  await clickButton('/打开文件/')
  state = await waitFor((s) => s?.error, 'open error shown')
  assert.match(state.error, /无法打开这个文件：No application is associated/)
  assert.deepEqual(await calls(), [['open', out]])
  await key('Escape', 'Escape', 27)
  await waitFor((s) => s === null, 'Esc closes')
  await mainEval(`globalThis.__hmOpenError = ''`)

  // 5. The file was moved away before the click: said so, nothing opened.
  await exportWord()
  await fs.rm(out)
  await clickButton('/打开文件/')
  state = await waitFor((s) => s?.error, 'missing file shown')
  assert.match(state.error, /不在原位置/)
  assert.deepEqual(await calls(), [])
  await clickButton('/关闭/')
  await waitFor((s) => s === null, 'closed')

  // 6. An old Pandoc: the same dialog plus the formula hint.
  await fs.writeFile(join(bin, 'old'), '')
  state = await exportWord()
  assert.match(state.warning, /Pandoc 2\.9\.2\.1 版本较旧/)
  assert.equal(state.buttons.length, 3)
  await key('Escape', 'Escape', 27)
  await waitFor((s) => s === null, 'Esc closes')
  console.log('PASS pandoc export UI: success dialog with file + folder, open file (default) / show in folder / close, nothing opens by itself, failed or missing opens explained, old-Pandoc hint')
} finally {
  await stopBuiltElectron(app)
  await fs.rm(root, { recursive: true, force: true })
}
