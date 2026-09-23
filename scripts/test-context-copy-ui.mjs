import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-context-copy-'))
const file = join(root, 'copy.md')
const code = Array.from({ length: 122 }, (_, i) => `const line${i} = ${i}`).join('\n')
const source = ['# Context copy', '', 'First **bold** text.', '',
  '1. Only selected item', '', '| Key | Value |', '| --- | --- |',
  '| example | selected cell |', '', '```javascript', code, '```', ''].join('\n')
await writeFile(file, source)
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port: 28000 + process.pid % 500, appArgs: [file, '--horsemd-input-trace']
})
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (fn, label) => {
  for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(80) }
  throw new Error(label)
}
const click = async (point, button = 'left') => {
  assert.ok(point, 'missing click target')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point })
}
const key = async (key, keyCode, modifiers = 0, commands = []) => {
  for (const type of ['rawKeyDown', 'keyUp']) await app.send('Input.dispatchKeyEvent', {
    type, key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers, commands
  })
}
const select = (selector, value, reverse = false) => app.evaluate(`(() => {
  const e = ${editor}
  const target = [...e.querySelectorAll(${JSON.stringify(selector)})].find(n => n.textContent === ${JSON.stringify(value)})
  if (!target) return null
  target.scrollIntoView({block:'center'}); e.focus()
  const range = document.createRange(); range.selectNodeContents(target)
  const s = getSelection(); s.removeAllRanges(); s.addRange(range)
  if (${reverse}) s.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset)
  const r = range.getBoundingClientRect()
  return {x:r.left + Math.min(8, r.width / 2), y:r.top + r.height / 2}
})()`)
const copyFromMenu = async point => {
  await click(point, 'right')
  const button = await waitFor(() => app.evaluate(`(() => {
    const b = [...document.querySelectorAll('[data-context-copy]')].find(n => n.offsetParent)
    if (!b || b.disabled) return null
    const r = b.getBoundingClientRect(); return {x:r.left + r.width / 2, y:r.top + r.height / 2}
  })()`), 'enabled Copy menu item missing')
  await app.evaluate('globalThis.__contextCopyPayload = null')
  await click(button)
  return waitFor(() => app.evaluate('globalThis.__contextCopyPayload'), 'Copy did not invoke clipboard event pipeline')
}
try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('First bold text.')`), 'fixture did not open')
  await app.evaluate(`document.addEventListener('copy', event => {
    globalThis.__contextCopyPayload = {
      plain:event.clipboardData.getData('text/plain'), html:event.clipboardData.getData('text/html'),
      markdown:event.clipboardData.getData('text/markdown'), types:[...event.clipboardData.types]
    }
  })`)
  for (const reverse of [false, true]) {
    const payload = await copyFromMenu(await select('p', 'First bold text.', reverse))
    assert.equal(payload.plain, 'First bold text.')
    assert.match(payload.html, /<strong|font-weight/)
    assert.match(payload.markdown, /\*\*bold\*\*/)
  }
  const list = await copyFromMenu(await select('li p', 'Only selected item'))
  assert.equal(list.plain, 'Only selected item', 'text/plain gained an unselected list marker')
  const cell = await copyFromMenu(await select('td p', 'selected cell'))
  assert.equal(cell.plain, 'selected cell')

  // No selection: disabled Copy must not overwrite the clipboard.
  const emptyPoint = await select('p', 'First bold text.')
  await app.evaluate('getSelection().collapseToEnd()')
  await sleep(100)
  await click(emptyPoint, 'right')
  assert.equal(await app.evaluate('document.querySelector("[data-context-copy]")?.disabled'), true)
  await app.evaluate('document.querySelector(".menu-backdrop")?.dispatchEvent(new MouseEvent("mousedown", {bubbles:true}))')

  // Real CodeMirror select-all: 122 lines exceed the rendered viewport.
  const codePoint = await app.evaluate(`(() => {
    const e = ${editor}; const block = e.querySelector('.milkdown-code-block')
    const line = block.querySelector('.cm-line')
    line?.scrollIntoView({block:'center'})
    const r = line?.getBoundingClientRect()
    return r ? {x:r.left + 5, y:r.top + r.height / 2} : null
  })()`)
  await click(codePoint)
  await waitFor(() => app.evaluate('document.activeElement?.classList.contains("cm-content")'), 'code click missed the editable CodeMirror content')
  const modifier = process.platform === 'darwin' ? 4 : 2
  await key('a', 65, modifier, ['selectAll'])
  await sleep(100)
  const getVisibleCodePoint = () => app.evaluate(`(() => {
    const block = (${editor}).querySelector('.milkdown-code-block')
    const viewport = block.querySelector('.cm-scroller').getBoundingClientRect()
    const line = [...block.querySelectorAll('.cm-line')].find(n => {
      const r=n.getBoundingClientRect()
      return r.top>=Math.max(0,viewport.top) && r.bottom<=Math.min(innerHeight-32,viewport.bottom) &&
        document.elementFromPoint(r.left+5,r.top+r.height/2)?.closest('.cm-editor')
    })
    const r = line?.getBoundingClientRect()
    return r ? {x:r.left+5,y:r.top+r.height/2} : null
  })()`)
  const codeCopy = await copyFromMenu(await getVisibleCodePoint())
  assert.equal(codeCopy.plain, code, 'CodeMirror copy was truncated or copied neighbouring text')
  assert.equal(await app.evaluate(`(${editor}).querySelectorAll('.cm-line').length < 122`), true)
  await key('ArrowLeft', 37)
  await key('Home', 36)
  for (let line = 0; line < 65; line++) await key('ArrowDown', 40, 8)
  const partialCopy = await copyFromMenu(await getVisibleCodePoint())
  assert.equal(partialCopy.plain, code.split('\n').slice(0, 65).join('\n') + '\n', 'partial code selection expanded or was truncated')

  await click(await select('p', 'First bold text.'), 'right')
  assert.equal(await app.evaluate(`(() => {
    const toggle = document.querySelector('[data-source-rich-toggle]')
    toggle?.click(); return !!toggle
  })()`), true, 'source/preview toggle missing')
  await waitFor(() => app.evaluate(`(${editor})?.getAttribute('contenteditable') === 'false'`), 'preview did not become read-only')
  await click(await select('p', 'First bold text.'), 'right')
  assert.equal(await app.evaluate("document.querySelector('.block-ctxmenu')?.querySelectorAll('button').length"), 1, 'preview exposes editing commands')
  await app.evaluate('document.querySelector(".menu-backdrop")?.dispatchEvent(new MouseEvent("mousedown", {bubbles:true}))')
  const previewCopy = await copyFromMenu(await select('p', 'First bold text.'))
  assert.equal(previewCopy.plain, 'First bold text.')
  assert.deepEqual(await app.evaluate('(globalThis.__hmSourceIntegrityTrace || []).filter(e => e.ok === false)'), [])
  const raw = await waitFor(() => app.evaluate('[...document.querySelectorAll("textarea.source-editor")].find(n => n.offsetParent)?.value'), 'source mode missing')
  assert.equal(raw, source, 'copy changed source bytes')
  assert.equal(await readFile(file, 'utf8'), source, 'copy changed disk')
  console.log('PASS context Copy UI: actual right-click/button, forward/reverse rich MIME, list/table, disabled empty selection, virtualized 122-line full/65-line partial code, read-only copy-only preview, source/disk unchanged')
} catch (error) {
  console.error('COPY_DIAGNOSTIC', await app.evaluate(`(() => {
    const e = ${editor}; const root = e?.querySelector('.cm-editor')
    const content = root?.querySelector('.cm-content')
    const view = content?.cmView?.view || root?.cmView?.view
    return {selectedLength:getSelection()?.toString().length, active:document.activeElement?.className,
      menu:document.querySelector('.block-ctxmenu')?.textContent,
      rootHasView:!!root?.cmView, contentHasView:!!content?.cmView,
      selection:view?.state.selection.toJSON(),
      renderedLines:root?.querySelectorAll('.cm-line').length}
  })()`))
  throw error
} finally {
  await stopBuiltElectron(app)
  console.log('Evidence retained:', root)
}
