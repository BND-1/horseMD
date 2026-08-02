// Regression for #91: a C++ code block ending in a hexadecimal-looking token
// followed by a numeric line must remain literal code in the PDF source.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { chooseContextExportFormat } from './lib/context-menu.mjs'

const root = '/tmp/horsemd-issue-91-pdf-codeblock'
const port = 9367
const profileDir = `${root}/profile`
const fixture = join(root, 'issue-91.md')
const sourceCode = '0X16f5a708c\n2'

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
await writeFile(fixture, `# Issue 91\n\n\`\`\`c++\n${sourceCode}\n\`\`\`\n`, 'utf8')

const app = await launchBuiltElectron({ profileDir, port, appArgs: [fixture] })

try {
  const { send, evaluate } = app
  await waitFor(
    evaluate,
    `(() => {
      const visible = (node) => Boolean(node?.offsetParent)
      const editor = [...document.querySelectorAll('.ProseMirror')].find(visible)
      return editor?.querySelector('.milkdown-code-block .cm-editor')?.textContent?.includes('0X16f5a708c')
    })()`,
    'C++ code block did not render'
  )
  await evaluate(`window.__HORSEMD_TEST_CAPTURE_PDF__ = true`)
  const tabPoint = await evaluate(`(() => {
    const tab = document.querySelector('.tab.active') || document.querySelector('.tab')
    const rect = tab?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  if (!tabPoint) throw new Error('Active tab not found')
  await click(send, tabPoint.x, tabPoint.y, 'right')
  await chooseContextExportFormat(evaluate, 'PDF')
  await waitFor(evaluate, `window.__horsemdLastPdfPreview?.result?.ok === true`, 'PDF preview did not complete')

  const snapshot = await evaluate(`(() => {
    const html = window.__horsemdLastPdfPreview?.source?.html || ''
    const code = document.createElement('template')
    code.innerHTML = html
    return {
      codeText: code.content.querySelector('pre > code')?.textContent || '',
      hasPre: !!code.content.querySelector('pre > code'),
      bytes: window.__horsemdLastPdfPreview?.result?.bytes || 0
    }
  })()`)

  if (!snapshot.hasPre || snapshot.codeText !== sourceCode || snapshot.bytes <= 0) {
    throw new Error(`Issue #91 PDF code block changed: ${JSON.stringify(snapshot)}`)
  }
  console.log(`PASS issue #91 PDF code block: ${JSON.stringify(snapshot)}`)
} finally {
  await stopBuiltElectron(app)
}
