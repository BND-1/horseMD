import assert from 'node:assert/strict'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = 9600 + (process.pid % 200)

const waitFor = async (evaluate, expression, message, attempts = 50) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(expression)) return
    await sleep(100)
  }
  throw new Error(message)
}

const visible = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return false
  const style = getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
})()`

const app = await launchBuiltElectron({
  profileDir: `/tmp/horsemd-selection-toolbar-${process.pid}`,
  port
})

try {
  const { evaluate, send } = app
  await waitFor(evaluate, `[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent)`, 'Rich editor did not open')
  await waitFor(evaluate, `[...document.querySelectorAll('.katex-display')].some((node) => node.offsetParent)`, 'Display math did not render')

  const formulaLayout = await evaluate(`(() => {
    const display = [...document.querySelectorAll('.katex-display')].find((node) => node.offsetParent)
    const block = display?.closest('.milkdown-code-block')
    const code = [...document.querySelectorAll('.cm-editor')].find((node) => node.offsetParent)
    if (!block || !code) return null
    const mathStyle = getComputedStyle(block)
    const codeStyle = getComputedStyle(code)
    return {
      mathPaddingTop: mathStyle.paddingTop,
      mathPaddingBottom: mathStyle.paddingBottom,
      mathBackground: mathStyle.backgroundColor,
      codePaddingTop: codeStyle.paddingTop,
      codeMarginTop: codeStyle.marginTop
    }
  })()`)
  assert.deepEqual(
    {
      mathPaddingTop: formulaLayout?.mathPaddingTop,
      mathPaddingBottom: formulaLayout?.mathPaddingBottom
    },
    { mathPaddingTop: '0px', mathPaddingBottom: '0px' },
    `Rendered display math still inherits code-block spacing: ${JSON.stringify(formulaLayout)}`
  )
  assert.notEqual(formulaLayout.codeMarginTop, '0px',
    `Formula spacing override unexpectedly changed normal code blocks: ${JSON.stringify(formulaLayout)}`)

  // Open Settings -> Editor and turn off the desktop selection toolbar through
  // the real Toggle component, rather than poking localStorage directly.
  const settingsOpened = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')]
    const button = buttons.find((node) => {
      const rect = node.getBoundingClientRect()
      return rect.width && rect.height && /设置|Settings/.test(node.title || node.textContent || '')
    })
    button?.click()
    return Boolean(button)
  })()`)
  assert.ok(settingsOpened, 'Settings button is missing')
  await waitFor(evaluate, `(() => [...document.querySelectorAll('button')].some((node) => /编辑器|Editor/.test(node.textContent || '') && node.offsetParent))()`, 'Editor settings tab is missing')
  await evaluate(`(() => [...document.querySelectorAll('button')].find((node) => /编辑器|Editor/.test(node.textContent || '') && node.offsetParent)?.click())()`)
  await waitFor(evaluate, `(() => [...document.querySelectorAll('.settings-row')].some((row) => /选中文字时显示浮动工具栏|Selection toolbar/.test(row.textContent || '')))()`, 'Selection toolbar setting is missing')
  const disabled = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.settings-row')]
      .find((node) => /选中文字时显示浮动工具栏|Selection toolbar/.test(node.textContent || ''))
    const toggle = row?.querySelector('.hm-toggle')
    toggle?.click()
    return Boolean(toggle)
  })()`)
  assert.ok(disabled, 'Selection toolbar toggle is missing')
  await sleep(150)
  assert.equal(await evaluate(`document.querySelector('.app')?.classList.contains('hm-selection-toolbar-disabled')`), true,
    'Disabling selection toolbar did not update the live app state')

  const documentTab = await evaluate(`(() => [...document.querySelectorAll('.tab')]
    .find((node) => node.offsetParent && !/设置|Settings/.test(node.textContent || ''))?.textContent || null)()`)
  assert.ok(documentTab, 'Document tab is missing after settings change')
  await evaluate(`(() => [...document.querySelectorAll('.tab')]
    .find((node) => node.offsetParent && !/设置|Settings/.test(node.textContent || ''))?.click())()`)
  await waitFor(evaluate, `[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent)`, 'Document did not return after settings')

  const getSelectionPoint = async () => evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const walker = editor && document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let text = null
    while (walker?.nextNode()) {
      if (walker.currentNode.textContent.trim().length >= 6) {
        text = walker.currentNode
        break
      }
    }
    if (!text) return { error: 'text-not-found', editorText: editor?.textContent || '' }
    const start = text.textContent.search(/\\S/)
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, text.textContent.length)
    const rect = range.getBoundingClientRect()
    return {
      startX: rect.left + 2,
      endX: Math.min(rect.right - 2, rect.left + 64),
      y: rect.top + rect.height / 2
    }
  })()`)
  let selectionPoint = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    selectionPoint = await getSelectionPoint()
    assert.ok(selectionPoint?.startX, `Could not select fixture text: ${JSON.stringify(selectionPoint)}`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: selectionPoint.startX, y: selectionPoint.y, button: 'left', clickCount: 1 })
    // A stepped drag behaves consistently across Electron's compositor frames.
    for (let step = 1; step <= 4; step += 1) {
      const x = selectionPoint.startX + ((selectionPoint.endX - selectionPoint.startX) * step / 4)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: selectionPoint.y, button: 'left', buttons: 1 })
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: selectionPoint.endX, y: selectionPoint.y, button: 'left', clickCount: 1 })
    await sleep(120)
    selectionPoint.selectedText = await evaluate(`window.getSelection()?.toString() || ''`)
    if (selectionPoint.selectedText) break
  }
  assert.ok(selectionPoint.selectedText, 'Mouse drag did not create a text selection')
  const toolbarHidden = await evaluate(`(() => {
    const toolbar = [...document.querySelectorAll('.milkdown-toolbar')].find((node) => node.offsetParent || getComputedStyle(node).display === 'none')
    return !toolbar || getComputedStyle(toolbar).display === 'none'
  })()`)
  assert.equal(toolbarHidden, true, 'Floating selection toolbar remains visible after disabling it')

  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: selectionPoint.startX + 12, y: selectionPoint.y, button: 'right', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: selectionPoint.startX + 12, y: selectionPoint.y, button: 'right', clickCount: 1 })
  await waitFor(evaluate, visible('.block-ctxmenu'), 'Right-click format menu did not open')
  const menu = await evaluate(`(() => ({
    selection: window.getSelection()?.toString() || '',
    labels: [...document.querySelectorAll('.block-text-format')].map((node) => node.querySelector('.block-menu-name')?.textContent.trim())
  }))()`)
  assert.equal(menu.selection, selectionPoint.selectedText, `Right click lost the selected text: ${JSON.stringify(menu)}`)
  assert.deepEqual(menu.labels, ['粗体', '斜体', '删除线', '行内代码', '链接', '高亮'],
    `Fallback context menu is incomplete: ${JSON.stringify(menu)}`)
  const reviewLabels = await evaluate(`(() => [...document.querySelectorAll('.block-review-action')]
    .map((node) => node.querySelector('.block-menu-name')?.textContent.trim()))()`)
  assert.deepEqual(reviewLabels, ['新增', '删除', '替换', '高亮 + 评论'],
    `Fallback context menu is missing review actions: ${JSON.stringify(reviewLabels)}`)

  const hoverSubmenu = async (name) => {
    const point = await evaluate(`(() => {
      const trigger = document.querySelector('[data-context-submenu-trigger=${JSON.stringify(name)}]')
      const rect = trigger?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`)
    assert.ok(point, `Context submenu trigger is missing: ${name}`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await waitFor(evaluate, visible(`[data-context-submenu=${JSON.stringify(name)}]`), `Context submenu did not open on hover: ${name}`)
  }

  await hoverSubmenu('format')

  await evaluate(`(() => [...document.querySelectorAll('.block-text-format')]
    .find((node) => node.querySelector('.block-menu-name')?.textContent.trim() === '粗体')?.click())()`)
  await sleep(220)
  const boldResult = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    return {
      applied: [...editor.querySelectorAll('strong')].some((node) => node.textContent === ${JSON.stringify(selectionPoint.selectedText)}),
      selection: window.getSelection()?.toString() || '',
      strong: [...editor.querySelectorAll('strong')].map((node) => node.textContent),
      firstHtml: editor?.firstElementChild?.outerHTML || ''
    }
  })()`)
  assert.equal(boldResult.applied, true, `Right-click Bold did not apply to the preserved selection: ${JSON.stringify(boldResult)}`)

  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: selectionPoint.startX + 12, y: selectionPoint.y, button: 'right', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: selectionPoint.startX + 12, y: selectionPoint.y, button: 'right', clickCount: 1 })
  await waitFor(evaluate, visible('.block-ctxmenu'), 'Right-click review menu did not reopen')
  await hoverSubmenu('review')
  await evaluate(`(() => [...document.querySelectorAll('.block-review-action')]
    .find((node) => node.querySelector('.block-menu-name')?.textContent.trim() === '新增')?.click())()`)
  await sleep(220)
  const reviewResult = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    return {
      applied: Boolean(editor?.querySelector('.hm-review-add')),
      markdown: editor?.textContent || ''
    }
  })()`)
  assert.equal(reviewResult.applied, true, `Right-click review action did not apply to the preserved selection: ${JSON.stringify(reviewResult)}`)

  console.log('selection toolbar UI ok: formula spacing, live preference, selection preservation, right-click formatting and review')
} finally {
  await stopBuiltElectron(app)
}
