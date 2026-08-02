import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { chooseContextExportFormat } from './lib/context-menu.mjs'

const root = `/tmp/horsemd-pdf-table-layout-${process.pid}`
const fixture = join(root, 'table-layout.md')
const pdfPath = join(root, 'table-layout.pdf')
const pngPath = join(root, 'table-layout.png')
const profileDir = join(root, 'profile')
const port = 9670 + (process.pid % 200)
const markdown = `# Table layout fidelity

| ID | Project name | Detailed explanation |
| --- | --- | --- |
| 1 | Alpha | A substantially longer explanation that should receive most of the available table width. |
| 2 | Beta release | Another detailed note used to keep the final column visibly wider than the short identifier. |
`

const waitFor = async (check, message, attempts = 120) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(150)
  }
  throw new Error(message)
}

const click = async (app, point, button = 'left') => {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point })
}

const openPdfStudio = async (app) => {
  await app.evaluate(`(() => {
    window.__horsemdLastPdfPreview = null
    window.__horsemdLastPdfPreviewData = null
    return true
  })()`)
  const tabPoint = await app.evaluate(`(() => {
    const tab = document.querySelector('.tab.active') || document.querySelector('.tab')
    const rect = tab?.getBoundingClientRect()
    return rect ? { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 } : null
  })()`)
  assert.ok(tabPoint, 'Active document tab was not found')
  await click(app, tabPoint, 'right')
  await chooseContextExportFormat(app.evaluate, 'PDF')
  await waitFor(
    () => app.evaluate(`window.__horsemdLastPdfPreview?.result?.ok === true`),
    'PDF preview did not complete'
  )
}

const closePdfStudio = async (app) => {
  const point = await app.evaluate(`(() => {
    const button = document.querySelector('.hm-pdf-close')
    const rect = button?.getBoundingClientRect()
    return rect ? { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 } : null
  })()`)
  assert.ok(point, 'PDF Studio close button was not found')
  await click(app, point)
  await waitFor(
    () => app.evaluate(`!document.querySelector('.hm-pdf-studio')`),
    'PDF Studio did not close'
  )
}

const readEditorLayout = (app) => app.evaluate(`(() => {
  const root = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const table = root?.querySelector('.milkdown-table-block table.children')
  const wrapper = table?.closest('.table-wrapper')
  const cells = [...(table?.rows?.[0]?.cells || [])]
  const widths = cells.map((cell) => cell.getBoundingClientRect().width)
  const lefts = cells.map((cell) => cell.getBoundingClientRect().left)
  return {
    widths,
    lefts,
    rowHeights: [...(table?.rows || [])].map((row) => row.getBoundingClientRect().height),
    tableWidth: table?.getBoundingClientRect().width || 0,
    wrapperWidth: wrapper?.getBoundingClientRect().width || 0,
    manual: Boolean(table?.dataset.hmColumnWidths === 'true' || cells.some((cell) => cell.hasAttribute('data-colwidth')))
  }
})()`)

const readSourceLayout = (app) => app.evaluate(`(() => {
  const template = document.createElement('template')
  template.innerHTML = window.__horsemdLastPdfPreview?.source?.html || ''
  const table = template.content.querySelector('table')
  return {
    layout: table?.dataset.hmPdfTableLayout || '',
    wide: table?.dataset.hmPdfTableWide || '',
    width: table?.style.width || '',
    maxWidth: table?.style.maxWidth || '',
    columns: [...(table?.querySelectorAll(':scope > colgroup > col') || [])]
      .map((column) => column.style.width)
  }
})()`)

const dragFirstColumnWider = async (app) => {
  const target = await app.evaluate(`(() => {
    const root = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const cell = root?.querySelector('.milkdown-table-block td')
    const rect = cell?.getBoundingClientRect()
    return rect ? {
      x: rect.right - 2,
      y: (rect.top + rect.bottom) / 2,
      width: rect.width
    } : null
  })()`)
  assert.ok(target, 'First table column boundary was not found')
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await sleep(180)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: target.x,
    y: target.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await sleep(280)
  assert.equal(
    await app.evaluate(`document.body.classList.contains('hm-table-resizing')`),
    true,
    'Long press did not enter table column resize mode'
  )
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x + 72,
    y: target.y,
    button: 'left',
    buttons: 1
  })
  await sleep(100)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: target.x + 72,
    y: target.y,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })
  await waitFor(async () => {
    const layout = await readEditorLayout(app)
    return layout.manual && layout.widths[0] > target.width + 40 ? layout : null
  }, 'Dragged table column width did not persist')
}

