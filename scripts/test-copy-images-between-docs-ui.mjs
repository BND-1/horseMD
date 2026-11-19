// Copying content with local images from one document to a document in
// another folder: the clipboard carried `assets/p.png`, which the target read
// against its own folder, so every image broke (user report 2026-11-19).
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

// A tiny valid PNG of the given colour (so naturalWidth proves it loaded).
function png(r, g, b) {
  const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(3, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.from([0, r, g, b, r, g, b, r, g, b])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))])
}

const root = await mkdtemp(join(tmpdir(), 'horsemd-copy-images-'))
const dir = (name) => join(root, name)
for (const d of ['A/assets', 'A/pics sub', 'B', 'E', 'F']) await mkdir(dir(d), { recursive: true })
const RED = png(255, 0, 0), BLUE = png(0, 0, 255)
await writeFile(join(dir('A'), 'assets', 'p.png'), RED)
await writeFile(join(dir('A'), 'pics sub', 'q r.png'), BLUE)
const SOURCE_A = ['# Alpha', '', '![red](assets/p.png)', '', 'text with ![blue](<pics sub/q r.png>) inline', '', 'end A', ''].join('\n')
const files = {
  a: join(dir('A'), 'a.md'), c: join(dir('A'), 'c.md'), b: join(dir('B'), 'b.md'),
  e: join(dir('E'), 'e.md'), f: join(dir('F'), 'f.md')
}
await writeFile(files.a, SOURCE_A)
await writeFile(files.c, '# Gamma\n\nend C\n')
await writeFile(files.b, '# Beta\n\nend B\n')
await writeFile(files.e, '# Epsilon\n\nend E\n')
await writeFile(files.f, '# Zeta\n\nend F\n')

