import { app, dialog, net, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { buildHtmlDocument } from './html-document.js'
import { stagePdfImages } from './pdf-images.js'
import { createLatestTaskRunner } from './latest-task-runner.js'
import { getSaveDirFor, recordSaveDir } from './export-prefs.js'

const MAX_SOURCE_HTML = 50 * 1024 * 1024
const MAX_EMBEDDED_IMAGE_BYTES = 48 * 1024 * 1024
const MIME = { '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' }

const validateSource = (source) => {
  if (!source || typeof source.html !== 'string' || !source.html.trim()) throw new Error('HTML source is empty')
  if (source.html.length > MAX_SOURCE_HTML) throw new Error('HTML source is too large')
}

const embedStagedImages = async (source, directory) => {
  let html = source.html
  const files = await fs.readdir(directory).catch(() => [])
  for (const file of files) {
    if (!/^image-\d{4}\./.test(file)) continue
    const bytes = await fs.readFile(join(directory, file))
    const mime = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
    html = html.split(`./${file}`).join(`data:${mime};base64,${bytes.toString('base64')}`)
  }
  return { ...source, html }
}

export function createHtmlExportService({ getMainWindow }) {
  const previews = new Map()
  const trackedSenders = new WeakSet()

  const trackSender = (sender) => {
    if (trackedSenders.has(sender)) return
    trackedSenders.add(sender)
    const senderId = sender.id
    sender.once('destroyed', () => {
      previews.delete(senderId)
      tasks.cancel(senderId)
    })
  }

  const render = async ({ source, options }, signal) => {
    validateSource(source)
    const tempDir = join(app.getPath('temp'), `horsemd-html-preview-${randomUUID()}`)
    await fs.mkdir(tempDir, { recursive: true })
    try {
      const prepared = await stagePdfImages(source, {
        assetsDir: tempDir,
        fetchImpl: (url, init) => net.fetch(url, init),
        signal,
        maximumTotalBytes: MAX_EMBEDDED_IMAGE_BYTES
      })
      if (signal.aborted) throw new Error('HTML preview canceled')
      const embedded = await embedStagedImages(prepared.source, tempDir)
      return {
        html: buildHtmlDocument(embedded, options),
        warnings: {
          stagedImages: prepared.stagedImages,
          unresolvedImages: prepared.unresolvedImages
        }
      }
    } finally {
      fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const tasks = createLatestTaskRunner(render)

  const createPreview = async (event, { source, options, defaultName, sourcePath } = {}) => {
    trackSender(event.sender)
    const result = await tasks.run(event.sender.id, { source, options })
    if (result.stale) return { ok: false, stale: true }
    const token = randomUUID()
    previews.set(event.sender.id, {
      token,
      html: result.value.html,
      defaultName: String(defaultName || 'Untitled.html'),
      sourcePath: typeof sourcePath === 'string' ? sourcePath : ''
    })
    return { ok: true, token, html: result.value.html, warnings: result.value.warnings }
  }

  const savePreview = async (event, { token } = {}) => {
    const preview = previews.get(event.sender.id)
    if (!preview || preview.token !== token) return { ok: false, error: 'HTML preview expired' }
    const fileName = preview.defaultName || 'Untitled.html'
    // Per-file: default to this document's own folder, or the folder it was
    // last saved to. Other files keep their own defaults.
    const startDir = await getSaveDirFor(preview.sourcePath)
    const result = await dialog.showSaveDialog(getMainWindow(), {
      defaultPath: startDir ? join(startDir, fileName) : fileName,
      filters: [{ name: 'HTML', extensions: ['html'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    await fs.writeFile(result.filePath, preview.html, 'utf8')
    await recordSaveDir(preview.sourcePath, dirname(result.filePath))
    await shell.openPath(result.filePath)
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

