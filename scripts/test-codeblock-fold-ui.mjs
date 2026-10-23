// Code-block folding (view-only): the toolbar button folds a long block to
// its first lines with a "N lines folded" bar; the bar or the button unfolds
// it; the caret entering folded code unfolds it; a short block has no
// button; the Markdown and the dirty state never change.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-code-fold-'))
const file = join(root, 'fold.md')
const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
const original = `# Fold\n\nintro\n\n\`\`\`js\n${long}\n\`\`\`\n\nmiddle\n\n\`\`\`\nshort a\nshort b\n\`\`\`\n\nend\n`
await writeFile(file, original)
const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port: 29800 + process.pid % 60, appArgs: [file, '--horsemd-input-trace'] })
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (fn, label, attempts = 100) => {
  for (let i = 0; i < attempts; i++) { const v = await fn(); if (v) return v; await sleep(100) }
  throw new Error(label)
}
const state = () => app.evaluate(`(() => {
  const blocks = [...(${editor}).querySelectorAll('.milkdown-code-block')]
  return blocks.map((b) => {
    const button = b.querySelector('.hm-code-fold-button')
    return {
      folded: b.classList.contains('hm-code-folded'),
      button: Boolean(button && getComputedStyle(button).display !== 'none'),
      label: button?.getAttribute('aria-label') || null,
      bar: b.querySelector(':scope > .hm-code-fold-bar')?.textContent || null,
      height: Math.round(b.querySelector('.codemirror-host').getBoundingClientRect().height),
      scrollTop: Math.round(b.querySelector('.codemirror-host').scrollTop),
      scrollable: b.querySelector('.codemirror-host').scrollHeight > b.querySelector('.codemirror-host').clientHeight + 20
    }
  })
})()`)
const click = async (selector, index = 0) => {
  const point = await app.evaluate(`(() => {
    const el = [...(${editor}).querySelectorAll('.milkdown-code-block')][${index}].querySelector(${JSON.stringify(selector)})
    el.scrollIntoView({ block: 'center' })
    // The toolbar buttons fade in on hover; a real pointer move shows them.
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await sleep(250)
  for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await sleep(300)
}
const dirty = () => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`)

try {
  await waitFor(() => app.evaluate(`(${editor})?.querySelectorAll('.cm-editor').length === 2`), 'code blocks did not mount')
  await sleep(800)
  let [big, small] = await state()
  assert.equal(big.button, true, 'long block has a fold button')
  assert.equal(small.button, false, 'short block has no fold button')
  const fullHeight = big.height

  await click('.hm-code-fold-button')
  ;[big] = await state()
  assert.equal(big.folded, true, 'button folds the block')
  assert.ok(big.height < fullHeight / 3, `folded height ${big.height} < ${fullHeight}/3`)
  const shown = await app.evaluate(`(() => {
    const b = [...(${editor}).querySelectorAll('.milkdown-code-block')][0]
    const host = b.querySelector('.codemirror-host').getBoundingClientRect()
    return [...b.querySelectorAll('.cm-line')].filter((l) => l.getBoundingClientRect().bottom <= host.bottom + 0.5).length
  })()`)
  assert.equal(shown, 5, `five whole lines visible while folded (got ${shown})`)
  assert.match(big.bar, /25/, `bar counts the hidden lines: ${big.bar}`)
  assert.equal(big.scrollable, true, 'folded window can scroll')

  // The wheel scrolls inside the folded window.
  const wheelAt = await app.evaluate(`(() => {
    const r = [...(${editor}).querySelectorAll('.milkdown-code-block')][0].querySelector('.codemirror-host').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheelAt.x, y: wheelAt.y, deltaX: 0, deltaY: 120 })
  await sleep(400)
  ;[big] = await state()
  assert.ok(big.scrollTop > 0, `wheel scrolls the folded code (scrollTop ${big.scrollTop})`)
  assert.equal(big.folded, true, 'scrolling keeps it folded')

  // Clicking a scrolled-in line unfolds without moving that line.
  const lineBefore = await app.evaluate(`(() => {
    const b = [...(${editor}).querySelectorAll('.milkdown-code-block')][0]
    const host = b.querySelector('.codemirror-host').getBoundingClientRect()
    const line = [...b.querySelectorAll('.cm-line')].find((l) => l.getBoundingClientRect().top >= host.top + 30)
    const r = line.getBoundingClientRect()
    return { text: line.textContent, x: r.left + 20, y: r.top + r.height / 2 }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: lineBefore.x, y: lineBefore.y, button: 'left', clickCount: 1 })
  await sleep(400)
  assert.equal((await state())[0].folded, false, 'click into scrolled code unfolds')
  const lineAfter = await app.evaluate(`(() => {
    const line = [...[...(${editor}).querySelectorAll('.milkdown-code-block')][0].querySelectorAll('.cm-line')].find((l) => l.textContent === ${JSON.stringify(lineBefore.text)})
    const r = line.getBoundingClientRect(); return r.top + r.height / 2
  })()`)
  assert.ok(Math.abs(lineAfter - lineBefore.y) <= 3, `clicked line stays put (${lineBefore.y} → ${lineAfter})`)
  await click('.hm-code-fold-button')
  assert.equal((await state())[0].folded, true, 'fold again')
  assert.equal(await dirty(), false, 'folding does not dirty the document')

  await click(':scope > .hm-code-fold-bar')
  ;[big] = await state()
  assert.equal(big.folded, false, 'the bar unfolds the block')
  assert.equal(big.height, fullHeight, 'full height restored')

  // Fold again, then put the caret into the visible code: it unfolds.
  await click('.hm-code-fold-button')
  assert.equal((await state())[0].folded, true)
  await click('.cm-line')
  assert.equal((await state())[0].folded, false, 'caret entering folded code unfolds it')

  // Arrow keys from the paragraph above into a folded block unfold it too.
  await click('.hm-code-fold-button')
  const intro = await app.evaluate(`(() => {
    const p = [...(${editor}).querySelectorAll('p')].find((n) => n.textContent === 'intro')
    const r = document.createRange(); r.selectNodeContents(p); const b = r.getBoundingClientRect()
    return { x: b.right - 1, y: b.top + b.height / 2 }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: intro.x, y: intro.y, button: 'left', clickCount: 1 })
  await sleep(200)
  await pressKey(app.send, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 })
  await sleep(400)
  assert.equal((await state())[0].folded, false, 'ArrowDown into folded code unfolds it')

  assert.equal(await dirty(), false, 'still not dirty')
  assert.equal(await readFile(file, 'utf8'), original, 'file untouched')
  console.log('PASS code-block fold: button/bar toggle, caret entry unfolds, short blocks skip, Markdown untouched')
} finally {
  await stopBuiltElectron(app)
}
