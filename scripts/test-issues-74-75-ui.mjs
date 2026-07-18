import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const dir = '/tmp/horsemd-issues-74-75'
const file = join(dir, 'inline-math.md')

const assert = (condition, message, detail) => {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(detail)}`)
}

async function key(send, value, code = value, virtualKeyCode = value.charCodeAt(0)) {
  const params = { key: value, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

async function main() {
  await mkdir(dir, { recursive: true })
  await writeFile(file, [
    '# Inline math issue 74',
    '',
    'Protected formula: $E=mc^2$',
    '',
    'Fast formula: $a+b$'
  ].join('\n'), 'utf8')

  const app = await launchBuiltElectron({
    profileDir: join(dir, 'profile'),
    port: Number(process.env.CDP_PORT || 9475),
    appArgs: [file]
  })
  const { send, evaluate } = app

  try {
    await sleep(1300)
    await evaluate(`(() => {
      window.queryLocalFonts = async () => [
        { family: 'A Very Long Font Family Name That Should Stay Readable In HorseMD Settings' },
        { family: 'HorseMD Mono' }
      ]
    })()`)

    const placeCaretAfter = async (value) => evaluate(`(() => {
      const atom = [...document.querySelectorAll('[data-type="math_inline"]')]
        .find((node) => node.offsetParent && node.dataset.value === ${JSON.stringify(value)})
      if (!atom) return false
      atom.scrollIntoView({ block: 'center' })
      const range = document.createRange()
      range.setStartAfter(atom)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      atom.closest('.ProseMirror')?.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)

    assert(await placeCaretAfter('E=mc^2'), 'Could not place caret after protected formula')
    await key(send, 'Backspace', 'Backspace', 8)
    await sleep(300)
    const selected = await evaluate(`(() => {
      const atom = [...document.querySelectorAll('[data-type="math_inline"]')]
        .find((node) => node.offsetParent && node.dataset.value === 'E=mc^2')
      return {
        exists: !!atom,
        selected: atom?.classList.contains('ProseMirror-selectednode') || false,
        background: atom ? getComputedStyle(atom).backgroundColor : ''
      }
    })()`)
    assert(selected.exists && selected.selected, 'Protected delete did not select the inline formula first', selected)

    await key(send, 'Backspace', 'Backspace', 8)
    await sleep(300)
    const deleted = await evaluate(`(() => !![...document.querySelectorAll('[data-type="math_inline"]')]
      .find((node) => node.offsetParent && node.dataset.value === 'E=mc^2'))()`)
    assert(!deleted, 'Second delete did not remove selected inline formula')

    const atomPoint = await evaluate(`(() => {
      const atom = [...document.querySelectorAll('[data-type="math_inline"]')]
        .find((node) => node.offsetParent && node.dataset.value === 'a+b')
      const rect = atom?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`)
    assert(atomPoint, 'Fast formula atom missing')
    await click(send, atomPoint)
    await sleep(350)
    const clearButton = await evaluate(`(() => {
      const popup = [...document.querySelectorAll('.milkdown-latex-inline-edit')].find((node) => node.offsetParent)
      const clear = popup?.querySelector('.hm-inline-math-clear')
      return clear ? {
        text: clear.textContent.trim(),
        title: clear.title,
        buttons: [...popup.querySelectorAll('button')].map((button) => button.textContent.trim())
      } : null
    })()`)
    assert(clearButton && /Clear|清空/.test(clearButton.text), 'Inline math edit popup missing clear button', clearButton)

    await evaluate(`(() => {
      const popup = [...document.querySelectorAll('.milkdown-latex-inline-edit')].find((node) => node.offsetParent)
      popup?.querySelector('.hm-inline-math-clear')?.click()
      return true
    })()`)
    await sleep(300)
    const cleared = await evaluate(`(() => {
      const popup = [...document.querySelectorAll('.milkdown-latex-inline-edit')].find((node) => node.offsetParent)
      return popup?.querySelector('.ProseMirror')?.textContent || ''
    })()`)
    assert(cleared === '', 'Clear button did not empty inline math editor', cleared)

    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const visible = (element) => {
        if (!element) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const textOf = (element) => element?.textContent?.replace(/\\s+/g, ' ').trim() || ''
      const buttons = () => [...document.querySelectorAll('button')].filter(visible)
      const clickButton = async (predicate, label) => {
        const button = buttons().find(predicate)
        if (!button) throw new Error('Missing button: ' + label)
        button.click()
        await sleep(260)
        return button
      }
      await clickButton(
        (button) => button.title === '设置' || button.title === 'Settings' || textOf(button) === '设置' || textOf(button) === 'Settings',
        'settings'
      )
      await clickButton((button) => ['编辑器', 'Editor'].includes(textOf(button)), 'editor settings')
      await clickButton((button) => ['快速', 'Fast'].includes(textOf(button)), 'fast inline math delete')
      const docTab = [...document.querySelectorAll('.tab')].find((tab) => /inline-math\\.md/.test(textOf(tab)))
      if (!docTab) throw new Error('Missing inline math document tab')
      docTab.click()
      await sleep(400)
      return true
    })()`)
    assert(await placeCaretAfter('a+b'), 'Could not place caret after fast formula')
    await key(send, 'Backspace', 'Backspace', 8)
    await sleep(350)
    const fast = await evaluate(`(() => {
      const atom = [...document.querySelectorAll('[data-type="math_inline"]')]
        .find((node) => node.offsetParent && node.dataset.value === 'a+b')
      return {
        exists: !!atom,
        selected: atom?.classList.contains('ProseMirror-selectednode') || false
      }
    })()`)
    assert(!fast.exists, 'Fast delete mode should delete inline formula with one keypress', fast)

    const fontResult = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const visible = (element) => {
        if (!element) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const textOf = (element) => element?.textContent?.replace(/\\s+/g, ' ').trim() || ''
      const buttons = () => [...document.querySelectorAll('button')].filter(visible)
      const clickButton = async (predicate, label) => {
        const button = buttons().find(predicate)
        if (!button) throw new Error('Missing button: ' + label)
        button.click()
        await sleep(260)
        return button
      }
      await clickButton(
        (button) => button.title === '设置' || button.title === 'Settings' || textOf(button) === '设置' || textOf(button) === 'Settings',
        'settings'
      )
      await clickButton((button) => ['编辑器', 'Editor'].includes(textOf(button)), 'editor settings')
      const field = [...document.querySelectorAll('.settings-font-field')].filter(visible)[0]
      if (!field) throw new Error('Missing font field')
      field.click()
      await sleep(350)
      const option = [...document.querySelectorAll('.settings-font-option')].filter(visible)
        .find((node) => /A Very Long Font Family Name/.test(textOf(node)))
      if (!option) throw new Error('Missing long font option')
      return JSON.stringify({
        text: textOf(option),
        title: option.title,
        hasSample: !!option.querySelector('.settings-font-sample'),
        hasName: !!option.querySelector('.settings-font-name')
      })
    })()`)
    const font = JSON.parse(fontResult)
    assert(font.title === font.text && font.hasName && !font.hasSample, 'Font option did not show name-only full-title UI', font)

    console.log(`PASS issues 74-75 UI: ${JSON.stringify({ selected, clearButton, fast, font })}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
