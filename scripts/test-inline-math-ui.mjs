import { connectCdp, sleep } from './lib/cdp.mjs'

const assert = (condition, message, detail) => {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(detail)}`)
}

async function main() {
  const { ws, send, evaluate } = await connectCdp()
  await send('Runtime.enable')
  await sleep(1000)

  const selectBeforeLastDollar = async (paragraphIndex) => evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror.editor')].find((node) => node.offsetParent)
    const paragraph = editor?.children[${paragraphIndex}]
    const text = paragraph?.firstChild
    if (!editor || !text || text.nodeType !== Node.TEXT_NODE) return false
    const range = document.createRange()
    range.setStart(text, text.textContent.length - 1)
    range.collapse(true)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)

  const clickHeading = async () => {
    const point = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror.editor')].find((node) => node.offsetParent)
      const rect = editor?.querySelector('h1')?.getBoundingClientRect()
      return rect ? { x: rect.left + 20, y: rect.top + rect.height / 2 } : null
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await sleep(250)
  }

  assert(await selectBeforeLastDollar(1), 'Could not place caret inside abc$$')
  await send('Input.insertText', { text: '1^2' })
  await sleep(250)
  const inserted = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror.editor')].find((node) => node.offsetParent)
    const tip = document.querySelector('.hm-math-preview')
    return {
      text: editor?.children[1]?.textContent,
      previewVisible: tip && getComputedStyle(tip).display !== 'none',
      tex: tip?.querySelector('annotation')?.textContent
    }
  })()`)
  assert(inserted.text === 'abc$1^2$' && inserted.previewVisible && inserted.tex === '1^2',
    'Editing inside a pre-typed dollar pair did not preview', inserted)
  await clickHeading()
  const converted = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror.editor')].find((node) => node.offsetParent)
    return editor?.children[1]?.querySelector('[data-type="math_inline"]')?.dataset.value
  })()`)
  assert(converted === '1^2', 'Completed inline math did not convert after leaving it', converted)

  assert(await selectBeforeLastDollar(3), 'Could not place caret inside pure-digit $$')
  await send('Input.insertText', { text: '123' })
  await sleep(250)
  const digits = await evaluate(`(() => {
    const tip = document.querySelector('.hm-math-preview')
    return {
      visible: tip && getComputedStyle(tip).display !== 'none',
      tex: tip?.querySelector('annotation')?.textContent
    }
  })()`)
  assert(digits.visible && digits.tex === '123', 'Pure-digit inline math did not preview', digits)
  await clickHeading()

  const atomPoint = await evaluate(`(() => {
    const atom = [...document.querySelectorAll('[data-type="math_inline"]')]
      .find((node) => node.offsetParent && node.dataset.value === 'E=mc^2')
    const rect = atom?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  assert(atomPoint, 'Existing inline math atom not found')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...atomPoint })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...atomPoint, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...atomPoint, button: 'left', clickCount: 1 })
  await sleep(250)
  const focused = await evaluate(`(() => {
    const popup = [...document.querySelectorAll('.milkdown-latex-inline-edit')].find((node) => node.offsetParent)
    const inner = popup?.querySelector('.ProseMirror')
    if (!inner?.firstChild) return false
    const range = document.createRange()
    range.setStart(inner.firstChild, inner.firstChild.textContent.length)
    range.collapse(true)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    inner.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert(focused, 'Existing inline math editor did not open')
  await send('Input.insertText', { text: '+x_2' })
  await sleep(250)
  const edited = await evaluate(`(() => {
    const popup = [...document.querySelectorAll('.milkdown-latex-inline-edit')].find((node) => node.offsetParent)
    const tip = document.querySelector('.hm-math-preview')
    return {
      source: popup?.querySelector('.ProseMirror')?.textContent,
      visible: tip && getComputedStyle(tip).display !== 'none',
      tex: tip?.querySelector('annotation')?.textContent
    }
  })()`)
  assert(edited.source === 'E=mc^2+x_2' && edited.visible && edited.tex === edited.source,
    'Existing inline math edit did not update its live preview', edited)

  const confirm = await evaluate(`(() => {
    const popup = [...document.querySelectorAll('.milkdown-latex-inline-edit')].find((node) => node.offsetParent)
    const rect = popup?.querySelector('button')?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...confirm })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...confirm, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...confirm, button: 'left', clickCount: 1 })
  await sleep(250)
  const savedValue = await evaluate(`(() => [...document.querySelectorAll('[data-type="math_inline"]')]
    .find((node) => node.offsetParent && node.dataset.value.includes('+x_2'))?.dataset.value)()`)
  assert(savedValue === 'E=mc^2+x_2', 'Confirmed inline math edit did not update the document', savedValue)

  console.log('PASS inline math UI: middle insertion, digits, conversion, re-edit preview, and confirm')
  ws.close()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
