// SVG in documents (#162): `![](x.svg)` keeps loading like any image, and
// inline `<svg>…</svg>` HTML renders as a picture (an <img> of the same
// markup: no script, ids and <style> stay inside each SVG) instead of escaped
// source. The source bytes never change; the lightbox opens it fitted to the
// window; PDF keeps it vector (its text is PDF text) and the HTML export
// embeds it, with an inline icon staying in its line.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { chooseContextExportFormat } from './lib/context-menu.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const root = await mkdtemp(join(tmpdir(), 'horsemd-svg-render-'))
await mkdir(join(root, 'assets'))
await writeFile(join(root, 'assets', 'arch.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect x="10" y="30" width="80" height="40" rx="8" fill="#4F8CFF"/></svg>')
// Two diagrams that both name their gradient "g": as live DOM the second
// would paint with the first one's colours.
const diagram = (color, label) => [
  '<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">',
  `  <defs><linearGradient id="g"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color}"/></linearGradient></defs>`,
  '  <rect x="0" y="0" width="200" height="100" fill="url(#g)"/>',
  '  <rect x="110" y="30" width="80" height="40" rx="8" fill="#7BC67E" stroke="#333" stroke-width="2"/>',
  `  <text x="50" y="55" font-size="14" fill="#000">${label}</text>`,
  '  <script>window.__svgScriptRan = true</script>',
  '</svg>'
]
const source = [
  '# SVG', '',
  '第一段文字。', '',
  '![架构图](./assets/arch.svg)', '',
  ...diagram('#ff0000', 'SvgPdfLabel'), '',
  ...diagram('#0000ff', 'Second'), '',
  '行内 <svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="orange"/></svg> 图标。', '',
  '最后一段。', ''
].join('\n')
const file = join(root, 'doc.md')
await writeFile(file, source)

const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), port: 29850 + process.pid % 40, appArgs: [file, '--horsemd-input-trace']
})
const send = app.send.bind(app)
const waitFor = async (check, message, attempts = 100) => {
  for (let i = 0; i < attempts; i += 1) { const value = await check(); if (value) return value; await sleep(100) }
  throw new Error(message)
}
const click = async (point, clickCount = 1) => {
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount, ...point })
}
const toggleSource = () => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)
const visibleSource = () => app.evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null`)
let failed = false
try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('最后一段')`), 'document did not open')
  await app.evaluate(`(() => {
    window.__toasts = []
    const seen = new WeakSet()
    new MutationObserver(() => {
      for (const node of document.querySelectorAll('.hm-toast-msg')) if (!seen.has(node)) { seen.add(node); window.__toasts.push(node.textContent) }
    }).observe(document.body, { childList: true, subtree: true })
  })()`)

  // 1. Render. Pixel colours read back from each image prove the two "g"
  // gradients stay separate.
  const rendered = await waitFor(() => app.evaluate(`(() => {
    const ed = ${editor}
    const file = ed.querySelector('.milkdown-image-block img')
    const svgs = [...ed.querySelectorAll('.hm-html-svg img')]
    if (!file?.complete || !file.naturalWidth || svgs.length !== 3 || svgs.some(i => !i.complete || !i.naturalWidth)) return null
    const pixel = (img) => {
      const c = document.createElement('canvas'); c.width = 200; c.height = 100
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, 200, 100)
      return [...g.getImageData(5, 5, 1, 1).data].slice(0, 3)
    }
    const icon = svgs[2], iconRect = icon.getBoundingClientRect(), line = icon.closest('p').getBoundingClientRect()
    return {
      fileSrc: file.getAttribute('src'),
      blocks: svgs.slice(0, 2).map(i => ({ block: i.parentElement.classList.contains('hm-html-svg-block'), width: Math.round(i.getBoundingClientRect().width), src: i.src })),
      colors: svgs.slice(0, 2).map(pixel),
      icon: { block: icon.parentElement.classList.contains('hm-html-svg-block'), w: Math.round(iconRect.width), inLine: iconRect.top >= line.top - 1 && iconRect.bottom <= line.bottom + 1, lineH: Math.round(line.height) },
      escapedText: ed.textContent.includes('<svg') || ed.textContent.includes('linearGradient'),
      scriptRan: window.__svgScriptRan === true,
      editorWidth: Math.round(ed.getBoundingClientRect().width)
    }
  })()`), 'SVG images did not render', 150)
  assert.match(rendered.fileSrc, /^file:\/\/.*\/assets\/arch\.svg$/)
  assert.deepEqual(rendered.blocks.map(b => b.block), [true, true])
  for (const b of rendered.blocks) {
    assert.match(b.src, /^data:image\/svg\+xml/)
    assert.doesNotMatch(decodeURIComponent(b.src), /<script/i, 'script kept in the image')
    assert.ok(b.width > 400, `an SVG without width fills the line: ${b.width}px`)
  }
  assert.deepEqual(rendered.colors, [[255, 0, 0], [0, 0, 255]], `gradient ids leaked: ${JSON.stringify(rendered.colors)}`)
  assert.equal(rendered.icon.block, false)
  assert.equal(rendered.icon.w, 20)
  assert.equal(rendered.icon.inLine, true, `icon left its line: ${JSON.stringify(rendered.icon)}`)
  assert.equal(rendered.escapedText, false, 'SVG source shown as text')
  assert.equal(rendered.scriptRan, false)
  console.log('ok   .svg file and inline <svg> render; ids isolated; script dropped; icon stays inline')

  // 2. Lightbox: double-click opens the SVG fitted to the window.
  const at = await app.evaluate(`(() => { const i = (${editor}).querySelectorAll('.hm-html-svg img')[0]; i.scrollIntoView({ block: 'center' }); const r = i.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  await sleep(200)
  await click(at, 1)
  await sleep(80)
  await click(at, 2)
  const box = await waitFor(() => app.evaluate(`(() => { const i = document.querySelector('.hm-image-lightbox img'); if (!i) return null; const r = i.getBoundingClientRect(); return { vector: i.classList.contains('hm-lightbox-vector'), w: Math.round(r.width), vw: innerWidth } })()`), 'lightbox did not open')
  assert.equal(box.vector, true)
  assert.ok(box.w > box.vw * 0.8, `lightbox SVG is not fitted: ${JSON.stringify(box)}`)
  await pressKey(send, { key: 'Escape' })
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-image-lightbox')`), 'lightbox did not close')
  console.log('ok   double-click opens the SVG lightbox fitted to the window')

  // 3. Typing next to the SVGs keeps every authored byte.
  const para = await app.evaluate(`(() => { const p = [...(${editor}).querySelectorAll('p')].find(n => n.textContent.includes('第一段文字')); p.scrollIntoView({ block: 'center' }); const r = p.getBoundingClientRect(); return { x: r.right - 2, y: r.top + r.height / 2 } })()`)
  await sleep(200)
  await click(para)
  await sleep(200)
  await pressKey(send, { key: 'End' })
  await typeTextLikeUser(send, '加字')
  const last = await app.evaluate(`(() => { const p = [...(${editor}).querySelectorAll('p')].find(n => n.textContent.includes('行内')); p.scrollIntoView({ block: 'center' }); const r = p.getBoundingClientRect(); return { x: r.right - 2, y: r.top + r.height / 2 } })()`)
  await sleep(200)
  await click(last)
  await sleep(200)
  await pressKey(send, { key: 'End' })
  await typeTextLikeUser(send, '尾')
  await sleep(800)
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  const expected = source.replace('第一段文字。', '第一段文字。加字').replace('图标。', '图标。尾')
  const saved = await waitFor(async () => { const t = await readFile(file, 'utf8'); return t.includes('图标。尾') && t }, 'edit not saved')
  assert.equal(saved, expected, `bytes changed: ${JSON.stringify(saved)}`)
  console.log('ok   editing beside SVGs keeps their source bytes')

  // 4. Source mode shows the authored SVG; switching back renders it again.
  assert.equal(await toggleSource(), true, 'source toggle missing')
  const shown = await waitFor(visibleSource, 'source textarea did not open')
  assert.equal(shown, expected, 'source mode changed the SVG text')
  await toggleSource()
  await waitFor(() => app.evaluate(`(${editor})?.querySelectorAll('.hm-html-svg img').length === 3`), 'SVG not rendered after source mode')
  console.log('ok   source mode keeps the SVG source')

  // 5. PDF: the SVG stays vector — its <text> is PDF text.
  await app.evaluate(`window.__HORSEMD_TEST_CAPTURE_PDF__ = true; window.__HORSEMD_TEST_CAPTURE_PDF_DATA__ = true; window.__horsemdLastPdfPreview = null; window.__horsemdLastPdfPreviewData = null`)
  const tabAt = await app.evaluate(`(() => { const r = (document.querySelector('.tab.active') || document.querySelector('.tab')).getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } })()`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'right', clickCount: 1, ...tabAt })
  await chooseContextExportFormat(app.evaluate, 'PDF')
  await waitFor(() => app.evaluate('window.__horsemdLastPdfPreview?.result?.ok === true'), 'PDF preview did not complete', 200)
  const bytes = await waitFor(async () => { const d = await app.evaluate('Array.from(window.__horsemdLastPdfPreviewData || [])'); return d.length > 1000 && d }, 'PDF bytes were not captured')
  const pdf = await getDocument({ data: Uint8Array.from(bytes) }).promise
  let pdfText = ''
  for (let n = 1; n <= pdf.numPages; n += 1) pdfText += (await (await pdf.getPage(n)).getTextContent()).items.map(i => i.str).join(' ')
  await pdf.destroy()
  assert.match(pdfText, /SvgPdfLabel/, 'SVG text missing from the PDF (rasterised or dropped)')
  await pressKey(send, { key: 'Escape' })
  await sleep(500)
  console.log('ok   PDF export keeps the SVG as vector')

  // 6. HTML export embeds the images; the icon keeps its inline style.
  await waitFor(() => app.evaluate(`!document.querySelector('.pdf-studio, .hm-pdf-studio')`), 'PDF studio did not close', 30).catch(() => {})
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'right', clickCount: 1, ...tabAt })
  await chooseContextExportFormat(app.evaluate, 'HTML')
  const html = await waitFor(() => app.evaluate(`[...document.querySelectorAll('iframe')].map(f => f.getAttribute('srcdoc') || '').find(s => s.includes('SvgPdfLabel') || s.includes('svg%2Bxml') || s.includes('svg+xml')) || null`), 'HTML preview did not render', 200)
  const svgImages = html.match(/<img[^>]*src="data:image\/svg\+xml[^"]*"[^>]*>/g) || []
  // The three inline ones plus assets/arch.svg, which the export embeds too.
  assert.equal(svgImages.length, 4, `HTML export SVG images: ${svgImages.length}`)
  assert.ok(svgImages.some(tag => /display:\s*inline-block/.test(tag)), 'inline icon lost its inline style in HTML')
  assert.doesNotMatch(html, /__svgScriptRan/, 'script text exported')
  console.log('ok   HTML export embeds the SVGs')

  const toasts = await app.evaluate('window.__toasts.slice()')
  assert.equal(toasts.some((t) => warningPattern.test(t)), false, `warning: ${JSON.stringify(toasts)}`)
  assert.deepEqual(await app.evaluate('(globalThis.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).map(e => e.preservationReason)'), [])
} catch (error) {
  failed = true
  console.log(`FAIL ${String(error?.message || error).slice(0, 1500)}`)
  console.log('DIAGNOSTIC', JSON.stringify(await app.evaluate(`({
    toasts: window.__toasts,
    blocks: [...(${editor})?.children || []].map(n => n.tagName + '.' + n.className + ':' + n.textContent.slice(0, 30))
  })`).catch((e) => String(e))).slice(0, 3000))
} finally {
  await stopBuiltElectron(app)
  await rm(root, { recursive: true, force: true })
}
console.log(failed ? 'FAIL svg render' : 'PASS svg render: .svg files and inline <svg> render as images, bytes kept, lightbox, vector PDF, HTML export')
process.exit(failed ? 1 : 0)
