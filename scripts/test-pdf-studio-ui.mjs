// Real Electron regression for the browser-style PDF export studio.
// Launch HorseMD with scripts/fixtures/issues-57-60.md and CDP enabled first.
import { connectCdp, sleep } from './lib/cdp.mjs'

const waitFor = async (evaluate, expression, message, attempts = 100) => {
  for (let index = 0; index < attempts; index += 1) {
    if (await evaluate(expression)) return
    await sleep(200)
  }
  throw new Error(message)
}

const setInput = (evaluate, selector, value) => evaluate(`(() => {
  const input = document.querySelector(${JSON.stringify(selector)})
  if (!input) return false
  const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)})
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  return true
})()`)

const clickSwitch = async (send, evaluate, pattern) => {
  const point = await evaluate(`(() => {
  const label = [...document.querySelectorAll('.hm-pdf-switch')].find((node) => ${pattern}.test(node.textContent || ''))
  if (!label) return null
  label.scrollIntoView({ block: 'center' })
  const rect = label.getBoundingClientRect()
  return { x: rect.left + 15, y: rect.top + rect.height / 2 }
})()`)
  if (!point) return false
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  return true
}

const waitPreview = async (evaluate, previousToken = '') => {
  await sleep(420)
  await waitFor(
    evaluate,
    `(() => {
      const preview = document.querySelector('.hm-pdf-preview')
      return !!preview?.dataset.previewToken && preview.dataset.previewToken !== ${JSON.stringify(previousToken)} &&
        !document.querySelector('.hm-pdf-preview-progress') && !document.querySelector('.hm-pdf-preview-error') &&
        !document.querySelector('.hm-pdf-studio-footer .primary')?.disabled
    })()`,
    'PDF preview did not become ready'
  )
}

const snapshot = (evaluate) => evaluate(`(() => {
  const canvas = document.querySelector('.hm-pdf-page canvas')
  return {
    pages: document.querySelectorAll('.hm-pdf-page').length,
    width: canvas?.width || 0,
    height: canvas?.height || 0,
    outline: Number(document.querySelector('.hm-pdf-preview')?.dataset.outlineCount || 0),
    outlinePanel: !!document.querySelector('.hm-pdf-outline'),
    token: document.querySelector('.hm-pdf-preview')?.dataset.previewToken || '',
    error: document.querySelector('.hm-pdf-preview-error')?.textContent || ''
  }
})()`)

