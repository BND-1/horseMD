import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-table-click-${process.pid}`
const file = join(root, 't.md')
const port = Number(process.env.CDP_PORT || 9991)
const sleepMs = (ms) => sleep(ms)

async function waitFor(check, message, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleepMs(100)
  }
  throw new Error(message)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '# 标题\n\n| 甲 | 乙 |\n| --- | --- |\n| 内容1 | 内容2 |\n')
  const app = await launchBuiltElectron({ profileDir: join(root, 'p'), port, appArgs: [file] })
  const { evaluate, send } = app
  try {
    await waitFor(() => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`), 'no editor')
    await sleepMs(800)
    // single click into the cell containing 内容2
    const point = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const cell = [...editor.querySelectorAll('td')].find((td) => td.textContent.trim() === '内容2')
      if (!cell) return null
      const rect = cell.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    if (!point) { console.log('cell not found'); process.exit(1) }
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await sleepMs(500)
    const caret = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const sel = getSelection()
      const node = sel?.anchorNode
      const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node
      const cell = element?.closest?.('td, th')
      return cell ? { cellText: cell.textContent, offset: sel.anchorOffset, collapsed: sel.isCollapsed } : null
    })()`)
    console.log('CARET_AFTER_SINGLE_CLICK:', JSON.stringify(caret))
    // type a character — it should land in the cell
    await send('Input.insertText', { text: 'X' })
    await sleepMs(500)
    const afterType = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const cell = [...editor.querySelectorAll('td')].find((td) => td.textContent.includes('X'))
      return cell ? cell.textContent : null
    })()`)
    console.log('AFTER_TYPE:', afterType)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
