// CDP regression for source-mode find. Launch HorseMD with a real document and
// --remote-debugging-port first; this verifies selection, scrolling and overlay.
import { connectCdp, sleep } from './lib/cdp.mjs'

const commonQuery = process.env.FIND_QUERY || '企业'
const testModeSwitch = process.argv.includes('--mode-switch')

async function main() {
  const { ws, send, evaluate } = await connectCdp()
  await sleep(800)
  const commandModifier = await evaluate(`navigator.platform?.toLowerCase().includes('mac') ? 4 : 2`)
  await evaluate(`(() => {
    document.querySelector('.tab[title="欢迎使用 HorseMD.md"] .tab-close')?.click()
    if (!document.querySelector('textarea.source-editor')) {
      [...document.querySelectorAll('.status-btn')].find((button) => /源码|Source|Ctrl\\+\\/|⌘\\//.test(button.title || button.textContent || ''))?.click()
    }
    return true
  })()`)
  await sleep(700)
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'f', code: 'KeyF', modifiers: commandModifier,
    windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 3
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'f', code: 'KeyF', modifiers: commandModifier,
    windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 3
  })
  await sleep(150)

  const setQuery = async (query) => {
    await evaluate(`(() => {
      const input = document.querySelector('.findbar input')
      if (!input) return false
      input.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(250)
  }
  const snapshot = () => evaluate(`(() => {
    const textarea = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
    if (!textarea) return { error: 'No visible source textarea' }
    const textareaRect = textarea.getBoundingClientRect()
    const marks = [...document.querySelectorAll('.hm-source-find-current')].map((node) => {
      const rect = node.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, width: rect.width }
    })
    return {
      count: document.querySelector('.findbar-count')?.textContent || '',
      selection: [textarea.selectionStart, textarea.selectionEnd],
      scrollTop: textarea.scrollTop,
      maxScroll: Math.max(0, textarea.scrollHeight - textarea.clientHeight),
      viewportTop: textareaRect.top,
      viewportBottom: textareaRect.bottom,
      viewportCenter: (textareaRect.top + textareaRect.bottom) / 2,
      marks
    }
  })()`)
  const revealed = (state) => {
    if (!state.marks?.length) return false
    // A single current source match can paint as multiple overlay rects when the
    // selected text wraps across visual lines. Treat those fragments as one
    // revealed range instead of requiring exactly one rectangle.
    const top = Math.min(...state.marks.map((mark) => mark.top))
    const bottom = Math.max(...state.marks.map((mark) => mark.bottom))
    const centered = Math.abs((top + bottom) / 2 - state.viewportCenter) < 36
    const visible = top >= state.viewportTop && bottom <= state.viewportBottom
    const atBoundary = state.scrollTop <= 1 || state.scrollTop >= state.maxScroll - 1
    return centered || (atBoundary && visible)
  }

  const unique = await evaluate(`(() => {
    const textarea = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
    const value = textarea?.value || ''
    const words = value.slice(Math.floor(value.length * 0.7)).match(/[\\u4e00-\\u9fff]{6,12}/g) || []
    const query = words.find((word) => value.indexOf(word) === value.lastIndexOf(word))
    return query ? { query, offset: value.indexOf(query) } : null
  })()`)
  if (!unique) throw new Error('Could not find a unique late-document query')
  await setQuery(unique.query)
  const uniqueState = await snapshot()
  const uniquePass = uniqueState.selection[0] === unique.offset && revealed(uniqueState)

  await setQuery(commonQuery)
  const initial = await snapshot()
  const total = Number(initial.count.split('/')[1] || 0)
  if (total < 2) throw new Error(`Query ${JSON.stringify(commonQuery)} needs at least two matches`)
  const steps = []
  for (let i = 0; i < Math.min(10, total - 1); i++) {
    await evaluate(`document.querySelectorAll('.findbar-row')[0].querySelectorAll('button')[1].click()`)
    await sleep(150)
    steps.push(await snapshot())
  }
  const stepsPass = steps.every((state, index) =>
    state.count.startsWith(`${index + 2}/`) && state.selection[0] >= 0 && revealed(state)
  )
  let modeSwitch = null
  if (testModeSwitch) {
    const countBefore = steps.at(-1)?.count || initial.count
    const toggleMode = async () => {
      await evaluate(`([...document.querySelectorAll('.status-btn')].find((button) => /源码|Source|Ctrl\\+\\/|⌘\\//.test(button.title || button.textContent || ''))?.click(), true)`)
      await sleep(850)
    }
    const modeSnapshot = () => evaluate(`(() => {
      const textarea = document.querySelector('textarea.source-editor')
      return {
        mode: textarea ? 'source' : 'rich',
        count: document.querySelector('.findbar-count')?.textContent || '',
        selection: textarea ? [textarea.selectionStart, textarea.selectionEnd] : null,
        sourceMarks: document.querySelectorAll('.hm-source-find-current').length,
        richMatches: CSS.highlights?.get('hm-find')?.size || 0,
        richCurrent: CSS.highlights?.get('hm-find-current')?.size || 0
      }
    })()`)
    await toggleMode()
    const rich = await modeSnapshot()
    await toggleMode()
    const source = await modeSnapshot()
    modeSwitch = {
      passed: rich.mode === 'rich' && rich.count === countBefore && rich.richMatches === total && rich.richCurrent === 1 &&
        source.mode === 'source' && source.count === countBefore && source.sourceMarks === 1 &&
        source.selection?.[0] !== source.selection?.[1],
      rich,
      source
    }
  }
  const passed = uniquePass && stepsPass && (!modeSwitch || modeSwitch.passed)
  console.log(JSON.stringify({ passed, unique: { ...unique, state: uniqueState }, commonQuery, total, steps, modeSwitch }, null, 2))
  ws.close()
  process.exit(passed ? 0 : 2)
}

main().catch((error) => {
  console.error(`SOURCE_FIND_FAIL: ${error.message}`)
  process.exit(1)
})
