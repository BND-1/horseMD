// Phone implementation of the desktop PDF / HTML export contract
// (src/main/pdf-export.js, src/main/html-export.js; window.api in
// src/preload/index.js), so PDF Studio and HTML Studio run unchanged:
//   previewPDF(source, defaultName, options, sourcePath)
//     → { ok: true, token, data: Uint8Array, warnings } | { ok: false, stale: true }
//   savePDFPreview(token, defaultName) → { path } | { canceled: true } | { ok: false, error }
//   disposePDFPreview(token) → boolean
//   previewHTML / saveHTMLPreview / disposeHTMLPreview: same shapes, `html`
//   instead of `data`.
// Loaded lazily by capacitor-api.js (pdf-lib stays out of the start-up chunk).
//
// - Latest request only, per kind (createLatestTaskRunner, as on desktop): a
//   newer preview supersedes an older one, which resolves { stale: true }; the
//   next render waits for the previous one to finish (HorsePdf renders one
//   document at a time).
// - Images are inlined as data: URLs (the phone renderer's web view has no
//   file access): remote ones through the native HTTP client (no CORS), app
//   URLs (capacitor://, https://localhost/_capacitor_file_/…, blob:) through
//   fetch, file:// ones through `readLocalImage` (capacitor-api.js).
// - PDF: the same document as desktop (buildPdfDocument), rendered natively
//   by HorsePdf (native-export.js), then page ranges + page numbers with
//   pdf-lib (src/shared/export/pdf-postprocess.js). Phones draw no header /
//   footer text and no bookmarks (capabilities.pdfOptions).
// - Save = write the bytes to Cache/export/<name> and open the system share
//   sheet (Save to Files, Drive, WeChat …). A dismissed sheet is a cancel.
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { Capacitor } from '@capacitor/core'
import { buildPdfDocument, resolvePdfPage } from '../../../shared/export/pdf-document.js'
import { buildHtmlDocument } from '../../../shared/export/html-document.js'
import { printableResourcesScript } from '../../../shared/export/pdf-resources-script.js'
import { postprocessPdf } from '../../../shared/export/pdf-postprocess.js'
import { createLatestTaskRunner } from '../../../main/latest-task-runner.js'
import { bytesToBase64, nativeRequest } from './native-sync.js'
import { renderPdf } from './native-export.js'

const MB = 1024 * 1024
export const MAX_IMAGE_BYTES = 32 * MB
export const MAX_PDF_IMAGE_TOTAL_BYTES = 160 * MB
export const MAX_HTML_IMAGE_TOTAL_BYTES = 48 * MB // desktop value (html-export.js)
const MAX_SOURCE_HTML = 50 * MB
const REMOTE_TIMEOUT_MS = 30000
const RESOURCE_WAIT_MS = 12000
const FONT_WAIT_MS = 1500
const RENDER_TIMEOUT_MS = 90000
const EXPORT_DIR = 'export'
const PT_PER_MM = 72 / 25.4
const IOS = Capacitor.getPlatform() === 'ios'
const IOS_PRINT_ZOOM = 0.92

const EXT_MIME = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp'
})

const escapeAttribute = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

const extensionMime = (src) => {
  let path = String(src || '')
  try { path = new URL(path).pathname } catch { /* not a URL: use as is */ }
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return (ext && EXT_MIME[ext]) || ''
}

// Magic bytes, for a server that sends no (or a generic) content type.
const sniffMime = (bytes) => {
  const b = bytes
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'image/avif'
  const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart().toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml'
  return ''
}

const imageMime = (src, contentType, bytes) => {
  const declared = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (declared.startsWith('image/')) return declared
  return extensionMime(src) || sniffMime(bytes) || 'application/octet-stream'
}

// URLs the app itself serves (Capacitor's local server / converted file URLs):
// fetch works for them; the native HTTP client would go out to the network.
const isAppUrl = (src) => {
  if (/^(capacitor|blob):/i.test(src)) return true
  if (/\/_capacitor_file_\//.test(src)) return true
  try {
    return typeof location !== 'undefined' && new URL(src).origin === location.origin
  } catch {
    return false
  }
}

const fetchBytes = async (src, limit) => {
  const response = await fetch(src)
  if (!response.ok) return null
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > limit) return null
  const bytes = new Uint8Array(await response.arrayBuffer())
  return { bytes, contentType: response.headers.get('content-type') || '' }
}

