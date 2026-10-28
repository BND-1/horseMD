// PDF / HTML export keep what the editor shows (2026-10-27 review):
// - an image's caption was exported as its editor <input> (a text box under
//   every image with alt text) → <figure> + <figcaption>, no input;
// - HTML export put every code line on one line (no .hm-code-line rules in
//   its template) → one row per line, with the gutter;
// - code blocks lost their syntax colours → the editor's oneDark colours;
// - HTML block math was left-aligned → display: block math, centred.
// Through the real UI: right-click the tab → 导出 → PDF / 网页; the HTML
// file is the one saved (save dialog answered via the inspector).
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { chooseContextExportFormat } from './lib/context-menu.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-export-fidelity-'))
const docDir = join(root, 'doc')
await fs.mkdir(join(docDir, 'img'), { recursive: true })
await fs.writeFile(join(docDir, 'img', 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#c0562a"/></svg>')
const doc = join(docDir, 'fidelity.md')
await fs.writeFile(doc, [
  '# 导出', '',
  '![图片说明文字](img/pic.svg)', '',
  '```javascript', '// 注释', 'function sum(items) {', '  return items.length', '}', '```', '',
  '$$', 'x^2', '$$', ''
].join('\n'))

const inspectPort = 9430 + Math.floor(Math.random() * 40)
async function mainEval(expression) {
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

const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port: 9600 + Math.floor(Math.random() * 200), appArgs: [doc, `--inspect=${inspectPort}`] })
const { send, evaluate } = app
const waitFor = async (expression, what, ms = 60000) => {
  const start = Date.now()
  while (Date.now() - start < ms) { if (await evaluate(expression)) return; await sleep(200) }
  throw new Error(`timeout: ${what}`)
}
const openExport = async (label) => {
  const point = await evaluate(`(() => { const t = [...document.querySelectorAll('.tab')].find((n) => n.offsetParent && /fidelity/.test(n.textContent)); const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'right', clickCount: 1 })
  await sleep(300)
  await chooseContextExportFormat(evaluate, label)
}
// Shared by both formats: the snapshot's figure, code rows and colours.
const checkSnapshot = (html, where) => {
  assert.ok(!/<input/i.test(html), `${where}: no <input> (the caption box)`)
  assert.match(html, /<figure><img [^>]*><figcaption>图片说明文字<\/figcaption><\/figure>/, `${where}: image + caption as figure`)
  const rows = html.match(/class="hm-code-line"/g) || []
  assert.equal(rows.length, 4, `${where}: one row per code line`)
  assert.match(html, /<span style="color:#c678dd">function<\/span>/, `${where}: keyword coloured like the editor`)
  assert.match(html, /<span style="color:#7d8799[^"]*">\/\/ 注释<\/span>/, `${where}: comment coloured`)
  assert.match(html, /<span style="color:#61afef">sum<\/span>/, `${where}: function name coloured`)
}

try {
  await waitFor(`Boolean([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)?.textContent.includes('导出'))`, 'editor')
  await sleep(1200)
  await mainEval(`(() => { const { dialog, shell } = require('electron'); const path = require('path'); dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: path.join(${JSON.stringify(root)}, path.basename((o || _w).defaultPath)) }); shell.openPath = async () => ''; return 1 })()`)
  await evaluate('window.__HORSEMD_TEST_CAPTURE_PDF__ = true')

  // PDF: the preview's snapshot.
  await openExport('PDF')
  await waitFor(`window.__horsemdLastPdfPreview?.result?.ok === true`, 'PDF preview')
  checkSnapshot(await evaluate('window.__horsemdLastPdfPreview.source.html'), 'PDF')
  await evaluate(`document.querySelector('.hm-pdf-studio .hm-pdf-close').click()`)
  await waitFor(`!document.querySelector('.hm-pdf-studio')`, 'PDF studio closed')

  // HTML: the saved file, with its template rules.
  await openExport('网页')
  await waitFor(`Boolean(document.querySelector('.hm-html-studio footer button.primary:not(:disabled)'))`, 'HTML preview')
  await evaluate(`document.querySelector('.hm-html-studio footer button.primary').click()`)
  await waitFor(`!document.querySelector('.hm-html-studio')`, 'HTML saved')
  const html = await fs.readFile(join(root, 'fidelity.html'), 'utf8')
  checkSnapshot(html, 'HTML')
  assert.match(html, /\.hm-code-line\{display:block/, 'HTML template lays code out one row per line')
  assert.match(html, /figcaption\{/, 'HTML template styles captions')
  assert.match(html, /math\[display="block"\]\{display:block;display:block math;text-align:center/, 'HTML block math is centred')
  assert.match(html, /<math[^>]*display="block"/, 'block math exported as MathML')

  console.log('PASS export fidelity UI: PDF / HTML keep image captions as <figcaption> (no input box), code one row per line with the editor\'s syntax colours, centred block math')
} finally {
  await stopBuiltElectron(app)
  await fs.rm(root, { recursive: true, force: true })
}
