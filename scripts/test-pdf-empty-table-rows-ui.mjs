// A table with text only in its header and blank body rows exported to PDF
// with the body rows squashed to thin slivers: an empty cell is an empty <p>,
// which the print CSS (cell paragraph margins reset) gives zero height, so the
// row collapsed to its padding. A blank row must be as tall as a filled one.
// Measured on the final PDF: header → next paragraph distance of the blank
// table equals that of an identical filled table.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { chooseContextExportFormat } from './lib/context-menu.mjs'

const root = `/tmp/horsemd-pdf-empty-table-${process.pid}`
const fixture = join(root, 'empty-table.md')
const markdown = ['# 空表格', '', '正文第一段。', '',
  '| BlankHead | 年龄 | 备注 |', '| --- | --- | --- |', '|  |  |  |', '|  |  |  |', '|  |  |  |', '',
  'AfterBlank', '',
  '| FullHead | 年龄 | 备注 |', '| --- | --- | --- |', '| 张三 | 18 | 无 |', '| 李四 | 20 | 无 |', '| 王五 | 22 | 无 |', '',
  'AfterFull', ''].join('\n')

const waitFor = async (check, message, attempts = 150) => {
  for (let i = 0; i < attempts; i += 1) { const v = await check(); if (v) return v; await sleep(150) }
  throw new Error(message)
}

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
await writeFile(fixture, markdown, 'utf8')
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), port: 9930 + process.pid % 60, appArgs: [fixture, '--horsemd-input-trace']
})
try {
  await waitFor(() => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].find(n => n.offsetParent)?.querySelectorAll('table.children').length === 2`), 'tables did not render')
  await sleep(1200)
  await app.evaluate(`window.__HORSEMD_TEST_CAPTURE_PDF__ = true; window.__HORSEMD_TEST_CAPTURE_PDF_DATA__ = true; window.__horsemdLastPdfPreview = null; window.__horsemdLastPdfPreviewData = null`)
  const tab = await app.evaluate(`(() => { const r = (document.querySelector('.tab.active') || document.querySelector('.tab')).getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } })()`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await app.send('Input.dispatchMouseEvent', { type, button: 'right', clickCount: 1, ...tab })
  }
  await chooseContextExportFormat(app.evaluate, 'PDF')
  await waitFor(() => app.evaluate('window.__horsemdLastPdfPreview?.result?.ok === true'), 'PDF preview did not complete')
  const bytes = await waitFor(async () => {
    const data = await app.evaluate('Array.from(window.__horsemdLastPdfPreviewData || [])')
    return data.length > 1000 && data
  }, 'PDF bytes were not captured')

  const pdf = await getDocument({ data: Uint8Array.from(bytes) }).promise
  try {
    const page = await pdf.getPage(1)
    const { items } = await page.getTextContent()
    const yOf = (label) => {
      const item = items.find((candidate) => candidate.str?.trim() === label)
      assert.ok(item, `PDF text not found: ${label}`)
      return item.transform[5]
    }
    const blank = yOf('BlankHead') - yOf('AfterBlank')
    const filled = yOf('FullHead') - yOf('AfterFull')
    assert.ok(Math.abs(blank - filled) <= 2,
      `blank-row table is ${blank.toFixed(1)}pt tall vs ${filled.toFixed(1)}pt for the filled one (rows collapsed)`)
    console.log(`PASS PDF empty table rows: blank table ${blank.toFixed(1)}pt = filled table ${filled.toFixed(1)}pt`)
  } finally {
    await pdf.destroy()
  }
} finally {
  await stopBuiltElectron(app)
  await rm(root, { recursive: true, force: true })
}
