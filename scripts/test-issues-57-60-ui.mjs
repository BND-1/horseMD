// Real Electron regression for Issues #57, #58, and the #60 export dialog.
// Launch a built app with --remote-debugging-port first. #59's geometry is
// covered by test-menu-position.mjs because native pointer placement varies by
// window manager while the clamping rule itself is pure.
import { connectCdp, sleep } from './lib/cdp.mjs'

const issue59Dir = process.env.ISSUE59_DIR || ''

async function waitForPreview(evaluate, label) {
  for (let i = 0; i < 100; i++) {
    const state = await evaluate(`(() => {
      const preview = document.querySelector('.hm-pdf-preview')
      const exportButton = document.querySelector('.hm-pdf-studio-footer .primary')
      return {
        token: preview?.dataset.previewToken || '',
        loadedToken: preview?.dataset.loadedToken || '',
        pending: !!document.querySelector('.hm-pdf-preview-progress'),
        error: document.querySelector('.hm-pdf-preview-error')?.textContent || '',
        pageCount: document.querySelectorAll('.hm-pdf-page').length,
        canvas: !!document.querySelector('.hm-pdf-page canvas'),
        exportEnabled: !!exportButton && !exportButton.disabled
      }
    })()`)
    if (state.error) throw new Error(`PDF ${label} preview failed: ${state.error}`)
    if (state.token && state.loadedToken === state.token && !state.pending &&
      state.pageCount > 0 && state.canvas && state.exportEnabled) return state
    await sleep(200)
  }
  throw new Error(`PDF ${label} preview did not become ready`)
}

async function click(send, x, y, button = 'left') {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
}

