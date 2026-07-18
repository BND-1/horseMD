// Regression: display LaTeX blocks must export as rendered math, not fenced
// source code, in the browser-style PDF studio.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = '/tmp/horsemd-pdf-latex-ui'
const port = 9352
const profileDir = `${root}/profile`
const fixture = join(root, 'latex-pdf.md')

const waitFor = async (evaluate, expression, message, attempts = 120) => {
  for (let index = 0; index < attempts; index += 1) {
    if (await evaluate(expression)) return
    await sleep(200)
  }
  throw new Error(message)
}

const click = async (send, x, y, button = 'left') => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
}

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
await writeFile(fixture, `# Latex PDF Export

Before formula.

$$
E = mc^2
$$

After formula.
`, 'utf8')

const app = await launchBuiltElectron({ profileDir, port, appArgs: [fixture] })

try {
  const { send, evaluate } = app
  await sleep(1200)
  await evaluate(`window.__HORSEMD_TEST_CAPTURE_PDF__ = true`)
  const tabPoint = await evaluate(`(() => {
    const tab = document.querySelector('.tab.active') || document.querySelector('.tab')
    const rect = tab?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  if (!tabPoint) throw new Error('Active tab not found')
  await click(send, tabPoint.x, tabPoint.y, 'right')
  await waitFor(
    evaluate,
    `[...document.querySelectorAll('button')].some((node) => /PDF/i.test(node.textContent || ''))`,
    'PDF export command not found'
  )
  await evaluate(`([...document.querySelectorAll('button')].find((node) => /PDF/i.test(node.textContent || ''))?.click(), true)`)
  await waitFor(evaluate, `!!document.querySelector('.hm-pdf-studio')`, 'PDF studio did not open')
  await waitFor(evaluate, `window.__horsemdLastPdfPreview?.result?.ok === true`, 'PDF preview did not complete')

  const snapshot = await evaluate(`(() => {
    const capture = window.__horsemdLastPdfPreview
    const html = capture?.source?.html || ''
    const figure = html.match(/<figure>[\\s\\S]*?<\\/figure>/)?.[0] || ''
    return {
      hasMath: html.includes('<math') && html.includes('display="block"'),
      hasFigure: html.includes('<figure><math'),
      hasSourcePre: html.includes('<pre><code>E = mc^2</code></pre>'),
      hasRawFormula: html.includes('E = mc^2'),
      hasEditorControls: /LaTeX|编辑代码|Edit code|复制|Copy/.test(html),
      bytes: capture?.result?.bytes || 0,
      warnings: capture?.result?.warnings || null,
      figure
    }
  })()`)

  if (!snapshot.hasMath || !snapshot.hasFigure || snapshot.hasSourcePre || snapshot.hasRawFormula || snapshot.hasEditorControls || snapshot.bytes <= 0) {
    throw new Error(`Display LaTeX PDF export is wrong: ${JSON.stringify(snapshot)}`)
  }
  console.log(`PASS PDF LaTeX UI: ${JSON.stringify(snapshot)}`)
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
}
