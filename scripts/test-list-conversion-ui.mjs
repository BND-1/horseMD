import assert from 'node:assert/strict'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 9695)
const fixture = join(process.cwd(), 'scripts', 'fixtures', 'list-conversion.md')

async function waitFor(check, message, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const rightClickText = (evaluate, text) => evaluate(`(() => {
  const visible = (node) => !!node?.offsetParent
  const editor = [...document.querySelectorAll('.ProseMirror')].find(visible)
  const item = [...(editor?.querySelectorAll('li') || [])]
    .find((node) => [...node.querySelectorAll('p')]
      .some((paragraph) => paragraph.closest('li') === node && paragraph.textContent.trim() === ${JSON.stringify(text)}))
  const target = [...(item?.querySelectorAll('p') || [])]
    .find((paragraph) => paragraph.closest('li') === item) || item
  if (!editor || !target) return false
  target.scrollIntoView({ block: 'center', inline: 'nearest' })
  const rect = target.getBoundingClientRect()
  target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: rect.left + Math.min(40, rect.width / 2),
    clientY: rect.top + rect.height / 2
  }))
  return true
})()`)

const rightClickParagraph = (evaluate, text) => evaluate(`(() => {
  const visible = (node) => !!node?.offsetParent
  const editor = [...document.querySelectorAll('.ProseMirror')].find(visible)
  const target = [...(editor?.querySelectorAll('p') || [])]
    .find((node) => node.textContent.trim().startsWith(${JSON.stringify(text)}))
  if (!target) return false
  target.scrollIntoView({ block: 'center', inline: 'nearest' })
  const rect = target.getBoundingClientRect()
  target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: rect.left + Math.min(40, rect.width / 2),
    clientY: rect.top + rect.height / 2
  }))
  return true
})()`)

const rightClickHeading = (evaluate, text) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const target = [...(editor?.querySelectorAll('h1, h2, h3, h4, h5, h6') || [])]
    .find((node) => node.textContent.trim() === ${JSON.stringify(text)})
  if (!target) return false
  target.scrollIntoView({ block: 'center', inline: 'nearest' })
  const rect = target.getBoundingClientRect()
  target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: rect.left + Math.min(40, rect.width / 2),
    clientY: rect.top + rect.height / 2
  }))
  return true
})()`)

const menuAction = (evaluate, targetType) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.block-list-conversion${targetType ? `[data-list-conversion="${targetType}"]` : ''}')]
    .find((node) => node.offsetParent)
  return button ? {
    text: button.textContent.trim(),
    disabled: button.getAttribute('aria-disabled') === 'true',
    reason: button.title
  } : null
})()`)

const clickMenuAction = (evaluate, targetType) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.block-list-conversion${targetType ? `[data-list-conversion="${targetType}"]` : ''}')]
    .find((node) => node.offsetParent)
  if (!button) return false
  button.click()
  return true
})()`)

const blockMenuAction = (evaluate, targetType) => evaluate(`(() => {
  const button = [...document.querySelectorAll('[data-block-list-conversion=${JSON.stringify(targetType)}]')]
    .find((node) => node.offsetParent)
  return button?.textContent.trim() || null
})()`)

const blockMenuActionPoint = (evaluate, targetType) => evaluate(`(() => {
  const button = [...document.querySelectorAll('[data-block-list-conversion=${JSON.stringify(targetType)}]')]
    .find((node) => node.offsetParent)
  if (!button) return null
  const rect = button.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
})()`)

const menuActionPoint = (evaluate, targetType) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.block-list-conversion${targetType ? `[data-list-conversion="${targetType}"]` : ''}')]
    .find((node) => node.offsetParent)
  if (!button) return null
  const rect = button.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
})()`)

async function clickMenuActionWithMouse({ evaluate, send }, targetType) {
  const point = await menuActionPoint(evaluate, targetType)
  if (!point) return false
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
  // The submenu has just become the mouse target. Let Electron commit that
  // hover frame before pressing, otherwise the click can hit the parent menu
  // during compositor-heavy test runs.
  await sleep(60)
  const hitTarget = await evaluate(`(() => document.elementFromPoint(${point.x}, ${point.y})?.closest?.('[data-list-conversion]')?.dataset.listConversion || null)()`)
  if (hitTarget !== targetType) return false
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  return true
}

