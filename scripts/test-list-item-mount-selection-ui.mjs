// A list item mounted by ProseMirror must not undo a selection change made
// before its next animation frame (vite.milkdown-fixes.mjs: Crepe's list item
// node view restored the selection it saw at mount one frame later). On the
// Windows test PC a click into a list right after opening landed at the
// document start: the window's first frames came late and every list item
// put back the mount-time caret.
//
// Deterministic on every platform: insert a list item (its node view mounts
// inside dispatch), move the selection in the same task, wait two frames.
// Also: ticking a task re-renders its node view, which must not lose the
// caret (Vue calls the mount callback again on every re-render).
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-list-item-mount-selection-${process.pid}`
const port = Number(process.env.CDP_PORT || 18610 + (process.pid % 30))
const file = join(root, 'doc.md')

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
await writeFile(file, '# Mount\n\n- alpha\n- beta\n\nparagraph after\n\n- [ ] todo\n', 'utf8')
const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file, '--horsemd-input-trace'] })
let completed = false
try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await app.evaluate(`Boolean(window.__hmSourceReprintHarness?.view?.()?.state.doc.textContent.includes('paragraph after'))`)) break
    await sleep(100)
  }
  await sleep(400)
  const run = (moveSelection) => app.evaluate(`(async () => {
    const view = window.__hmSourceReprintHarness.view()
    const { state } = view
    // The document opens with a text selection; its class is TextSelection.
    const TextSelection = state.selection.constructor
    if (TextSelection.name !== 'TextSelection' && typeof TextSelection.create !== 'function') throw new Error('no text selection at start')
    let listEnd = -1
    let paragraphPos = -1
    state.doc.forEach((node, offset) => {
      if (node.type.name === 'bullet_list' && listEnd < 0) listEnd = offset + node.nodeSize - 1
      if (node.type.name === 'paragraph' && node.textContent === 'paragraph after') paragraphPos = offset + 3
    })
    const item = state.schema.nodes.list_item.create(
      { label: '•', listType: 'bullet', spread: false, checked: null },
      state.schema.nodes.paragraph.create(null, state.schema.text('gamma'))
    )
    const insert = state.tr.insert(listEnd, item)
    const inItem = listEnd + 3
    insert.setSelection(TextSelection.create(insert.doc, inItem))
    view.dispatch(insert)
    const mounted = view.state.selection.head
    let target = mounted
    if (${moveSelection ? 'true' : 'false'}) {
      const shifted = paragraphPos + item.nodeSize
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, shifted)))
      target = shifted
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const head = view.state.selection.head
    const $head = view.state.doc.resolve(head)
    const result = { mounted, target, head, parentText: $head.parent.textContent }
    view.dispatch(view.state.tr.delete(listEnd, listEnd + item.nodeSize))
    return result
  })()`)

  const moved = await run(true)
  assert.equal(moved.head, moved.target, `a selection moved right after a list item mounted was undone: ${JSON.stringify(moved)}`)
  assert.equal(moved.parentText, 'paragraph after')

  const kept = await run(false)
  assert.equal(kept.head, kept.mounted, `the mount-time selection must stay when nothing moved it: ${JSON.stringify(kept)}`)
  assert.equal(kept.parentText, 'gamma')

  // Caret in the task's text, then a real click on its checkbox.
  const todo = await app.evaluate(`(() => {
    const view = window.__hmSourceReprintHarness.view()
    const TextSelection = view.state.selection.constructor
    let pos = -1
    view.state.doc.descendants((node, offset) => {
      if (pos < 0 && node.isText && node.text === 'todo') pos = offset + 2
    })
    view.focus()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
    const label = [...view.dom.querySelectorAll('.milkdown-list-item-block')]
      .find((node) => node.querySelector('.children')?.textContent.trim() === 'todo')
      ?.querySelector('.label-wrapper')
    const rect = label?.getBoundingClientRect()
    return { pos, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await app.send('Input.dispatchMouseEvent', { type, x: todo.x, y: todo.y, button: 'left', clickCount: 1 })
  }
  await sleep(300)
  const ticked = await app.evaluate(`(() => {
    const view = window.__hmSourceReprintHarness.view()
    const $head = view.state.doc.resolve(view.state.selection.head)
    const dom = window.getSelection().anchorNode
    return {
      head: view.state.selection.head,
      parentText: $head.parent.textContent,
      checked: (() => {
        let value = null
        view.state.doc.descendants((node) => {
          if (node.type.name === 'list_item' && node.textContent === 'todo') value = node.attrs.checked
        })
        return value
      })(),
      domText: (dom?.nodeType === 3 ? dom.parentElement : dom)?.closest('p')?.textContent ?? null
    }
  })()`)
  assert.equal(ticked.checked, true, `the checkbox click did not tick the task: ${JSON.stringify(ticked)}`)
  assert.equal(ticked.head, todo.pos, `ticking a task moved the caret: ${JSON.stringify(ticked)}`)
  assert.equal(ticked.domText, 'todo', `ticking a task lost the DOM caret: ${JSON.stringify(ticked)}`)

  completed = true
  console.log('PASS list item mount selection: a selection changed before the next frame stays; an unchanged one is kept; ticking a task keeps the caret')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true })
}