const remoteBytes = async (src) => {
  try {
    const response = await nativeRequest({
      method: 'GET',
      url: src,
      headers: { Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
      timeoutMs: REMOTE_TIMEOUT_MS
    })
    if (response.status < 200 || response.status >= 300) return null
    return { bytes: response.body, contentType: response.headers['content-type'] || '' }
  } catch (error) {
    // A build without the native HTTP plugin: a CORS-enabled server still works.
    if (error?.code === 'UNIMPLEMENTED' || /not implemented|not available/i.test(error?.message || '')) {
      return fetchBytes(src, MAX_IMAGE_BYTES)
    }
    return null
  }
}

/**
 * Replace every image placeholder of an export snapshot with a data: URL.
 * @param {{ html: string, images?: { placeholder: string, src: string }[] }} source
 * @returns {Promise<{ source, stagedImages: number, unresolvedImages: number, stagedBytes: number }>}
 */
export async function inlineImages(source, {
  maxBytes = MAX_IMAGE_BYTES,
  maxTotalBytes = MAX_PDF_IMAGE_TOTAL_BYTES,
  signal,
  readLocalImage
} = {}) {
  if (!source || typeof source === 'string' || !Array.isArray(source.images) || !source.images.length) {
    return { source, stagedImages: 0, unresolvedImages: 0, stagedBytes: 0 }
  }
  let html = String(source.html || '')
  let stagedImages = 0
  let unresolvedImages = 0
  let stagedBytes = 0
  for (const image of source.images) {
    if (signal?.aborted) throw new Error('Export preview canceled')
    const placeholder = String(image?.placeholder || '')
    const src = String(image?.src || '')
    if (!placeholder || !src || !html.includes(placeholder)) continue
    let replacement = src
    if (/^data:/i.test(src)) {
      stagedImages += 1
    } else {
      const available = Math.max(0, Math.min(maxBytes, maxTotalBytes - stagedBytes))
      let loaded = null
      if (available > 0) {
        try {
          if (/^file:/i.test(src)) loaded = readLocalImage ? await readLocalImage(src) : null
          else if (isAppUrl(src)) loaded = await fetchBytes(src, available)
          else if (/^https?:/i.test(src)) loaded = await remoteBytes(src)
        } catch {
          loaded = null
        }
      }
      if (loaded?.bytes?.length && loaded.bytes.length <= available) {
        replacement = `data:${imageMime(src, loaded.contentType, loaded.bytes)};base64,${bytesToBase64(loaded.bytes)}`
        stagedImages += 1
        stagedBytes += loaded.bytes.length
      } else {
        unresolvedImages += 1
      }
    }
    html = html.split(placeholder).join(escapeAttribute(replacement))
  }
  return {
    source: { ...source, html, images: undefined },
    stagedImages,
    unresolvedImages,
    stagedBytes
  }
}

const validateSource = (source, kind) => {
  const html = typeof source === 'string' ? source : source?.html
  if (typeof html !== 'string' || !html.trim()) throw new Error(`${kind} source is empty`)
  if (html.length > MAX_SOURCE_HTML) throw new Error(`${kind} source is too large`)
}

const newToken = () => (globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)

// "a/b:c.pdf" → "a-b-c.pdf"; always ends with the export's extension.
export function exportFileName(name, extension) {
  let base = String(name || '').replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').trim()
  if (!base || base === '.' || base === '..') base = 'Untitled'
  if (!base.toLowerCase().endsWith(extension)) base += extension
  return base
}

const isShareCancel = (error) => /cancel/i.test(String(error?.message || error || ''))

export function createMobileExport({ readLocalImage, zh = () => false } = {}) {
  const previews = { pdf: null, html: null }

  const renderPdfPreview = async ({ source, options }, signal) => {
    validateSource(source, 'PDF')
    const page = resolvePdfPage(options)
    const prepared = await inlineImages(source, { maxTotalBytes: MAX_PDF_IMAGE_TOTAL_BYTES, signal, readLocalImage })
    if (signal.aborted) throw new Error('PDF preview canceled')
    let html = buildPdfDocument(prepared.source, page)
    // Desktop passes `scale` to printToPDF; here the page itself is zoomed.
    // WKWebView's print formatter draws a CSS px larger than Chromium's
    // 0.75 pt. Measured on an iPhone 13 mini (iOS 27, 2026-11-16) against the
    // desktop PDF of the same document: unzoomed text was 1.28x, zoom 0.75
    // gave 0.81x (with the @page margin removed below) — 0.92 matches.
    const zoom = (page.scale / 100) * (IOS ? IOS_PRINT_ZOOM : 1)
    if (zoom !== 1) html = html.replace('</style>', `html{zoom:${zoom}}</style>`)
    // iOS takes the margins from the renderer's printableRect (HorsePdf) and
    // ALSO insets the content by the CSS @page margin (text started 15 pt
    // right of / 17 pt below the margin). Android applies only the CSS one.
    if (IOS) html = html.replace(/(@page \{[^}]*?)margin:[^;}]*/, '$1margin: 0')
    const margins = {
      top: page.margins.top * PT_PER_MM,
      right: page.margins.right * PT_PER_MM,
      bottom: page.margins.bottom * PT_PER_MM,
      left: page.margins.left * PT_PER_MM
    }
    const rendered = await renderPdf({
      html,
      pageWidthPt: page.width * PT_PER_MM,
      pageHeightPt: page.height * PT_PER_MM,
      margins,
      resourceScript: printableResourcesScript({ resourceWaitMs: RESOURCE_WAIT_MS, fontWaitMs: FONT_WAIT_MS }),
      timeoutMs: RENDER_TIMEOUT_MS,
      // iOS: the view the resource script measures in, zoomed like the page.
      viewportWidth: IOS ? (page.width * PT_PER_MM - margins.left - margins.right) * 96 / 72 * zoom : undefined
    })
    if (signal.aborted) throw new Error('PDF preview canceled')
    if (!rendered.bytes.length) throw new Error('PDF rendering returned no data')
    let pdf
    try {
      pdf = await postprocessPdf(rendered.bytes, {
        pageRanges: page.pageRanges,
        pageNumbers: page.footerEnabled && page.includePageNumbers,
        marginsPt: margins
      })
    } catch (error) {
      if (error?.message === 'invalid-page-range') {
        throw new Error(zh()
          ? `页码范围里没有存在的页（这份文档共 ${rendered.pageCount || '?'} 页）。`
          : `The page range has no existing pages (this document has ${rendered.pageCount || '?'}).`)
      }
      throw error
    }
    const resources = rendered.resources || {}
    return {
      pdf,
      warnings: {
        resourceTimeout: resources.imageStatus === 'timeout' && Number(resources.pendingImages || 0) > 0,
        pendingImages: Number(resources.pendingImages || 0),
        failedImages: Number(resources.failedImages || 0),
        totalImages: Number(resources.totalImages || 0),
        wrappedMath: Number(resources.wrappedMath || 0),
        stagedImages: Number(prepared.stagedImages || 0),
        unresolvedImages: Number(prepared.unresolvedImages || 0)
      }
    }
  }

  const renderHtmlPreview = async ({ source, options }, signal) => {
    validateSource(source, 'HTML')
    const prepared = await inlineImages(source, { maxTotalBytes: MAX_HTML_IMAGE_TOTAL_BYTES, signal, readLocalImage })
    if (signal.aborted) throw new Error('HTML preview canceled')
    return {
      html: buildHtmlDocument(prepared.source, options),
      warnings: {
        stagedImages: prepared.stagedImages,
        unresolvedImages: prepared.unresolvedImages
      }
    }
  }

  const pdfTasks = createLatestTaskRunner(renderPdfPreview)
  const htmlTasks = createLatestTaskRunner(renderHtmlPreview)

  // Write to Cache/export/<name> (older exports removed first) and share.
  const shareExport = async (name, write) => {
    await Filesystem.rmdir({ path: EXPORT_DIR, directory: Directory.Cache, recursive: true }).catch(() => {})
    const path = `${EXPORT_DIR}/${name}`
    await write(path)
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
    try {
      await Share.share({ files: [uri], dialogTitle: 'HorseMD' })
    } catch (error) {
      if (isShareCancel(error)) return { canceled: true }
      return { ok: false, error: error?.message || String(error) }
    }
    return { path: uri }
  }

  const previewPDF = async (source, defaultName, options) => {
    const result = await pdfTasks.run('pdf', { source, options })
    if (result.stale) return { ok: false, stale: true }
    const token = newToken()
    previews.pdf = { token, pdf: result.value.pdf, defaultName: String(defaultName || 'Untitled.pdf') }
    return { ok: true, token, data: result.value.pdf, warnings: result.value.warnings }
  }

  const savePDFPreview = async (token, defaultName) => {
    const preview = previews.pdf
    if (!preview || preview.token !== token) return { ok: false, error: 'PDF preview expired' }
    try {
      const name = exportFileName(defaultName || preview.defaultName, '.pdf')
      return await shareExport(name, (path) => Filesystem.writeFile({
        path,
        directory: Directory.Cache,
        data: bytesToBase64(preview.pdf),
        recursive: true
      }))
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  const disposePDFPreview = async (token) => {
    if (!previews.pdf || (token && previews.pdf.token !== token)) return false
    previews.pdf = null
    return true
  }

  const previewHTML = async (source, defaultName, options) => {
    const result = await htmlTasks.run('html', { source, options })
    if (result.stale) return { ok: false, stale: true }
    const token = newToken()
    previews.html = { token, html: result.value.html, defaultName: String(defaultName || 'Untitled.html') }
    return { ok: true, token, html: result.value.html, warnings: result.value.warnings }
  }

  const saveHTMLPreview = async (token, defaultName) => {
    const preview = previews.html
    if (!preview || preview.token !== token) return { ok: false, error: 'HTML preview expired' }
    try {
      const name = exportFileName(defaultName || preview.defaultName, '.html')
      return await shareExport(name, (path) => Filesystem.writeFile({
        path,
        directory: Directory.Cache,
        data: preview.html,
        encoding: Encoding.UTF8,
        recursive: true
      }))
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  const disposeHTMLPreview = async (token) => {
    if (!previews.html || (token && previews.html.token !== token)) return false
    previews.html = null
    return true
  }

  return { previewPDF, savePDFPreview, disposePDFPreview, previewHTML, saveHTMLPreview, disposeHTMLPreview }
}
