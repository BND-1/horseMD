// Phone PDF post-processing (pure; runs in the phone renderer and in node
// tests). The desktop gets page ranges and the page-number footer from
// Chromium's printToPDF; the phone print paths (WKWebView print formatter,
// Android PrintDocumentAdapter) have neither, so HorseMD applies them to the
// rendered bytes with pdf-lib:
//   - pageRanges: the normalized string normalizePdfOptions gives ("1-3, 5").
//     Pages past the end are ignored; nothing left → Error('invalid-page-range').
//   - pageNumbers: "n / total" (total after the ranges), Helvetica 8 pt,
//     #777777, right-aligned 12 mm from the right edge, vertically centred in
//     the bottom margin — the desktop look (Chromium footer template:
//     `padding: 0 12mm`, number on the right).
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const MM = 72 / 25.4
const NUMBER_SIZE = 8
const NUMBER_RIGHT = 12 * MM
const NUMBER_COLOR = rgb(0x77 / 255, 0x77 / 255, 0x77 / 255)

/** "1-3, 5" → sorted unique zero-based page indexes below `pageCount`. */
export function pageIndexesForRanges(pageRanges, pageCount) {
  const input = String(pageRanges || '').trim()
  if (!input) return Array.from({ length: pageCount }, (_, index) => index)
  const keep = new Set()
  for (const part of input.split(',').map((value) => value.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part)
    if (!match) throw new Error('invalid-page-range')
    const from = Number(match[1])
    const to = Number(match[2] || match[1])
    if (from < 1 || to < from) throw new Error('invalid-page-range')
    for (let page = from; page <= Math.min(to, pageCount); page += 1) keep.add(page - 1)
  }
  if (!keep.size) throw new Error('invalid-page-range')
  return [...keep].sort((a, b) => a - b)
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes  the rendered PDF
 * @param {{ pageRanges?: string, pageNumbers?: boolean,
 *           marginsPt?: { bottom?: number } }} options
 * @returns {Promise<Uint8Array>}
 */
export async function postprocessPdf(bytes, { pageRanges = '', pageNumbers = false, marginsPt = {} } = {}) {
  const ranges = String(pageRanges || '').trim()
  if (!ranges && !pageNumbers) return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const rendered = await PDFDocument.load(bytes, { updateMetadata: false })
  const keep = pageIndexesForRanges(ranges, rendered.getPageCount())
  // Copy the kept pages into a new document: removePage left getPages()
  // returning every page (numbers "n / 5" on a 3-page result) and kept the
  // removed pages' content in the file.
  let doc = rendered
  if (keep.length !== rendered.getPageCount()) {
    doc = await PDFDocument.create({ updateMetadata: false })
    for (const page of await doc.copyPages(rendered, keep)) doc.addPage(page)
  }
  if (pageNumbers) {
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const pages = doc.getPages()
    const total = pages.length
    const bottom = Math.max(0, Number(marginsPt?.bottom) || 0)
    const capHeight = font.heightAtSize(NUMBER_SIZE, { descender: false })
    pages.forEach((page, index) => {
      const text = `${index + 1} / ${total}`
      const box = page.getMediaBox()
      const width = font.widthOfTextAtSize(text, NUMBER_SIZE)
      page.drawText(text, {
        x: box.x + box.width - NUMBER_RIGHT - width,
        // A zero bottom margin would put the number below the page.
        y: box.y + Math.max(4, bottom / 2 - capHeight / 2),
        size: NUMBER_SIZE,
        font,
        color: NUMBER_COLOR
      })
    })
  }
  return doc.save()
}
