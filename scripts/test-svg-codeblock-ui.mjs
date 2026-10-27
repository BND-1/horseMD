// ```svg code blocks (#166): the block shows the picture by default (an <img>
// of the SVG, like inline SVG #162: no script, own size, scaled down only),
// with a 图 | 代码 switch next to Copy. The switch is view-only (never dirty,
// works in reading mode); saving keeps the block's bytes; the lightbox opens
// on double-click; PDF/HTML export the picture, not the code. Mermaid keeps
// its own preview toggle.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { chooseContextExportFormat } from './lib/context-menu.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const root = await mkdtemp(join(tmpdir(), 'horsemd-svg-codeblock-'))
const source = [
  '# SVG 代码块', '',
  '第一段文字。', '',
  '```svg',
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#ff0000"/></svg>',
  '```', '',
  '```svg',
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">',
  '  <rect x="0" y="0" width="400" height="200" fill="#0000ff"/>',
  '  <text x="20" y="100" font-size="24" fill="#fff">SvgCodeLabel</text>',
  '  <script>window.__svgCodeScriptRan = true</script>',
  '</svg>',
  '```', '',
  '```mermaid',
  'graph TD',
  '  A --> B',
  '```', '',
  '最后一段。', ''
].join('\n')
const file = join(root, 'doc.md')
await writeFile(file, source)

const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), port: 29890 + process.pid % 40, appArgs: [file, '--horsemd-input-trace']
})
const send = app.send.bind(app)
const waitFor = async (check, message, attempts = 100) => {
  for (let i = 0; i < attempts; i += 1) { const value = await check(); if (value) return value; await sleep(100) }
  throw new Error(message)
}
const click = async (point, clickCount = 1) => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount, ...point })
}
const blocks = `[...(${editor}).querySelectorAll('.milkdown-code-block')]`
const svgState = () => app.evaluate(`${blocks}.slice(0, 2).map((b) => {
  const img = b.querySelector('.preview img.hm-svg-code-image')
  const panel = b.querySelector('.preview-panel')
  return {
    svgClass: b.classList.contains('hm-svg-code-block'),
    switchTexts: [...b.querySelectorAll('.hm-svg-mode > button')].map((x) => x.textContent),
    pressed: b.querySelector('.hm-svg-mode > button[aria-pressed="true"]')?.dataset.mode || null,
    codeHidden: Boolean(b.querySelector('.codemirror-host.hidden')),
    previewShown: Boolean(panel && panel.offsetParent),
    crepeToggleShown: Boolean(b.querySelector('.preview-toggle-button')?.offsetParent),
    img: img ? { w: Math.round(img.getBoundingClientRect().width), h: Math.round(img.getBoundingClientRect().height), done: img.complete && img.naturalWidth > 0, src: img.getAttribute('src') } : null,
    code: b.querySelector('.cm-content')?.innerText || ''
  }
})`)
const dirty = () => app.evaluate(`Boolean(document.querySelector('.status-dot.mod'))`)
const switchAt = (index, mode) => app.evaluate(`(() => {
  const b = ${blocks}[${index}]
  b.scrollIntoView({ block: 'center' })
  const r = b.querySelector('.hm-svg-mode > button[data-mode="${mode}"]').getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`)
