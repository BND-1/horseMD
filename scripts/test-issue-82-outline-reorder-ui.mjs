import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { moveHeadingSection } from '../src/renderer/src/outline-reorder.js'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 9652)
const fixture = join(process.cwd(), 'scripts', 'fixtures', 'outline-reorder.md')
const source = `# Alpha

Alpha keeps 0~9 and a tight list marker:
- Alpha item

## Alpha child

Alpha child body.

# Bravo

Bravo body.

## Bravo child

Bravo child body.

# Charlie

Charlie body.
`

async function waitFor(evaluate, expression, label, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    if (await evaluate(expression)) return
    await sleep(150)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function move(evaluate, fromText, targetText, placement = 'after') {
  const started = await evaluate(`(() => {
    const rowFor = (text) => [...document.querySelectorAll('.outline-item')]
      .find((row) => row.querySelector('.outline-item-text')?.textContent.trim() === text)
    const from = rowFor(${JSON.stringify(fromText)})
    const handle = from?.querySelector('.outline-drag-handle')
    if (!from || !handle) return { ok: false, rows: [...document.querySelectorAll('.outline-item')].map((row) => row.textContent) }
    const dataTransfer = new DataTransfer()
    window.__horsemdOutlineDragTransfer = dataTransfer
    handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
    return { ok: true }
  })()`)
  if (!started.ok) throw new Error(`Unable to start dragging ${fromText}: ${JSON.stringify(started)}`)
  await sleep(80)
  const result = await evaluate(`(() => {
    const rowFor = (text) => [...document.querySelectorAll('.outline-item')]
      .find((row) => row.querySelector('.outline-item-text')?.textContent.trim() === text)
    const from = rowFor(${JSON.stringify(fromText)})
    const target = rowFor(${JSON.stringify(targetText)})
    const handle = from?.querySelector('.outline-drag-handle')
    const dataTransfer = window.__horsemdOutlineDragTransfer
    if (!from || !target || !handle || !dataTransfer) return { ok: false, rows: [...document.querySelectorAll('.outline-item')].map((row) => row.textContent) }
    const rect = target.getBoundingClientRect()
    const clientY = ${JSON.stringify(placement)} === 'before' ? rect.top + 2 : rect.bottom - 2
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientY }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientY }))
    handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }))
    delete window.__horsemdOutlineDragTransfer
    return { ok: true }
  })()`)
  if (!result.ok) throw new Error(`Unable to drag ${fromText}: ${JSON.stringify(result)}`)
}

async function main() {
  const app = await launchBuiltElectron({
    profileDir: '/tmp/horsemd-issue-82-outline-reorder-ui',
    port,
    appArgs: [fixture]
  })

  try {
    await waitFor(
      app.evaluate,
      `[...document.querySelectorAll('.ProseMirror')].some((editor) => editor.offsetParent && editor.textContent.includes('Alpha child body.'))`,
      'rich outline fixture'
    )
    const outlineOpened = await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => /大纲|outline/i.test(node.title || node.getAttribute('aria-label') || ''))
      button?.click()
      return {
        clicked: !!button,
        title: button?.title || '',
        buttons: [...document.querySelectorAll('button')].map((node) => node.title || node.getAttribute('aria-label') || '').filter(Boolean)
      }
    })()`)
    if (!outlineOpened.clicked) throw new Error(`Missing outline button: ${JSON.stringify(outlineOpened)}`)
    await waitFor(
      app.evaluate,
      'document.querySelectorAll(\'.outline-drag-handle\').length >= 3',
      'outline drag handles'
    )
    const outlineState = await app.evaluate(`(() => ({
      handles: document.querySelectorAll('.outline-drag-handle').length,
      rows: [...document.querySelectorAll('.outline-item')].map((row) => row.textContent.trim()),
      sidebarMode: document.querySelector('.activity-item.active')?.title || ''
    }))()`)
    if (outlineState.handles < 3) {
      throw new Error(`Outline drag handles did not render: ${JSON.stringify({ outlineOpened, outlineState })}`)
    }

    await move(app.evaluate, 'Alpha', 'Bravo', 'after')
    const expectedRichMove = moveHeadingSection(source, 0, 2, 'after')
    await waitFor(
      app.evaluate,
      `(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return !!editor && [...editor.querySelectorAll('h1')].map((node) => node.textContent.trim()).join('|') === 'Bravo|Alpha|Charlie'
      })()`,
      'rich reordered headings'
    )
    const rich = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return {
        headings: [...editor.querySelectorAll('h1,h2')].map((node) => node.tagName + ':' + node.textContent.trim()),
        alphaChildAfterAlpha: editor.textContent.indexOf('Alpha child body.') > editor.textContent.indexOf('Alpha keeps 0~9')
      }
    })()`)
    if (!rich.alphaChildAfterAlpha || rich.headings.join('|') !== 'H1:Bravo|H2:Bravo child|H1:Alpha|H2:Alpha child|H1:Charlie') {
      throw new Error(`Rich section move lost hierarchy: ${JSON.stringify(rich)}`)
    }

    await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('.status-btn')].find((node) => /Ctrl\\+\\/?|Cmd\\+\\/?|源码|Source|富文本|Rich/.test(node.title || node.textContent || ''))
      button?.click()
      return !!button
    })()`)
    await waitFor(app.evaluate, `!![...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)`, 'source mode')
    const sourceAfterRichMove = await app.evaluate(`([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value || '')`)
    if (sourceAfterRichMove !== expectedRichMove) {
      throw new Error(`Rich drag rewrote Markdown source: ${JSON.stringify({ expectedRichMove, sourceAfterRichMove })}`)
    }

    await move(app.evaluate, 'Alpha', 'Bravo', 'before')
    await sleep(250)
    const sourceAfterSourceMove = await app.evaluate(`([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value || '')`)
    if (sourceAfterSourceMove !== source) {
      throw new Error(`Source drag did not restore exact Markdown: ${JSON.stringify({ sourceAfterSourceMove, source })}`)
    }

    await app.evaluate(`([...document.querySelectorAll('.status-btn')].find((node) => /Ctrl\\+\\/?|Cmd\\+\\/?|源码|Source|富文本|Rich/.test(node.title || node.textContent || ''))?.click(), true)`)
    await waitFor(
      app.evaluate,
      `(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return !!editor && [...editor.querySelectorAll('h1')].map((node) => node.textContent.trim()).join('|') === 'Alpha|Bravo|Charlie'
      })()`,
      'rich restoration after source move'
    )

    console.log('issue #82 outline reorder UI ok:', { rich, sourcePreserved: sourceAfterRichMove === expectedRichMove })
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
