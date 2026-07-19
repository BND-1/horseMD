// Regression: wide and long Markdown tables must print all table content instead
// of clipping the right side or forcing an over-tall row to vanish.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = '/tmp/horsemd-pdf-wide-table-ui'
const port = 9361
const profileDir = `${root}/profile`
const fixture = join(root, 'wide-table-pdf.md')

const waitFor = async (evaluate, expression, message, attempts = 150) => {
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

const headers = Array.from({ length: 10 }, (_, index) => `Column ${index + 1}`)
const rows = Array.from({ length: 54 }, (_, rowIndex) =>
  headers.map((_, columnIndex) => (
    `row-${rowIndex + 1}-col-${columnIndex + 1}-` +
    'very-long-unbroken-table-value-for-pdf-wrapping'
  ))
)
const table = [
  `| ${headers.join(' | ')} |`,
  `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.join(' | ')} |`)
].join('\n')

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
await writeFile(fixture, `# Wide Table PDF

Before table.

${table}

After table.
`, 'utf8')

const app = await launchBuiltElectron({ profileDir, port, appArgs: [fixture] })

try {
  const { send, evaluate } = app
  await waitFor(
    evaluate,
    `[...document.querySelectorAll('.tab')].some((node) => /wide-table-pdf/i.test(node.textContent || ''))`,
    'Table fixture did not open'
  )
  await evaluate(`window.__HORSEMD_TEST_CAPTURE_PDF__ = true`)
  const tabPoint = await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find((node) => /wide-table-pdf/i.test(node.textContent || '')) ||
      document.querySelector('.tab.active') || document.querySelector('.tab')
    tab?.click()
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
  await waitFor(evaluate, `document.querySelectorAll('.hm-pdf-page').length >= 2`, 'Long table did not produce multiple preview pages')

  const snapshot = await evaluate(`(() => {
    const html = window.__horsemdLastPdfPreview?.source?.html || ''
    return {
      pages: document.querySelectorAll('.hm-pdf-page').length,
      hasTable: html.includes('<table'),
      hasLastCell: html.includes('row-54-col-10-very-long-unbroken-table-value-for-pdf-wrapping'),
      hasAfter: html.includes('After table.'),
      hasSourcePipe: html.includes('| Column 1 |'),
      bytes: window.__horsemdLastPdfPreview?.result?.bytes || 0
    }
  })()`)

  if (!snapshot.hasTable || !snapshot.hasLastCell || !snapshot.hasAfter || snapshot.hasSourcePipe || snapshot.pages < 2 || snapshot.bytes <= 0) {
    throw new Error(`Wide table PDF export is wrong: ${JSON.stringify(snapshot)}`)
  }
  console.log(`PASS PDF wide table UI: ${JSON.stringify(snapshot)}`)
} finally {
  await stopBuiltElectron(app)
}