const pressSwitch = async (index, mode) => {
  const at = await switchAt(index, mode)
  await sleep(150)
  await click(await switchAt(index, mode) || at)
}
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

  // 1. Picture by default, at its own size; the script never runs.
  const first = await waitFor(async () => {
    const s = await svgState()
    return s.length === 2 && s.every((b) => b.img?.done && b.switchTexts.length === 2) && s
  }, 'SVG code blocks did not render a preview', 150)
  for (const b of first) {
    assert.equal(b.svgClass, true)
    assert.deepEqual(b.switchTexts, ['图', '代码'])
    assert.equal(b.pressed, 'image')
    assert.equal(b.codeHidden, true, 'code shown in 图 mode')
    assert.equal(b.previewShown, true)
    assert.equal(b.crepeToggleShown, false, "Crepe's own preview toggle shown on an svg block")
    assert.match(b.img.src, /^data:image\/svg\+xml/)
    assert.doesNotMatch(decodeURIComponent(b.img.src), /<script/i, 'script kept in the image')
  }
  assert.deepEqual([first[0].img.w, first[0].img.h], [100, 100], `a 100×100 SVG was resized: ${JSON.stringify(first[0].img)}`)
  const editorWidth = await app.evaluate(`Math.round((${editor}).getBoundingClientRect().width)`)
  assert.equal(first[1].img.w, Math.min(400, first[1].img.w), `viewBox-only SVG grew past its viewBox: ${first[1].img.w}`)
  assert.ok(first[1].img.w === 400 || first[1].img.w <= editorWidth, `viewBox-only SVG width ${first[1].img.w}`)
  assert.equal(Math.round(first[1].img.w / 2), first[1].img.h, 'aspect ratio lost')
  assert.equal(await app.evaluate('window.__svgCodeScriptRan === true'), false, 'script in the SVG ran')
  // Mermaid keeps Crepe's toggle and gets no 图/代码 switch.
  const mermaid = await waitFor(() => app.evaluate(`(() => { const b = ${blocks}[2]; return b.querySelector('.preview svg') ? { svgSwitch: Boolean(b.querySelector('.hm-svg-mode')), crepeToggle: Boolean(b.querySelector('.preview-toggle-button')) } : null })()`), 'Mermaid did not render', 150)
  assert.deepEqual(mermaid, { svgSwitch: false, crepeToggle: true })
  console.log('ok   picture by default at its own size; script dropped; Mermaid keeps its toggle')

  // 2. 代码 shows the code (no picture), 图 brings the picture back; not dirty.
  await pressSwitch(1, 'code')
  const coded = await waitFor(async () => { const s = (await svgState())[1]; return s.pressed === 'code' && !s.codeHidden && s }, '代码 did not show the code')
  assert.equal(coded.previewShown, false, 'picture still shown in 代码 mode')
  assert.match(coded.code, /SvgCodeLabel/)
  assert.equal((await svgState())[0].pressed, 'image', 'the other block switched too')
  await pressSwitch(1, 'image')
  await waitFor(async () => { const s = (await svgState())[1]; return s.pressed === 'image' && s.codeHidden && s.previewShown }, '图 did not bring the picture back')
  assert.equal(await dirty(), false, 'switching made the document dirty')
  console.log('ok   图 / 代码 switch per block, view-only')

  // 3. Double-click the picture: the SVG lightbox.
  const at = await app.evaluate(`(() => { const i = ${blocks}[1].querySelector('.preview img'); i.scrollIntoView({ block: 'center' }); const r = i.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  await sleep(200)
  await click(at, 1)
  await sleep(80)
  await click(at, 2)
  const box = await waitFor(() => app.evaluate(`(() => { const i = document.querySelector('.hm-image-lightbox img'); return i ? { vector: i.classList.contains('hm-lightbox-vector') } : null })()`), 'lightbox did not open')
  assert.equal(box.vector, true)
  await pressKey(send, { key: 'Escape' })
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-image-lightbox')`), 'lightbox did not close')
  console.log('ok   double-click opens the SVG lightbox')

  // 4. Reading mode: the switch still works and edits nothing.
  await app.evaluate(`document.querySelector('.hm-reading-btn')?.click()`)
  await waitFor(() => app.evaluate(`(${editor})?.contentEditable === 'false'`), 'reading mode did not start')
  await pressSwitch(0, 'code')
  await waitFor(async () => (await svgState())[0].pressed === 'code', '代码 did not work in reading mode')
  await pressSwitch(0, 'image')
  await waitFor(async () => (await svgState())[0].pressed === 'image', '图 did not work in reading mode')
  assert.equal(await dirty(), false, 'switching in reading mode made the document dirty')
  await app.evaluate(`document.querySelector('.hm-reading-btn')?.click()`)
  await waitFor(() => app.evaluate(`(${editor})?.contentEditable === 'true'`), 'reading mode did not end')
  console.log('ok   the switch works in reading mode without editing')

  // 5. Typing elsewhere and saving keeps the code blocks' bytes.
  const para = await app.evaluate(`(() => { const p = [...(${editor}).querySelectorAll('p')].find(n => n.textContent.includes('第一段文字')); p.scrollIntoView({ block: 'center' }); const r = p.getBoundingClientRect(); return { x: r.right - 2, y: r.top + r.height / 2 } })()`)
  await sleep(200)
  await click(para)
  await sleep(200)
  await pressKey(send, { key: 'End' })
  await typeTextLikeUser(send, '加字')
  await sleep(800)
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  const expected = source.replace('第一段文字。', '第一段文字。加字')
  const saved = await waitFor(async () => { const t = await readFile(file, 'utf8'); return t.includes('加字') && t }, 'edit not saved')
  assert.equal(saved, expected, `bytes changed: ${JSON.stringify(saved)}`)
  console.log('ok   saving keeps the svg code blocks byte for byte')

  // 6. HTML export: both blocks are pictures, no SVG source as code.
  const tabAt = await app.evaluate(`(() => { const r = (document.querySelector('.tab.active') || document.querySelector('.tab')).getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } })()`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'right', clickCount: 1, ...tabAt })
  await chooseContextExportFormat(app.evaluate, 'HTML')
  const html = await waitFor(() => app.evaluate(`[...document.querySelectorAll('iframe')].map(f => f.getAttribute('srcdoc') || '').find(s => s.includes('最后一段')) || null`), 'HTML preview did not render', 200)
  const svgImages = html.match(/<img[^>]*src="data:image\/svg\+xml[^"]*"[^>]*>/g) || []
  assert.equal(svgImages.length, 2, `HTML export SVG images: ${svgImages.length}`)
  assert.ok(svgImages.some((tag) => /width:\s*100px/.test(tag)), 'the 100px SVG lost its size in the export')
  assert.doesNotMatch(html, /&lt;svg/, 'SVG source exported as code')
  assert.doesNotMatch(html, /__svgCodeScriptRan/, 'script text exported')
  console.log('ok   HTML export shows the pictures')

  const toasts = await app.evaluate('window.__toasts.slice()')
  assert.equal(toasts.some((t) => warningPattern.test(t)), false, `warning: ${JSON.stringify(toasts)}`)
  assert.deepEqual(await app.evaluate('(globalThis.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).map(e => e.preservationReason)'), [])
} catch (error) {
  failed = true
  console.log(`FAIL ${String(error?.message || error).slice(0, 1500)}`)
  console.log('DIAGNOSTIC', JSON.stringify(await svgState().catch((e) => String(e))).slice(0, 3000))
} finally {
  await stopBuiltElectron(app)
  await rm(root, { recursive: true, force: true })
}
console.log(failed ? 'FAIL svg codeblock' : 'PASS svg codeblock: ```svg shows its picture at its own size with a 图/代码 switch, view-only, bytes kept, lightbox, exported as a picture')
process.exit(failed ? 1 : 0)
