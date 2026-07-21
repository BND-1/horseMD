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
const FONT_WAIT_MS = 1500
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
    // MathML has no useful CSS wrapping primitive: long expressions are one
    // unbreakable inline layout run. Never shrink them to an unreadable size.
    // Instead, PDF-only output clones the presentation row and breaks at its
    // top-level operators. The live editor and exported source HTML stay intact.
    const presentationRow = (math) =>
      math.querySelector(':scope > semantics > mrow') || math.querySelector(':scope > mrow')
    const breakOperator = (node) =>
      node?.nodeType === Node.ELEMENT_NODE && node.localName === 'mo' &&
      /^[+=\\-\\u00b1,;]$/.test((node.textContent || '').trim())
    const lineMath = (math, row, children, start, end) => {
      const line = math.cloneNode(false)
      line.setAttribute('display', 'block')
      const lineRow = row.cloneNode(false)
      children.slice(start, end).forEach((child) => lineRow.appendChild(child.cloneNode(true)))
      const semantics = math.querySelector(':scope > semantics')
      if (semantics) {
        const lineSemantics = semantics.cloneNode(false)
        lineSemantics.appendChild(lineRow)
        line.appendChild(lineSemantics)
      } else {
        line.appendChild(lineRow)
      }
      return line
    }
    const wrapDisplayMath = () => [...document.querySelectorAll('.doc math[display="block"]')]
      .reduce((wrapped, math) => {
        const parent = math.parentElement
        const available = parent?.getBoundingClientRect().width || document.documentElement.clientWidth
        if (!available || math.getBoundingClientRect().width <= available + 0.5) return wrapped
        const row = presentationRow(math)
        const children = row ? [...row.children] : []
        if (children.length < 3 || !children.some(breakOperator)) return wrapped

        const measure = document.createElement('span')
        measure.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;white-space:nowrap;left:-10000px;top:0'
        parent.appendChild(measure)
        const lines = []
        let start = 0
        try {
          while (start < children.length) {
            let lastFit = start
            let lastBreak = -1
            let finished = false
            for (let end = start + 1; end <= children.length; end += 1) {
              measure.replaceChildren(lineMath(math, row, children, start, end))
              if (measure.getBoundingClientRect().width <= available + 0.5 || end === start + 1) {
                lastFit = end
                if (breakOperator(children[end - 1])) lastBreak = end
                if (end === children.length) {
                  lines.push([start, end])
                  finished = true
                  break
                }
                continue
              }
              const next = lastBreak > start ? lastBreak : lastFit
              if (next <= start) return wrapped
              lines.push([start, next])
              start = next
              finished = true
              break
            }
            if (!finished) return wrapped
            if (lines.at(-1)?.[1] === children.length) break
          }
        } finally {
          measure.remove()
        }
        if (lines.length < 2) return wrapped
        const wrapper = document.createElement('div')
        wrapper.className = 'hm-pdf-math-wrap'
        lines.forEach(([start, end]) => wrapper.appendChild(lineMath(math, row, children, start, end)))
        math.replaceWith(wrapper)
        return wrapped + 1
      }, 0)
    const fonts = document.fonts?.ready
      ? Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, ${FONT_WAIT_MS}))])
      : Promise.resolve()
    return Promise.race([
      Promise.all(images).then(() => 'ready'),
      timeout
    ]).then(async (imageStatus) => {
      await fonts
      return {
        imageStatus,
        failedImages: [...document.images].filter((image) => image.complete && !image.naturalWidth).length,
        wrappedMath: wrapDisplayMath()
      }
    })
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
          resourceTimeout: resources?.imageStatus === 'timeout',
          failedImages: Number(resources?.failedImages || 0),
          wrappedMath: Number(resources?.wrappedMath || 0)
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