const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port: 28900 + process.pid % 300, appArgs: [...Object.values(files), '--horsemd-input-trace']
})
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const textarea = "[...document.querySelectorAll('textarea.source-editor')].find(e => e.offsetParent)"
const waitFor = async (fn, label, tries = 100) => {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(80) }
  throw new Error(label)
}
const MOD = process.platform === 'darwin' ? 4 : 2
const key = async (k, code, mods = 0, commands) => {
  for (const type of ['rawKeyDown', 'keyUp']) await app.send('Input.dispatchKeyEvent', {
    type, key: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
    modifiers: mods, ...(commands && type === 'rawKeyDown' ? { commands } : {})
  })
  await sleep(120)
}
const copy = () => key('c', 67, MOD, ['copy'])
const cut = () => key('x', 88, MOD, ['cut'])
const paste = () => key('v', 86, MOD, ['paste'])
const openTab = async (name, marker) => {
  await app.evaluate(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.includes(${JSON.stringify(name)})).click()`)
  await waitFor(() => app.evaluate(`((${editor})?.textContent || (${textarea})?.value || '').includes(${JSON.stringify(marker)})`), `tab ${name} did not show`)
  await sleep(400)
}
const caretAfter = async (text) => {
  await app.evaluate(`(() => { const p = [...(${editor}).querySelectorAll('p')].find(n => n.textContent === ${JSON.stringify(text)}); (${editor}).focus(); const t = p.lastChild; getSelection().setBaseAndExtent(t, t.length, t, t.length) })()`)
  await sleep(150)
  await key('Enter', 13)
}
const images = () => app.evaluate(`[...(${editor}).querySelectorAll('img')].map(i => ({ src: i.getAttribute('src'), w: i.naturalWidth }))`)
const imagesLoad = (count, label) => waitFor(async () => {
  const im = await images(); return im.length === count && im.every((i) => i.w === 3) ? im : null
}, label, 150).catch(async (e) => { console.log(JSON.stringify(await images())); throw e })
const save = async (file, marker) => {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), `${file} did not turn dirty`)
  await app.evaluate(`document.querySelector('.hm-save-fab').click()`)
  return waitFor(async () => { const t = await readFile(file, 'utf8'); return t.includes(marker) ? t : null }, `${file} was not saved`)
}
const toggleSource = () => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(n.title || n.textContent || ''))
  button?.click(); return Boolean(button)
})()`)
const assets = async (d) => (await readdir(join(dir(d), 'assets')).catch(() => [])).sort()
const PASTED_B = ['# Alpha', '', '![red](assets/p.png)', '', 'text with ![blue](<assets/q r.png>) inline', '', 'end A'].join('\n')
const results = {}
try {
  await waitFor(() => app.evaluate(`document.querySelectorAll('.tab').length >= 5`), 'tabs did not open')

  // 1. Whole document A (rich) → B in another folder.
  await openTab('a.md', 'end A')
  await imagesLoad(2, 'A images did not load')
  await app.evaluate(`(${editor}).focus()`)
  await key('a', 65, MOD, ['selectAll'])
  await copy()
  await openTab('b.md', 'end B')
  await caretAfter('end B')
  await paste()
  results.b = await imagesLoad(2, 'B: pasted images did not load')
  const savedB = await save(files.b, 'Alpha')
  assert.equal(savedB, `# Beta\n\nend B\n\n${PASTED_B}\n`)
  assert.deepEqual(await assets('B'), ['p.png', 'q r.png'])
  assert.deepEqual(await readFile(join(dir('B'), 'assets', 'p.png')), RED)
  assert.deepEqual(await readFile(join(dir('B'), 'assets', 'q r.png')), BLUE)

  // 2. Pasting again copies nothing new; one undo removes the paste.
  await caretAfter('end A')
  await paste()
  await imagesLoad(4, 'B: second paste did not load')
  assert.deepEqual(await assets('B'), ['p.png', 'q r.png'])
  await key('z', 90, MOD)
  await waitFor(async () => (await images()).length === 2, 'undo did not remove the second paste')

  // 3. Same folder: pasted exactly as copied, nothing copied.
  await openTab('c.md', 'end C')
  await caretAfter('end C')
  await paste()
  await imagesLoad(2, 'C: pasted images did not load')
  assert.equal(await save(files.c, 'Alpha'), `# Gamma\n\nend C\n\n${SOURCE_A.trimEnd()}\n`)
  assert.deepEqual(await readdir(join(dir('A'), 'assets')), ['p.png'])

  // 4. Source-mode copy of A → rich E (another folder).
  await openTab('a.md', 'end A')
  assert.ok(await toggleSource(), 'source toggle not found')
  await waitFor(() => app.evaluate(`!!(${textarea})`), 'A did not switch to source')
  await sleep(300)
  await app.evaluate(`(() => { const t = ${textarea}; t.focus(); t.setSelectionRange(0, t.value.indexOf('end A')) })()`)
  await copy()
  await openTab('e.md', 'end E')
  await caretAfter('end E')
  await paste()
  results.e = await imagesLoad(2, 'E: images from a source-mode copy did not load')
  const savedE = await save(files.e, 'Alpha')
  assert.ok(savedE.includes('![red](assets/p.png)') && savedE.includes('![blue](<assets/q r.png>)'), savedE)
  assert.deepEqual(await assets('E'), ['p.png', 'q r.png'])

  // 5. Source-mode paste (F in source mode) of the same source-mode copy.
  await openTab('f.md', 'end F')
  assert.ok(await toggleSource(), 'F source toggle not found')
  await waitFor(() => app.evaluate(`!!(${textarea})`), 'F did not switch to source')
  await sleep(300)
  await app.evaluate(`(() => { const t = ${textarea}; t.focus(); t.setSelectionRange(t.value.length, t.value.length) })()`)
  await paste()
  await waitFor(() => app.evaluate(`(${textarea}).value.includes('Alpha')`), 'F: source paste did not arrive')
  const sourceF = await app.evaluate(`(${textarea}).value`)
  assert.equal(sourceF, '# Zeta\n\nend F\n' + SOURCE_A.slice(0, SOURCE_A.indexOf('end A')).replace('<pics sub/q r.png>', '<assets/q r.png>'))
  assert.deepEqual(await assets('F'), ['p.png', 'q r.png'])
  assert.ok(await toggleSource(), 'F rich toggle not found')
  await waitFor(() => app.evaluate(`!(${textarea})`), 'F did not switch back to rich')
  results.f = await imagesLoad(2, 'F: images did not load after the source paste')
  const savedF = await save(files.f, 'Alpha')
  assert.ok(savedF.includes('![blue](<assets/q r.png>)'), savedF)

  // 6. A cut (rich) from A's folder into an unsaved document: paste folder.
  await openTab('c.md', 'end C')
  await app.evaluate(`(() => { const p = [...(${editor}).querySelectorAll('p')].find(n => n.textContent.startsWith('text with')); (${editor}).focus(); getSelection().selectAllChildren(p) })()`)
  await sleep(150)
  await cut()
  await app.evaluate(`document.querySelector('.tab-new').click()`)
  await waitFor(() => app.evaluate(`!!(${editor}) && !(${editor}).textContent.includes('end')`), 'new tab did not open')
  await sleep(500)
  await app.evaluate(`(${editor}).focus()`)
  await paste()
  results.untitled = await imagesLoad(1, 'untitled: pasted image did not load')
  assert.match(results.untitled[0].src, /paste-images\/q%20r\.png$/)

  const toasts = await app.evaluate(`[...document.querySelectorAll('.toast, .hm-toast')].map(t => t.textContent)`)
  assert.ok(!toasts.some((t) => /不一致|mismatch/i.test(t)), `sync mismatch toast: ${toasts}`)
  console.log(JSON.stringify(results))
  console.log('PASS copy images between documents (rich, source, cut, same folder, unsaved, undo)')
} finally {
  await stopBuiltElectron(app)
}