async function key(send, value, code = value, virtualKeyCode = value.charCodeAt(0)) {
  const params = { key: value, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

async function main() {
  const { ws, send, evaluate } = await connectCdp()
  await send('Runtime.enable')
  await sleep(900)

  const pointForText = async (text) => evaluate(`(() => {
    const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = [...pm.querySelectorAll('p,h1,h2,h3')].find((item) => item.textContent === ${JSON.stringify(text)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    return { x: rect.right - 2, y: rect.top + rect.height / 2 }
  })()`)

  // #57: /math converts the current paragraph, keeps CodeMirror visible, and
  // accepts a multi-character formula without dropping focus.
  const formulaPoint = await pointForText('Formula target')
  if (!formulaPoint) throw new Error('Formula fixture paragraph not found')
  await click(send, formulaPoint.x, formulaPoint.y)
  await key(send, 'End', 'End', 35)
  await key(send, 'Enter', 'Enter', 13)
  await send('Input.insertText', { text: '/math' })
  await sleep(250)
  await key(send, 'Enter', 'Enter', 13)
  await sleep(350)
  await send('Input.insertText', { text: 'x^2 + \\sqrt{4}' })
  await sleep(450)
  const math = await evaluate(`(() => {
    const latex = document.activeElement?.closest('.cm-editor')
    latex?.setAttribute('data-issue-57', '1')
    const host = latex?.closest('.codemirror-host')
    return {
      text: latex?.querySelector('.cm-content')?.textContent || '',
      visible: !!host && getComputedStyle(host).display !== 'none',
      focused: !!latex?.contains(document.activeElement)
    }
  })()`)
  if (!math.text.includes('x^2 + \\sqrt{4}') || !math.visible || !math.focused) {
    throw new Error(`Math editing lost content/focus: ${JSON.stringify(math)}`)
  }

  const dollarPoint = await pointForText('PDF section')
  if (!dollarPoint) throw new Error('Dollar-math fixture heading not found')
  await click(send, dollarPoint.x, dollarPoint.y)
  await key(send, 'End', 'End', 35)
  await key(send, 'Enter', 'Enter', 13)
  await send('Input.insertText', { text: '$$' })
  await key(send, 'Enter', 'Enter', 13)
  await sleep(300)
  await send('Input.insertText', { text: 'z+1' })
  await sleep(300)
  const dollarMath = await evaluate(`(() => {
    const editor = document.activeElement?.closest('.cm-editor')
    return {
      text: editor?.querySelector('.cm-content')?.textContent || '',
      visible: !!editor && getComputedStyle(editor.closest('.codemirror-host')).display !== 'none',
      focused: !!editor?.contains(document.activeElement)
    }
  })()`)
  if (dollarMath.text !== 'z+1' || !dollarMath.visible || !dollarMath.focused) {
    throw new Error(`Dollar math editing lost content/focus: ${JSON.stringify(dollarMath)}`)
  }

  // #58: an empty backtick pair enters inline-code mode. After closing it,
  // clicking the rendered trailing edge and typing appends within the mark.
  const inlinePoint = await pointForText('Inline target')
  if (!inlinePoint) throw new Error('Inline-code fixture paragraph not found')
  await click(send, inlinePoint.x, inlinePoint.y)
  const mathSettled = await evaluate(`(() => {
    const editor = document.querySelector('.cm-editor[data-issue-57="1"]')
    const host = editor?.closest('.codemirror-host')
    return !!host && getComputedStyle(host).display === 'none'
  })()`)
  if (!mathSettled) throw new Error('Math source did not return to preview-only mode after blur')
  await key(send, 'End', 'End', 35)
  await send('Input.insertText', { text: ' ' })
  await send('Input.insertText', { text: '`' })
  await send('Input.insertText', { text: '`' })
  await send('Input.insertText', { text: 'ab' })
  await send('Input.insertText', { text: '`' })
  await sleep(250)
  const codePoint = await evaluate(`(() => {
    const code = [...document.querySelectorAll('.ProseMirror code')].find((node) => node.textContent === 'ab')
    if (!code) return null
    code.setAttribute('data-issue-58', '1')
    const rect = code.getBoundingClientRect()
    return { x: rect.right - 0.25, y: rect.top + rect.height / 2 }
  })()`)
  if (!codePoint) throw new Error('Inline code pair did not render')
  await click(send, codePoint.x, codePoint.y)
  await send('Input.insertText', { text: 'c' })
  await sleep(250)
  const inlineText = await evaluate(`document.querySelector('code[data-issue-58="1"]')?.textContent || ''`)
  if (inlineText !== 'abc') throw new Error(`Inline-code boundary append failed: ${inlineText}`)

  // #59: open the context menu on the final visible file row. The measured
  // menu must move upward enough that its destructive action remains visible.
  let contextMenu = { skipped: true }
  if (issue59Dir) {
    const bottomRow = await evaluate(`(() => {
      const tree = document.querySelector('.tree')
      tree.scrollTop = tree.scrollHeight
      const rows = [...tree.querySelectorAll('.tree-row')].filter((node) => node.offsetParent)
      const row = rows.at(-1)
      const rect = row?.getBoundingClientRect()
      return rect ? { x: rect.left + 40, y: rect.top + rect.height / 2 } : null
    })()`)
    if (!bottomRow) throw new Error('Issue #59 bottom file row not found')
    await click(send, bottomRow.x, bottomRow.y, 'right')
    await sleep(180)
    contextMenu = await evaluate(`(() => {
      const menu = document.querySelector('.context-menu')
      const rect = menu?.getBoundingClientRect()
      const buttons = menu ? [...menu.querySelectorAll('button')].map((node) => node.textContent.trim()) : []
      return {
        top: rect?.top,
        bottom: rect?.bottom,
        viewport: innerHeight,
        hasDelete: buttons.some((text) => /删除|Delete/i.test(text))
      }
    })()`)
    if (contextMenu.top < 0 || contextMenu.bottom > contextMenu.viewport || !contextMenu.hasDelete) {
      throw new Error(`Sidebar context menu is clipped: ${JSON.stringify(contextMenu)}`)
    }
    await evaluate(`document.body.click()`)
  }

  // #60: every PDF entry point now opens the page-options dialog before the
  // native save dialog. Exercise the tab context-menu route and custom fields.
  const tabPoint = await evaluate(`(() => {
    const tab = document.querySelector('.tab.active') || document.querySelector('.tab')
    const rect = tab?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  if (!tabPoint) throw new Error('Active tab not found')
  await click(send, tabPoint.x, tabPoint.y, 'right')
  await sleep(150)
  const opened = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => /PDF/i.test(node.textContent))
    button?.click()
    return !!button
  })()`)
  if (!opened) throw new Error('PDF context-menu command not found')
  await sleep(250)
  const dialog = await evaluate(`(() => {
    const studio = document.querySelector('.hm-pdf-studio')
    return {
      open: !!studio,
      sections: studio?.querySelectorAll('.hm-pdf-settings section').length || 0,
      orientationCount: studio?.querySelectorAll('.hm-pdf-segmented button').length || 0,
      switches: studio?.querySelectorAll('.hm-pdf-switch').length || 0,
      hasPreview: !!studio?.querySelector('.hm-pdf-preview')
    }
  })()`)
  if (!dialog.open || dialog.sections !== 4 || dialog.orientationCount !== 2 || dialog.switches < 5 || !dialog.hasPreview) {
    throw new Error(`PDF export studio incomplete: ${JSON.stringify(dialog)}`)
  }
  await waitForPreview(evaluate, 'initial')
  const customFields = await evaluate(`(() => {
    const select = document.querySelector('.hm-pdf-settings select')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'Custom')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  if (!customFields) throw new Error('Could not switch PDF dialog to custom size')
  await sleep(100)
  const customDialog = await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('.hm-pdf-dimension-grid input')]
    return {
      inputCount: inputs.length,
      values: inputs.map((input) => input.value),
      ranges: inputs.map((input) => [input.min, input.max])
    }
  })()`)
  if (customDialog.inputCount !== 2 || customDialog.ranges.some(([min, max]) => min !== '50' || max !== '1000')) {
    throw new Error(`PDF custom-size controls incomplete: ${JSON.stringify(customDialog)}`)
  }
  await waitForPreview(evaluate, 'custom-size')
  const preview = await evaluate(`(() => {
    const page = document.querySelector('.hm-pdf-page')
    const canvas = page?.querySelector('canvas')
    const exportButton = document.querySelector('.hm-pdf-studio-footer .primary')
    return {
      pages: document.querySelectorAll('.hm-pdf-page').length,
      canvas: [canvas?.width || 0, canvas?.height || 0],
      exportEnabled: !!exportButton && !exportButton.disabled
    }
  })()`)
  if (!preview.pages || preview.canvas.some((value) => value <= 0) || !preview.exportEnabled) {
    throw new Error(`PDF preview did not render: ${JSON.stringify(preview)}`)
  }
  const rangeValidation = await evaluate(`(() => {
    const input = [...document.querySelectorAll('.hm-pdf-settings input[type="text"]')].find((node) => /1-5/.test(node.placeholder))
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '3-1')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  if (!rangeValidation) throw new Error('PDF page-range input not found')
  await sleep(100)
  const invalidRange = await evaluate(`!!document.querySelector('.hm-pdf-field.invalid [role="alert"]')`)
  if (!invalidRange) throw new Error('Invalid PDF page range was not rejected')
  await evaluate(`document.querySelector('.hm-pdf-close')?.click()`)

  console.log(`PASS Electron UI #57–#60: ${JSON.stringify({ math, dollarMath, mathSettled, inlineText, contextMenu, dialog, customDialog, preview, invalidRange })}`)
  ws.close()
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exit(1)
})
