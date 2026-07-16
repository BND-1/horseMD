import { BrowserWindow, app, dialog, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildPdfDocument,
  buildPdfHeaderFooter,
  resolvePdfPage
} from './pdf-document.js'
import { createLatestTaskRunner } from './latest-task-runner.js'

const RESOURCE_WAIT_MS = 12000
const MAX_SOURCE_HTML = 50 * 1024 * 1024

const printableResourcesScript = `
  (() => {
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), ${RESOURCE_WAIT_MS}))
    const images = [...document.images].map((image) => {
      if (image.complete) return Promise.resolve()
      return new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true })
        image.addEventListener('error', resolve, { once: true })
      })
    })
    const fonts = document.fonts?.ready || Promise.resolve()
    return Promise.race([
      Promise.all([fonts, ...images]).then(() => 'ready'),
      timeout
    ]).then((status) => ({
      status,
      failedImages: [...document.images].filter((image) => image.complete && !image.naturalWidth).length
    }))
  })()
`

function validateSource(source) {
  const html = typeof source === 'string' ? source : source?.html
  if (typeof html !== 'string' || !html.trim()) throw new Error('PDF source is empty')
  if (html.length > MAX_SOURCE_HTML) throw new Error('PDF source is too large')
}

export function createPdfExportService({ getMainWindow }) {
  const previews = new Map()
  const trackedSenders = new WeakSet()

  const trackSender = (sender) => {
    if (trackedSenders.has(sender)) return
    trackedSenders.add(sender)
    const senderId = sender.id
    sender.once('destroyed', () => {
      previews.delete(senderId)
      previewTasks.cancel(senderId)
    })
  }

  const render = async ({ source, options }, signal) => {
    validateSource(source)
    const page = resolvePdfPage(options)
    const tempHtml = join(app.getPath('temp'), `horsemd-pdf-preview-${randomUUID()}.html`)
    await fs.writeFile(tempHtml, buildPdfDocument(source, page), 'utf8')
    if (signal.aborted) {
      fs.unlink(tempHtml).catch(() => {})
      throw new Error('PDF preview canceled')
    }
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    const abort = () => {
      if (!window.isDestroyed()) window.destroy()
    }
    signal.addEventListener('abort', abort, { once: true })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    try {
      await window.loadFile(tempHtml)
      const resources = await window.webContents.executeJavaScript(printableResourcesScript, true)
      const headerFooter = buildPdfHeaderFooter(page)
      const pdf = await window.webContents.printToPDF({
        printBackground: true,
        pageSize: page.printPageSize,
        scale: page.scale / 100,
        pageRanges: page.pageRanges,
        preferCSSPageSize: true,
        generateTaggedPDF: page.generateOutline,
        generateDocumentOutline: page.generateOutline,
        ...headerFooter
      })
      return {
        pdf,
        warnings: {
          resourceTimeout: resources?.status === 'timeout',
          failedImages: Number(resources?.failedImages || 0)
        }
      }
    } finally {
      signal.removeEventListener('abort', abort)
      if (!window.isDestroyed()) window.destroy()
      fs.unlink(tempHtml).catch(() => {})
    }
  }

  const previewTasks = createLatestTaskRunner(render)

  const createPreview = async (event, { source, options, defaultName } = {}) => {
    trackSender(event.sender)
    const senderId = event.sender.id
    const result = await previewTasks.run(senderId, { source, options })
    if (result.stale) return { ok: false, stale: true }
    const { pdf, warnings } = result.value
    const token = randomUUID()
    previews.set(senderId, {
      token,
      pdf,
      defaultName: String(defaultName || 'Untitled.pdf')
    })
    return { ok: true, token, data: pdf, warnings }
  }

  const savePreview = async (event, { token, defaultName } = {}) => {
    const preview = previews.get(event.sender.id)
    if (!preview || preview.token !== token) return { ok: false, error: 'PDF preview expired' }
    const result = await dialog.showSaveDialog(getMainWindow(), {
      defaultPath: defaultName || preview.defaultName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    await fs.writeFile(result.filePath, preview.pdf)
    shell.openPath(result.filePath)
    return { path: result.filePath }
  }

  const disposePreview = (event, token) => {
    const preview = previews.get(event.sender.id)
    if (!preview || (token && preview.token !== token)) return false
    previews.delete(event.sender.id)
    return true
  }

  return { createPreview, savePreview, disposePreview }
}