const ratios = (widths) => {
  const total = widths.reduce((sum, width) => sum + width, 0)
  return widths.map((width) => width / total)
}

const relativeDifference = (left, right) => Math.abs(left - right) / Math.max(left, right)

async function inspectPdf(pdfBytes) {
  const loadingTask = getDocument({ data: Uint8Array.from(pdfBytes) })
  const document = await loadingTask.promise
  try {
    const page = await document.getPage(1)
    const text = await page.getTextContent()
    const xOf = (label) => {
      const item = text.items.find((candidate) => candidate.str?.trim() === label)
      assert.ok(item, `PDF text item was not found: ${label}`)
      return item.transform[4]
    }
    const starts = ['ID', 'Project name', 'Detailed explanation'].map(xOf)
    const startDeltas = [starts[1] - starts[0], starts[2] - starts[1]]
    const yOf = (label) => {
      const item = text.items.find((candidate) => candidate.str?.trim() === label)
      assert.ok(item, `PDF text item was not found: ${label}`)
      return item.transform[5]
    }
    const headerToFirstRow = yOf('ID') - yOf('1')

    const viewport = page.getViewport({ scale: 1.5 })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    await writeFile(pngPath, canvas.toBuffer('image/png'))
    return { starts, startDeltas, headerToFirstRow }
  } finally {
    await document.destroy()
  }
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(fixture, markdown, 'utf8')
  const app = await launchBuiltElectron({ profileDir, port, appArgs: [fixture] })
  try {
    await waitFor(
      () => app.evaluate(`(() => {
        const root = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        const table = root?.querySelector('.milkdown-table-block table.children')
        return Boolean(table?.rows?.[0]?.cells?.length === 3 && table.getBoundingClientRect().width > 0)
      })()`),
      'Markdown table did not render'
    )
    const editor = await readEditorLayout(app)
    assert.equal(editor.widths.length, 3, `Editor table did not have three columns: ${JSON.stringify(editor)}`)
    assert.ok(editor.widths[2] > editor.widths[0] * 2, `Editor table was not content-adaptive: ${JSON.stringify(editor)}`)
    assert.ok(editor.tableWidth < editor.wrapperWidth - 1, `Fixture table was not compact in the editor: ${JSON.stringify(editor)}`)

    await app.evaluate(`(() => {
      window.__HORSEMD_TEST_CAPTURE_PDF__ = true
      window.__HORSEMD_TEST_CAPTURE_PDF_DATA__ = true
      return true
    })()`)
    await openPdfStudio(app)
    const sourceLayout = await readSourceLayout(app)
    assert.equal(sourceLayout.layout, 'measured', `PDF source lost measured table layout: ${JSON.stringify(sourceLayout)}`)
    assert.equal(sourceLayout.wide, '', `Compact table was incorrectly classified as wide: ${JSON.stringify(sourceLayout)}`)
    assert.match(sourceLayout.width, /px$/, `Compact PDF table did not retain its natural width: ${JSON.stringify(sourceLayout)}`)
    assert.equal(sourceLayout.maxWidth, '100%', `PDF table was not bounded to the page: ${JSON.stringify(sourceLayout)}`)
    assert.equal(sourceLayout.columns.length, 3, `PDF source lost column proportions: ${JSON.stringify(sourceLayout)}`)

    const sourceRatios = sourceLayout.columns.map((width) => Number.parseFloat(width) / 100)
    const editorRatios = ratios(editor.widths)
    sourceRatios.forEach((ratio, index) => {
      assert.ok(
        relativeDifference(ratio, editorRatios[index]) < 0.02,
        `PDF source column ${index + 1} differs from the editor: ${JSON.stringify({ editorRatios, sourceRatios })}`
      )
    })

    const pdfBytes = await app.evaluate(`Array.from(window.__horsemdLastPdfPreviewData || [])`)
    assert.ok(pdfBytes.length > 1000, 'PDF preview bytes were not captured')
    await writeFile(pdfPath, Uint8Array.from(pdfBytes))
    const pdf = await inspectPdf(pdfBytes)
    const editorStartDeltas = [
      editor.lefts[1] - editor.lefts[0],
      editor.lefts[2] - editor.lefts[1]
    ]
    const editorDeltaRatio = editorStartDeltas[0] / editorStartDeltas[1]
    const pdfDeltaRatio = pdf.startDeltas[0] / pdf.startDeltas[1]
    assert.ok(
      relativeDifference(editorDeltaRatio, pdfDeltaRatio) < 0.12,
      `Exported PDF column starts differ from the editor: ${JSON.stringify({ editor, sourceLayout, pdf, editorDeltaRatio, pdfDeltaRatio })}`
    )
    assert.ok(
      Math.abs(pdf.startDeltas[0] - pdf.startDeltas[1]) > 8,
      `Exported PDF reverted to equal-width columns: ${JSON.stringify(pdf)}`
    )
    const editorHeaderHeightInPoints = editor.rowHeights[0] * 0.75
    assert.ok(
      pdf.headerToFirstRow <= editorHeaderHeightInPoints * 1.15,
      `Exported PDF table rows are looser than the editor: ${JSON.stringify({
        editorRowHeights: editor.rowHeights,
        editorHeaderHeightInPoints,
        pdfHeaderToFirstRow: pdf.headerToFirstRow
      })}`
    )

    await closePdfStudio(app)
    await dragFirstColumnWider(app)
    const manualEditor = await readEditorLayout(app)
    assert.equal(manualEditor.manual, true, `Manual table widths were not active: ${JSON.stringify(manualEditor)}`)
    await openPdfStudio(app)
    const manualSource = await readSourceLayout(app)
    const manualSourceRatios = manualSource.columns.map((width) => Number.parseFloat(width) / 100)
    const manualEditorRatios = ratios(manualEditor.widths)
    manualSourceRatios.forEach((ratio, index) => {
      assert.ok(
        relativeDifference(ratio, manualEditorRatios[index]) < 0.02,
        `Manual PDF source column ${index + 1} differs from the editor: ${JSON.stringify({ manualEditorRatios, manualSourceRatios })}`
      )
    })
    const manualPdfBytes = await app.evaluate(`Array.from(window.__horsemdLastPdfPreviewData || [])`)
    assert.ok(manualPdfBytes.length > 1000, 'Manual-width PDF preview bytes were not captured')
    await writeFile(pdfPath, Uint8Array.from(manualPdfBytes))
    const manualPdf = await inspectPdf(manualPdfBytes)
    const manualEditorStartDeltas = [
      manualEditor.lefts[1] - manualEditor.lefts[0],
      manualEditor.lefts[2] - manualEditor.lefts[1]
    ]
    const manualEditorDeltaRatio = manualEditorStartDeltas[0] / manualEditorStartDeltas[1]
    const manualPdfDeltaRatio = manualPdf.startDeltas[0] / manualPdf.startDeltas[1]
    assert.ok(
      relativeDifference(manualEditorDeltaRatio, manualPdfDeltaRatio) < 0.12,
      `Manually resized PDF columns differ from the editor: ${JSON.stringify({
        manualEditor,
        manualSource,
        manualPdf,
        manualEditorDeltaRatio,
        manualPdfDeltaRatio
      })}`
    )

    console.log(`PASS PDF table layout fidelity: ${JSON.stringify({
      editorWidths: editor.widths,
      sourceColumns: sourceLayout.columns,
      pdfStarts: pdf.starts,
      editorRowHeights: editor.rowHeights,
      pdfHeaderToFirstRow: pdf.headerToFirstRow,
      editorDeltaRatio,
      pdfDeltaRatio,
      manualEditorWidths: manualEditor.widths,
      manualSourceColumns: manualSource.columns,
      manualPdfStarts: manualPdf.starts,
      manualEditorDeltaRatio,
      manualPdfDeltaRatio,
      pdfPath,
      pngPath
    })}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    if (process.env.KEEP_PDF_ARTIFACTS !== '1') {
      await rm(root, { recursive: true, force: true })
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
