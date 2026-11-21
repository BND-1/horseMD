// A copied list pasted elsewhere (WeChat 公众号, mail) showed two bullets per
// item: Crepe draws each item's marker as an editor-only label
// (<div class="label-wrapper" contenteditable="false"><span class="label
// bullet"><svg/></span></div>), the copy carried that SVG dot along, and the
// target's <li> drew its own marker too. A task item's checkbox SVG sat after
// a bullet as well. The copy (editor-copy.js replaceListLabels) drops bullet
// / number labels and writes a task item as ☐ / ☑ text with no list marker.
// Copies bullet, ordered and task lists with Cmd/Ctrl+C in the real editor
// and checks text/html: no SVG or editor-only element in any item, items
// start with their text, tasks with ☐ / ☑ and list-style-type:none; the
// plain text keeps one marker (`- `, `1. `, or the task's box). A selection
// that starts at the first item's text clones it without its label: the
// task state is taken from the live item (restoreClonedTaskLabels).
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-list-marker-copy-'))
const file = join(root, 'lists.md')
await writeFile(file, ['# Lists', '', '- alpha', '- beta', '', '1. one', '2. two', '',
  '- [ ] open task', '- [x] done task', '', 'plain end', ''].join('\n'))
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port: 29300 + process.pid % 300, appArgs: [file, '--horsemd-input-trace']
})
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (fn, label) => {
  for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(80) }
  throw new Error(label)
}
const keyboardCopy = async () => {
  await app.evaluate('globalThis.__copyPayload = null')
  for (const type of ['rawKeyDown', 'keyUp']) await app.send('Input.dispatchKeyEvent', {
    type, key: 'c', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67,
    modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['copy']
  })
  return waitFor(() => app.evaluate('globalThis.__copyPayload'), 'Cmd/Ctrl+C did not copy')
}
// Select from the start of the paragraph `from` to the end of `to`.
const selectBetween = (from, to) => app.evaluate(`(() => {
  const ps = [...(${editor}).querySelectorAll('li p')]
  const a = ps.find(p => p.textContent === ${JSON.stringify(from)}), b = ps.find(p => p.textContent === ${JSON.stringify(to)})
  ;(${editor}).focus()
  const last = b.lastChild
  getSelection().setBaseAndExtent(a.firstChild, 0, last, last.length)
  return !!(a && b)
})()`)
// What the copied HTML holds per <li>, read in the page.
const inspect = (html) => app.evaluate(`(() => {
  const doc = new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html')
  return [...doc.querySelectorAll('li')].map(li => ({
    text: li.textContent.replace(/\\s+/g, ' ').trim(),
    svg: li.querySelectorAll('svg').length,
    editorOnly: li.querySelectorAll('[contenteditable]').length,
    style: li.getAttribute('style') || '',
    parent: li.parentElement?.tagName
  }))
})()`)

try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('plain end')`), 'fixture did not open')
  await sleep(1500)
  assert.ok(await app.evaluate(`!!(${editor}).querySelector('li .label-wrapper svg')`), 'fixture: Crepe draws list markers as SVG labels')
  await app.evaluate(`document.addEventListener('copy', event => {
    globalThis.__copyPayload = { plain: event.clipboardData.getData('text/plain'), html: event.clipboardData.getData('text/html') }
  })`)

  const cases = [
    { name: 'bullet list', from: 'alpha', to: 'beta', items: ['alpha', 'beta'], parent: 'UL', plain: '- alpha\n- beta' },
    { name: 'ordered list', from: 'one', to: 'two', items: ['one', 'two'], parent: 'OL', plain: '1. one\n2. two' },
    { name: 'task list', from: 'open task', to: 'done task', items: ['☐ open task', '☑ done task'], parent: 'UL', task: true, plain: '☐ open task\n☑ done task' }
  ]
  for (const c of cases) {
    assert.ok(await selectBetween(c.from, c.to), `${c.name}: selection`)
    await sleep(150)
    const copied = await keyboardCopy()
    const items = await inspect(copied.html)
    assert.deepEqual(items.map((i) => i.text), c.items, `${c.name}: item text (html ${copied.html.slice(0, 400)})`)
    for (const item of items) {
      assert.equal(item.svg, 0, `${c.name}: "${item.text}" carries the editor's marker SVG (a second bullet when pasted)`)
      assert.equal(item.editorOnly, 0, `${c.name}: "${item.text}" carries an editor-only element`)
      assert.equal(item.parent, c.parent, `${c.name}: "${item.text}" is inside <${c.parent.toLowerCase()}>`)
      if (c.task) assert.match(item.style, /list-style-type:\s*none/, `${c.name}: "${item.text}" keeps a list bullet beside its box`)
      else assert.doesNotMatch(item.style, /list-style-type:\s*none/, `${c.name}: "${item.text}" lost its list marker`)
    }
    assert.equal(copied.plain, c.plain, `${c.name}: text/plain`)
    console.log(`  ✓ ${c.name}: ${items.map((i) => i.text).join(' / ')} — one marker each, no editor SVG`)
  }
  console.log('PASS list marker copy')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
}