const main = async () => {
  const { ws, send, evaluate } = await connectCdp()
  await evaluate(`document.querySelector('.hm-pdf-close')?.click()`)
  const menuOpened = await evaluate(`(() => {
    const tab = document.querySelector('.tab.active') || document.querySelector('.tab')
    if (!tab) return false
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 20, button: 2 }))
    return true
  })()`)
  if (!menuOpened) throw new Error('Active tab not found')
  await waitFor(evaluate, `[...document.querySelectorAll('button')].some((node) => /PDF/i.test(node.textContent || ''))`, 'PDF export command not found')
  await evaluate(`([...document.querySelectorAll('button')].find((node) => /PDF/i.test(node.textContent || ''))?.click(), true)`)
  await waitFor(evaluate, `!!document.querySelector('.hm-pdf-studio')`, 'PDF studio did not open')
  await waitPreview(evaluate)

  const switchHitTest = await evaluate(`(() => {
    for (const button of document.querySelectorAll('.hm-pdf-switch')) {
      button.scrollIntoView({ block: 'center' })
      const track = button.querySelector('.hm-pdf-switch-track')
      const rect = track?.getBoundingClientRect()
      if (!rect) return false
      const points = [rect.left + 2, rect.left + rect.width / 2, rect.right - 2]
      if (!points.every((x) => document.elementFromPoint(x, rect.top + rect.height / 2) === button)) return false
    }
    return true
  })()`)
  if (!switchHitTest) throw new Error('PDF switch visual track is not aligned with its pointer target')

  const portrait = await snapshot(evaluate)
  if (!(portrait.width > 0 && portrait.height > portrait.width && portrait.outline > 0 && !portrait.outlinePanel)) {
    throw new Error(`Default portrait/bookmark preview is wrong: ${JSON.stringify(portrait)}`)
  }
  await evaluate(`document.querySelector('.hm-pdf-preview-leading > button')?.click()`)
  await waitFor(evaluate, `!!document.querySelector('.hm-pdf-outline')`, 'Embedded PDF outline did not open')
  const outlineShown = await snapshot(evaluate)
  if (!outlineShown.outlinePanel) throw new Error(`PDF outline panel did not open: ${JSON.stringify(outlineShown)}`)

  await evaluate(`([...document.querySelectorAll('.hm-pdf-segmented button')].find((node) => /横向|Landscape/i.test(node.textContent))?.click(), true)`)
  await waitPreview(evaluate, portrait.token)
  const landscape = await snapshot(evaluate)
  if (!(landscape.width > landscape.height)) throw new Error(`Landscape preview ratio is wrong: ${JSON.stringify(landscape)}`)

  if (!(await clickSwitch(send, evaluate, `/目录页|contents page/i`))) throw new Error('TOC switch not found')
  const tocFeedback = await evaluate(`(() => {
    const toggle = [...document.querySelectorAll('.hm-pdf-switch')].find((node) => /目录页|contents page/i.test(node.textContent || ''))
    return { enabled: toggle?.getAttribute('aria-checked') === 'true', updating: !!document.querySelector('.hm-pdf-preview-progress') }
  })()`)
  if (!tocFeedback.enabled || !tocFeedback.updating) throw new Error(`TOC switch gave no immediate feedback: ${JSON.stringify(tocFeedback)}`)
  await waitPreview(evaluate, landscape.token)
  const toc = await snapshot(evaluate)
  if (toc.pages < portrait.pages + 1) throw new Error(`Printed TOC did not add a page: ${JSON.stringify(toc)}`)

  if (!(await clickSwitch(send, evaluate, `/PDF 导航大纲|PDF navigation outline/i`))) throw new Error('PDF outline switch not found')
  await waitPreview(evaluate, toc.token)
  const noOutline = await snapshot(evaluate)
  if (noOutline.outline !== 0 || noOutline.outlinePanel) throw new Error(`PDF bookmarks were not disabled: ${JSON.stringify(noOutline)}`)

  const rangeSelector = '.hm-pdf-settings section:last-child input'
  await setInput(evaluate, rangeSelector, '3-1')
  await sleep(100)
  if (!(await evaluate(`!!document.querySelector('.hm-pdf-field.invalid [role="alert"]')`))) {
    throw new Error('Invalid page range was accepted')
  }
  await setInput(evaluate, rangeSelector, '1')
  await waitPreview(evaluate, noOutline.token)
  const range = await snapshot(evaluate)
  if (range.pages !== 1) throw new Error(`Page range did not limit preview: ${JSON.stringify(range)}`)

  // Only the final value in a rapid change burst may win.
  await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.hm-pdf-segmented button')]
    buttons[0].click(); buttons[1].click(); buttons[0].click()
  })()`)
  await waitPreview(evaluate, range.token)
  const finalPortrait = await snapshot(evaluate)
  if (!(finalPortrait.height > finalPortrait.width)) {
    throw new Error(`A stale preview overwrote the final settings: ${JSON.stringify(finalPortrait)}`)
  }

  await evaluate(`document.querySelector('.hm-pdf-close')?.click()`)
  await evaluate(`([...document.querySelectorAll('.status-btn')].find((node) => /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))?.click(), true)`)
  await waitFor(evaluate, `!![...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)`, 'Source mode did not open')
  await evaluate(`(() => {
    const textarea = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
    textarea.setRangeText('\\n\\n# Source export marker\\n', textarea.value.length, textarea.value.length, 'end')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(100)
  await evaluate(`(() => {
    const tab = document.querySelector('.tab.active') || document.querySelector('.tab')
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 20, button: 2 }))
  })()`)
  await waitFor(evaluate, `[...document.querySelectorAll('button')].some((node) => /PDF/i.test(node.textContent || ''))`, 'Source-mode PDF command not found')
  await evaluate(`([...document.querySelectorAll('button')].find((node) => /PDF/i.test(node.textContent || ''))?.click(), true)`)
  await waitFor(evaluate, `!!document.querySelector('.hm-pdf-studio')`, 'Source-mode PDF studio did not open')
  await waitPreview(evaluate)
  const sourceExport = await evaluate(`({ headings: Number(document.querySelector('.hm-pdf-studio')?.dataset.sourceHeadings || 0), outline: Number(document.querySelector('.hm-pdf-preview')?.dataset.outlineCount || 0) })`)
  if (sourceExport.headings < 3 || sourceExport.outline < 2) {
    throw new Error(`Source edits were not synchronized into PDF: ${JSON.stringify(sourceExport)}`)
  }
  await evaluate(`document.querySelector('.hm-pdf-close')?.click()`)
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => /command palette|命令面板/i.test(node.title || node.getAttribute('aria-label') || ''))
    button?.click()
    return !!button
  })()`)
  await waitFor(evaluate, `!!document.querySelector('.palette')`, 'Command palette did not open')
  await waitFor(evaluate, `[...document.querySelectorAll('.palette-item')].some((node) => /PDF/i.test(node.textContent || ''))`, 'Global PDF command not found')
  await evaluate(`([...document.querySelectorAll('.palette-item')].find((node) => /PDF/i.test(node.textContent || ''))?.click(), true)`)
  await waitFor(evaluate, `!!document.querySelector('.hm-pdf-studio')`, 'Global PDF command did not open the studio')
  await waitPreview(evaluate)
  const shortcutExport = await evaluate(`Number(document.querySelector('.hm-pdf-studio')?.dataset.sourceHeadings || 0)`)
  if (shortcutExport < 3) throw new Error(`Global PDF command used stale source: ${shortcutExport}`)
  await evaluate(`document.querySelector('.hm-pdf-close')?.click()`)
  console.log(`PASS PDF studio UI: ${JSON.stringify({ portrait, outlineShown, landscape, toc, noOutline, range, finalPortrait, sourceExport, shortcutExport })}`)
  ws.close()
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exit(1)
})