async function clickBlockMenuActionWithMouse({ evaluate, send }, targetType) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const point = await blockMenuActionPoint(evaluate, targetType)
    if (!point) return false
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
    await sleep(80)
    const hitTarget = await evaluate(`(() => document.elementFromPoint(${point.x}, ${point.y})?.closest?.('[data-block-list-conversion]')?.dataset.blockListConversion || null)()`)
    if (hitTarget !== targetType) continue
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    return true
  }
  return false
}

async function hoverContextSubmenu({ evaluate, send }, name) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const point = await evaluate(`(() => {
      const trigger = document.querySelector('[data-context-submenu-trigger=${JSON.stringify(name)}]')
      const rect = trigger?.getBoundingClientRect()
      return rect && trigger.offsetParent ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`)
    if (!point) return false
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
    await sleep(100)
    const open = await evaluate(`(() => {
      const submenu = document.querySelector('[data-context-submenu=${JSON.stringify(name)}]')
      return submenu?.offsetParent ? true : false
    })()`)
    if (open) return true
  }
  throw new Error(`context submenu did not open: ${name}`)
}

async function openListMenu(app, text) {
  const opened = await rightClickText(app.evaluate, text)
  if (!opened) return false
  await hoverContextSubmenu(app, 'list')
  return true
}

const closeMenu = (evaluate) => evaluate(`(() => {
  document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return true
})()`)

const listShape = (evaluate) => evaluate(`(() => {
  const visible = (node) => !!node?.offsetParent
  const editor = [...document.querySelectorAll('.ProseMirror')].find(visible)
  const directList = (text) => {
    const item = [...(editor?.querySelectorAll('li') || [])]
      .find((node) => [...node.querySelectorAll('p')]
        .some((paragraph) => paragraph.closest('li') === node && paragraph.textContent.trim() === text))
    return item?.closest('ul, ol')?.tagName || null
  }
  return {
    parent: directList('Parent'),
    child: directList('Child A'),
    ordered: directList('First'),
    orderedChild: directList('First child'),
    task: directList('Task one')
  }
})()`)

