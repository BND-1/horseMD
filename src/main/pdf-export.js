import { BrowserWindow, app, dialog, net, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  buildPdfDocument,
  buildPdfHeaderFooter,
  resolvePdfPage
} from './pdf-document.js'
import { stagePdfImages } from './pdf-images.js'
import { printableResourcesScript } from '../shared/export/pdf-resources-script.js'
import { createLatestTaskRunner } from './latest-task-runner.js'
import { getSaveDirFor, recordSaveDir } from './export-prefs.js'

const RESOURCE_WAIT_MS = 12000
const FONT_WAIT_MS = 1500
const MAX_SOURCE_HTML = 50 * 1024 * 1024

function validateSource(source) {
  const html = typeof source === 'string' ? source : source?.html
  if (typeof html !== 'string' || !html.trim()) throw new Error('PDF source is empty')
  if (html.length > MAX_SOURCE_HTML) throw new Error('PDF source is too large')
}

export function createPdfExportService({ getMainWindow, getParentWindow = () => getMainWindow() }) {
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
    const tempDir = join(app.getPath('temp'), `horsemd-pdf-preview-${randomUUID()}`)
    const tempHtml = join(tempDir, 'index.html')
    await fs.mkdir(tempDir, { recursive: true })
    let window = null
    let printing = false
    const abort = () => {
      // Destroying a BrowserWindow while Chromium is inside printToPDF rejects
      // the promise before the native print backend has actually recovered.
      // A replacement print started immediately afterwards can then fail with
      // "Printing failed". Once printing starts, let it finish and discard its
      // stale result; loading/resource stages remain safe to interrupt.
      if (!printing && window && !window.isDestroyed()) window.destroy()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const prepared = await stagePdfImages(source, {
        assetsDir: tempDir,
        fetchImpl: (url, init) => net.fetch(url, init),
        signal
      })
      await fs.writeFile(tempHtml, buildPdfDocument(prepared.source, page), 'utf8')
      if (signal.aborted) throw new Error('PDF preview canceled')
      window = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      await window.loadFile(tempHtml)
      const resources = await window.webContents.executeJavaScript(printableResourcesScript({ resourceWaitMs: RESOURCE_WAIT_MS, fontWaitMs: FONT_WAIT_MS }), true)
      const headerFooter = buildPdfHeaderFooter(page)
      printing = true
      let pdf
      try {
        pdf = await window.webContents.printToPDF({
          printBackground: true,
          pageSize: page.printPageSize,
          scale: page.scale / 100,
          pageRanges: page.pageRanges,
          preferCSSPageSize: true,
          generateTaggedPDF: page.generateOutline,
          generateDocumentOutline: page.generateOutline,
          ...headerFooter
        })
      } finally {
        printing = false
      }
      return {
        pdf,
        warnings: {
          resourceTimeout: resources?.imageStatus === 'timeout' && Number(resources?.pendingImages || 0) > 0,
          pendingImages: Number(resources?.pendingImages || 0),
          failedImages: Number(resources?.failedImages || 0),
          totalImages: Number(resources?.totalImages || 0),
          wrappedMath: Number(resources?.wrappedMath || 0),
          stagedImages: Number(prepared.stagedImages || 0),
          unresolvedImages: Number(prepared.unresolvedImages || 0)
        }
      }
    } finally {
      signal.removeEventListener('abort', abort)
      if (window && !window.isDestroyed()) window.destroy()
      fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const previewTasks = createLatestTaskRunner(render)

  const createPreview = async (event, { source, options, defaultName, sourcePath } = {}) => {
    trackSender(event.sender)
    const senderId = event.sender.id
    const result = await previewTasks.run(senderId, { source, options })
    if (result.stale) return { ok: false, stale: true }
    const { pdf, warnings } = result.value
    const token = randomUUID()
    previews.set(senderId, {
      token,
      pdf,
      defaultName: String(defaultName || 'Untitled.pdf'),
      sourcePath: typeof sourcePath === 'string' ? sourcePath : ''
    })
    return { ok: true, token, data: pdf, warnings }
  }

  const savePreview = async (event, { token } = {}) => {
    const preview = previews.get(event.sender.id)
    if (!preview || preview.token !== token) return { ok: false, error: 'PDF preview expired' }
    const fileName = preview.defaultName || 'Untitled.pdf'
    // Per-file: default to this document's own folder, or the folder it was
    // last saved to. Other files keep their own defaults.
    const startDir = await getSaveDirFor(preview.sourcePath)
    const result = await dialog.showSaveDialog(getParentWindow(event), {
      defaultPath: startDir ? join(startDir, fileName) : fileName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    await fs.writeFile(result.filePath, preview.pdf)
    await recordSaveDir(preview.sourcePath, dirname(result.filePath))
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
