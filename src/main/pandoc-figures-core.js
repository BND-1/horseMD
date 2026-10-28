// Pandoc figures (rendered diagrams / SVG as PNG), pure part — locked by
// scripts/test-pandoc-figures.mjs. See src/renderer/src/lib/pandoc-figures.js.

export const FIGURE_SCALE = 2
export const MAX_FIGURES = 200
export const MAX_FIGURE_SIDE = 4000
const MAX_SRC_BYTES = 8 * 1024 * 1024

export const figureName = (index) => `horsemd-figure-${String(index + 1).padStart(3, '0')}.png`

/**
 * Figures from the renderer → the ones that are safe to use: integer,
 * in-range, ascending, non-overlapping source ranges; an SVG data URL; a
 * positive size (scaled down to MAX_FIGURE_SIDE). Anything else is dropped,
 * so its source stays as written.
 */
export function validFigures(figures, markdownLength) {
  if (!Array.isArray(figures)) return []
  const out = []
  let floor = 0
  for (const figure of figures.slice(0, MAX_FIGURES)) {
    const { start, end, src } = figure || {}
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < floor || end <= start || end > markdownLength) continue
    if (typeof src !== 'string' || src.length > MAX_SRC_BYTES || !/^data:image\/svg\+xml[;,]/i.test(src)) continue
    let width = Number(figure.width)
    let height = Number(figure.height)
    if (!(width > 0) || !(height > 0)) continue
    const shrink = Math.min(1, MAX_FIGURE_SIDE / width, MAX_FIGURE_SIDE / height)
    width = Math.max(1, Math.round(width * shrink))
    height = Math.max(1, Math.round(height * shrink))
    out.push({ start, end, src, width, height, alt: String(figure.alt || ''), title: String(figure.title || '') })
    floor = end
  }
  return out
}

const escapeAlt = (text) => String(text).replace(/[\\[\]]/g, '\\$&').replace(/\s+/g, ' ')
const escapeTitle = (text) => String(text).replace(/["\\]/g, '\\$&').replace(/\s+/g, ' ')

const escapeAttr = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\s+/g, ' ')

/**
 * Replace each rendered figure's source range with an image of `path` (a
 * PNG name, optionally in a folder). `rendered` holds the figures that have
 * a PNG; the rest keep their source.
 * `html`: EPUB is a web page, it ignores a PNG's DPI (a 2× rendering showed
 * at twice the size), so the image is an <img> with its size — Pandoc embeds
 * raw-HTML images in EPUB too. Other formats size the PNG by its DPI.
 */
export function spliceFigures(markdown, rendered, { html = false } = {}) {
  let text = String(markdown)
  for (const figure of [...rendered].sort((a, b) => b.start - a.start)) {
    let image
    if (html) {
      const title = figure.title ? ` title="${escapeAttr(figure.title)}"` : ''
      image = `<img src="${escapeAttr(figure.path)}" width="${figure.width}" height="${figure.height}" alt="${escapeAttr(figure.alt)}"${title}>`
    } else {
      const title = figure.title ? ` "${escapeTitle(figure.title)}"` : ''
      image = `![${escapeAlt(figure.alt)}](<${figure.path}>${title})`
    }
    text = text.slice(0, figure.start) + image + text.slice(figure.end)
  }
  return text
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
const crc32 = (bytes) => {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * The PNG with a pHYs chunk of `dpi` (replacing any): Pandoc sizes images
 * by their DPI, so a 2× rendering at 192 dpi lands at the figure's own size.
 */
export function pngWithDpi(png, dpi) {
  const buffer = Buffer.from(png)
  const signature = 8
  if (buffer.length < signature + 25 || buffer.readUInt32BE(12) !== 0x49484452) return buffer
  const ihdrEnd = signature + 8 + buffer.readUInt32BE(8) + 4
  const parts = [buffer.subarray(0, ihdrEnd)]
  const ppm = Math.round(dpi / 0.0254)
  const data = Buffer.alloc(9)
  data.writeUInt32BE(ppm, 0)
  data.writeUInt32BE(ppm, 4)
  data[8] = 1
  const typeAndData = Buffer.concat([Buffer.from('pHYs'), data])
  const chunk = Buffer.alloc(4 + typeAndData.length + 4)
  chunk.writeUInt32BE(data.length, 0)
  typeAndData.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(typeAndData), 4 + typeAndData.length)
  parts.push(chunk)
  let offset = ihdrEnd
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const next = offset + 12 + length
    if (type !== 'pHYs') parts.push(buffer.subarray(offset, next))
    offset = next
  }
  return Buffer.concat(parts)
}
