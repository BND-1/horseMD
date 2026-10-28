// Pandoc export with rendered figures (Typora parity: Mermaid / SVG reach
// Word, ODT, EPUB, RTF, LaTeX as images). A fake `pandoc` writes the Markdown
// it receives and the PNGs on its resource path into the output file, so the
// test sees exactly what main handed to Pandoc. Through the real menu; only
// the save dialog is answered via the main-process inspector. macOS / Linux.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-pandoc-figures-'))
const bin = join(root, 'bin')
const docDir = join(root, 'doc')
const outDir = join(root, 'out')
await fs.mkdir(bin); await fs.mkdir(join(docDir, 'img'), { recursive: true }); await fs.mkdir(outDir)
await fs.writeFile(join(docDir, 'img', 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#c0562a"/><script>alert(1)</script></svg>')
await fs.writeFile(join(docDir, 'img', 'photo.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
const doc = join(docDir, 'figures.md')
const source = [
  '# 图形', '',
  '```mermaid', 'flowchart LR', '  A[开始] --> B[结束]', '```', '',
  '```svg', '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#3b6fd6"/></svg>', '```', '',
  '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="30"><circle cx="25" cy="15" r="10" fill="#2e8b57"/></svg>', '',
  '![矢量 图](img/pic.svg "说明")', '',
  '![照片](img/photo.png)', '',
  '```mermaid', 'this is not a diagram', '```', '',
  '```js', 'const x = 1', '```', ''
].join('\n')
await fs.writeFile(doc, source)
// Fake pandoc: version / extensions, else stdin + the PNGs of the first
// resource-path folder (name, size, PNG signature, pHYs DPI).
await fs.writeFile(join(bin, 'pandoc'), `#!/bin/sh
case "$1" in
  --version) echo "pandoc 3.1.0"; exit 0;;
  --list-extensions=gfm) echo "+tex_math_dollars"; exit 0;;
esac
out=""; res=""
while [ $# -gt 0 ]; do
  case "$1" in --output) shift; out="$1";; --resource-path=*) res="\${1#--resource-path=}";; esac
  shift
done
cat > "$out"
first=\${res%%:*}
printf '\\n<<<RESOURCES %s>>>\\n' "$first" >> "$out"
for f in "$first"/*.png; do [ -f "$f" ] && printf '%s %s %s\\n' "$(basename "$f")" "$(wc -c < "$f" | tr -d ' ')" "$(head -c 8 "$f" | od -An -tx1 | tr -d ' \\n')" >> "$out"; done
exit 0
`, { mode: 0o755 })

const inspectPort = 9390 + Math.floor(Math.random() * 40)
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

const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'),
  port: 9600 + Math.floor(Math.random() * 200),
  appArgs: [doc, `--inspect=${inspectPort}`],
  env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
})
const { evaluate } = app
const waitFor = async (expression, what, ms = 30000) => {
  const start = Date.now()
  while (Date.now() - start < ms) { if (await evaluate(expression)) return; await sleep(150) }
  throw new Error(`timeout: ${what}`)
}
const exportAs = async (menuLabel, file) => {
  await mainEval(`(() => { require('electron').dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(join(outDir, file))} }); return 1 })()`)
  await mainEval(`(() => {
    const { Menu } = require('electron')
    const find = (items) => { for (const item of items) { if (item.label === ${JSON.stringify(menuLabel)}) return item; if (item.submenu) { const hit = find(item.submenu.items); if (hit) return hit } } }
    find(Menu.getApplicationMenu().items).click()
    return 1
  })()`)
  await waitFor(`/success|error/.test(document.querySelector('.hm-pandoc-status-icon')?.className || '')`, `${file} exported`)
  const status = await evaluate(`document.querySelector('.hm-pandoc-status-icon').className`)
  assert.match(status, /success/, `${file}: ${await evaluate(`document.querySelector('.hm-pandoc-status')?.innerText`)}`)
  await evaluate(`[...document.querySelectorAll('.hm-pandoc-status button')].find((b) => /关闭|Close/.test(b.textContent)).click()`)
  await sleep(200)
  const text = await fs.readFile(join(outDir, file), 'utf8')
  const [markdown, resources = ''] = text.split(/\n<<<RESOURCES /)
  const [folder, ...files] = resources.replace(/>>>\n/, '\n').trim().split('\n')
  return { markdown, folder, files: files.filter(Boolean).map((line) => line.split(' ')) }
}

try {
  await waitFor(`Boolean([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)?.textContent.includes('图形'))`, 'editor')
  await mainEval(`(() => { const { shell } = require('electron'); shell.openPath = async () => ''; shell.showItemInFolder = () => {}; return 1 })()`)

  // 1. Word: four figures become PNG images; the rest is untouched.
  const word = await exportAs('Word (.docx)…', 'word.docx')
  const images = [...word.markdown.matchAll(/!\[([^\]]*)\]\(<([^>]+)>(?: "([^"]*)")?\)/g)].map((m) => ({ alt: m[1], path: m[2], title: m[3] || '' }))
  assert.deepEqual(images.map((image) => image.path), ['horsemd-figure-001.png', 'horsemd-figure-002.png', 'horsemd-figure-003.png', 'horsemd-figure-004.png'])
  assert.deepEqual(images[3], { alt: '矢量 图', path: 'horsemd-figure-004.png', title: '说明' }, 'the .svg image keeps alt and title')
  assert.ok(!/```svg|<svg|flowchart LR|img\/pic\.svg/.test(word.markdown), 'figure sources replaced')
  assert.ok(word.markdown.includes('![照片](img/photo.png)'), 'a PNG image is untouched')
  assert.ok(word.markdown.includes('```mermaid\nthis is not a diagram\n```'), 'an invalid diagram keeps its source')
  assert.ok(word.markdown.includes('```js\nconst x = 1\n```'), 'ordinary code is untouched')
  assert.equal(word.files.length, 4, 'four PNGs on the resource path')
  for (const [name, size, head] of word.files) {
    assert.match(name, /^horsemd-figure-00\d\.png$/)
    assert.equal(head, '89504e470d0a1a0a', `${name} is a PNG`)
    assert.ok(Number(size) > 200, `${name} has content`)
  }
  assert.ok(!existsSync(word.folder), 'the temporary folder is removed after the export')

  // 2. EPUB: sized <img> (EPUB ignores PNG DPI).
  const epub = await exportAs('EPUB (.epub)…', 'book.epub')
  assert.ok(epub.markdown.includes('<img src="horsemd-figure-001.png" width="'), epub.markdown.slice(0, 300))
  assert.match(epub.markdown, /<img src="horsemd-figure-004\.png" width="120" height="60" alt="矢量 图" title="说明">/)

  // 3. LaTeX: the PNGs are kept beside the .tex, referenced relatively.
  const tex = await exportAs('LaTeX (.tex)…', 'paper.tex')
  assert.ok(tex.markdown.includes('![](<paper-figures/horsemd-figure-001.png>)'))
  const kept = await fs.readdir(join(outDir, 'paper-figures'))
  assert.deepEqual(kept.sort(), ['horsemd-figure-001.png', 'horsemd-figure-002.png', 'horsemd-figure-003.png', 'horsemd-figure-004.png'])
  const png = await fs.readFile(join(outDir, 'paper-figures', 'horsemd-figure-002.png'))
  const phys = png.indexOf(Buffer.from('pHYs'))
  assert.ok(phys > 0 && png.readUInt32BE(phys + 4) === Math.round(192 / 0.0254), 'rendered at 2× with 192 dpi')
  assert.equal(png.readUInt32BE(16), 160, 'the 80 px wide ```svg block is 160 px wide')

  // 4. MediaWiki: a text format, the source is passed as written.
  const wiki = await exportAs('MediaWiki (.wiki)…', 'page.wiki')
  assert.equal(wiki.markdown, source, 'MediaWiki gets the Markdown unchanged')
  assert.ok(!existsSync(join(outDir, 'page-figures')))

  console.log('PASS pandoc figures UI: Mermaid / ```svg / inline <svg> / .svg images go to Word, EPUB (sized <img>) and LaTeX (beside the .tex) as 2× PNGs, invalid diagrams and other content untouched, temp folder removed, MediaWiki unchanged')
} finally {
  await stopBuiltElectron(app)
  await fs.rm(root, { recursive: true, force: true })
}