const selectionListItemText = (evaluate) => evaluate(`(() => {
  const selection = window.getSelection()
  let node = selection?.anchorNode
  if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement
  const item = node?.closest?.('li')
  const paragraph = [...(item?.querySelectorAll('p') || [])]
    .find((candidate) => candidate.closest('li') === item)
  return paragraph?.textContent.trim() || null
})()`)

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  if (!button) return false
  button.click()
  return true
})()`)

const sourceValue = (evaluate) => evaluate(`(() =>
  [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
)()`)

async function main() {
  const app = await launchBuiltElectron({
    profileDir: `/tmp/horsemd-list-conversion-ui-${process.pid}`,
    port,
    appArgs: [fixture]
  })
  const { evaluate, send } = app

  try {
    await waitFor(
      () => evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent)`),
      'list conversion fixture did not open in rich mode'
    )

    assert.deepEqual(await listShape(evaluate), {
      parent: 'UL', child: 'UL', ordered: 'OL', orderedChild: 'OL', task: 'UL'
    }, 'fixture list structure did not render as expected')

    assert.equal(await rightClickHeading(evaluate, 'List conversion'), true, 'could not open heading menu')
    await hoverContextSubmenu(app, 'block')
    assert.equal(await blockMenuAction(evaluate, 'bullet_list'), null, 'headings must not offer paragraph-only list conversion')
    await closeMenu(evaluate)

    assert.equal(await openListMenu(app, 'Parent'), true, 'could not open ordinary bullet-list menu')
    const parentAction = await waitFor(() => menuAction(evaluate, 'ordered_list'), 'bullet list conversion action did not appear')
    assert.match(parentAction.text, /有序列表|Ordered List/)
    assert.ok(await menuAction(evaluate, 'task_list'), 'ordinary list must offer task-list conversion')
    assert.equal(await evaluate(`(() => [...document.querySelectorAll('.block-menu-item')].some((node) => /标题|Heading|正文|Text/.test(node.textContent)))()`), false, 'list menu must not show unsupported text or heading conversions')
    assert.equal(await clickMenuActionWithMouse(app, 'ordered_list'), true, 'could not physically click bullet-list conversion')
    await sleep(360)
    assert.deepEqual(await listShape(evaluate), {
      parent: 'OL', child: 'UL', ordered: 'OL', orderedChild: 'OL', task: 'UL'
    }, 'parent conversion must not change nested list type')
    assert.equal(await selectionListItemText(evaluate), 'Parent', 'parent conversion must keep the caret in its original item')

    assert.equal(await openListMenu(app, 'Child A'), true, 'could not open nested-list menu')
    const nestedAction = await waitFor(() => menuAction(evaluate, 'ordered_list'), 'nested list conversion state did not appear')
    assert.match(nestedAction.text, /有序列表|Ordered List/)
    assert.equal(nestedAction.disabled, false, 'nested-list conversion must remain available')
    assert.equal(await clickMenuActionWithMouse(app, 'ordered_list'), true, 'could not physically click nested-list conversion')
    await sleep(280)
    assert.deepEqual(await listShape(evaluate), {
      parent: 'OL', child: 'OL', ordered: 'OL', orderedChild: 'OL', task: 'UL'
    }, 'nested conversion must not change parent list type')
    assert.equal(await selectionListItemText(evaluate), 'Child A', 'nested conversion must keep the caret in its original item')

    assert.equal(await openListMenu(app, 'Child A'), true, 'could not reopen nested list conversion')
    assert.equal(await clickMenuActionWithMouse(app, 'task_list'), true, 'could not convert nested list to task list')
    await sleep(280)
    assert.deepEqual(await listShape(evaluate), {
      parent: 'OL', child: 'UL', ordered: 'OL', orderedChild: 'OL', task: 'UL'
    }, 'task conversion must only change the selected nested list container')

    assert.equal(await openListMenu(app, 'Parent'), true, 'could not reopen parent list conversion')
    assert.equal(await clickMenuActionWithMouse(app, 'bullet_list'), true, 'could not convert parent without changing nested tasks')
    await sleep(280)
    assert.deepEqual(await listShape(evaluate), {
      parent: 'UL', child: 'UL', ordered: 'OL', orderedChild: 'OL', task: 'UL'
    }, 'parent conversion must preserve nested task-list container')

    assert.equal(await openListMenu(app, 'First'), true, 'could not open ordinary ordered-list menu')
    assert.match((await waitFor(() => menuAction(evaluate, 'bullet_list'), 'ordered list conversion action did not appear')).text, /无序列表|Bullet List/)
    assert.equal(await clickMenuActionWithMouse(app, 'bullet_list'), true, 'could not physically click ordered-list conversion')
    await sleep(280)
    assert.deepEqual(await listShape(evaluate), {
      parent: 'UL', child: 'UL', ordered: 'UL', orderedChild: 'OL', task: 'UL'
    }, 'ordered-list conversion must not change its nested list')

    assert.equal(await openListMenu(app, 'First child'), true, 'could not open ordered child-list menu')
    assert.equal(await clickMenuActionWithMouse(app, 'bullet_list'), true, 'could not convert only the child ordered list')
    await sleep(280)
    assert.deepEqual(await listShape(evaluate), {
      parent: 'UL', child: 'UL', ordered: 'UL', orderedChild: 'UL', task: 'UL'
    }, 'child conversion must not change its parent list')

    assert.equal(await openListMenu(app, 'Task one'), true, 'could not open task-list menu')
    const taskAction = await waitFor(() => menuAction(evaluate, 'bullet_list'), 'task-list conversion state did not appear')
    assert.equal(taskAction.disabled, false, 'task-list conversion must be available')
    assert.equal(await clickMenuActionWithMouse(app, 'bullet_list'), true, 'could not convert task list to a bullet list')
    await sleep(280)
    assert.equal((await listShape(evaluate)).task, 'UL', 'task conversion must retain list structure')
    assert.equal(await selectionListItemText(evaluate), 'Task one', 'task conversion must keep the caret in its original item')

    assert.equal(await openListMenu(app, 'Task one'), true, 'could not reopen converted task list')
    assert.equal(await clickMenuActionWithMouse(app, 'task_list'), true, 'could not convert bullet list back to a task list')
    await sleep(280)
    await closeMenu(evaluate)

    assert.equal(await rightClickParagraph(evaluate, 'This paragraph separates'), true, 'could not open paragraph menu')
    await hoverContextSubmenu(app, 'block')
    for (const targetType of ['bullet_list', 'ordered_list', 'task_list']) {
      assert.match(
        await waitFor(() => blockMenuAction(evaluate, targetType), `paragraph menu did not offer ${targetType}`),
        /列表|List|待办|Task/
      )
    }
    assert.equal(await clickBlockMenuActionWithMouse(app, 'bullet_list'), true, 'could not convert paragraph to a bullet list')
    await sleep(280)
    const paragraphConversion = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const item = [...(editor?.querySelectorAll('li') || [])]
        .find((node) => node.textContent.trim() === 'This paragraph separates ordinary and task lists.')
      return { list: item?.closest('ul')?.tagName || null, html: editor?.innerHTML || '' }
    })()`)
    assert.equal(paragraphConversion.list, 'UL', 'paragraph conversion must create a bullet-list item: ' + paragraphConversion.html)

    assert.equal(await rightClickParagraph(evaluate, 'Convert this paragraph to an ordered list.'), true, 'could not open second paragraph menu')
    await hoverContextSubmenu(app, 'block')
    assert.equal(await clickBlockMenuActionWithMouse(app, 'ordered_list'), true, 'could not convert paragraph to an ordered list')
    await sleep(220)
    const orderedParagraphConversion = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...(editor?.querySelectorAll('li p') || [])]
        .find((node) => node.textContent.trim() === 'Convert this paragraph to an ordered list.')
      return paragraph?.closest('li')?.closest('ol')?.tagName || null
    })()`)
    assert.equal(orderedParagraphConversion, 'OL', 'paragraph conversion must create an ordered-list item')

    assert.equal(await rightClickParagraph(evaluate, 'Convert this paragraph to a task list.'), true, 'could not open third paragraph menu')
    await hoverContextSubmenu(app, 'block')
    assert.equal(await clickBlockMenuActionWithMouse(app, 'task_list'), true, 'could not convert paragraph to a task list')
    const taskParagraphConversion = await waitFor(() => evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...(editor?.querySelectorAll('li p') || [])]
        .find((node) => node.textContent.trim() === 'Convert this paragraph to a task list.')
      const item = paragraph?.closest('li')
      return !!item?.querySelector('.label.unchecked')
    })()`), 'paragraph conversion must create an unchecked task-list item')
    assert.equal(taskParagraphConversion, true, 'paragraph conversion must create an unchecked task-list item')

    assert.equal(await toggleSource(evaluate), true, 'could not inspect converted Markdown in source mode')
    const afterBulletConversion = await waitFor(() => sourceValue(evaluate), 'source mode did not open after list conversion')
    assert.match(afterBulletConversion, /[-*] Parent\s+[-*] \[ \] Child A\s+[-*] \[ \] Child B\s+[-*] Sibling/)
    assert.match(afterBulletConversion, /[-*] First\s+[-*] First child\s+[-*] Second/)
    assert.ok(afterBulletConversion.includes('Keep this spelling: 0~9 and `inline code`.'), 'list conversion rewrote an untouched paragraph')
    assert.match(afterBulletConversion, /[-*] This paragraph separates ordinary and task lists\./, 'paragraph conversion did not serialize as a bullet list')
    assert.match(afterBulletConversion, /1\. Convert this paragraph to an ordered list\./, 'paragraph conversion did not serialize as an ordered list')
    assert.match(afterBulletConversion, /[-*] \[ \] Convert this paragraph to a task list\./, 'paragraph conversion did not serialize as a task list')
    assert.ok(
      /[-*] \[ \] Task one\s+[-*] \[ \] Task two/.test(afterBulletConversion),
      'task list must convert back to an unchecked task list: ' + afterBulletConversion
    )

    console.log('PASS list conversion UI: current-level conversion, task conversion, caret preservation, and source preservation')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
