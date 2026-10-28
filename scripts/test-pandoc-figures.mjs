// Pandoc figures, pure part (src/main/pandoc-figures-core.js): which renderer
// figures are used, how their source is replaced, the PNG DPI chunk.
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { figureName, MAX_FIGURE_SIDE, pngWithDpi, spliceFigures, validFigures } from '../src/main/pandoc-figures-core.js'

const svg = 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E'
const md = '# T\n\n```mermaid\ngraph TD; A-->B\n```\n\n- item\n\n  ```svg\n  <svg/>\n  ```\n\n![图 [1]](a.svg "说 \\"明\\"")\n'
const mermaidStart = md.indexOf('```mermaid')
const mermaidEnd = md.indexOf('```\n\n- item') + 3
const svgStart = md.indexOf('```svg')
const svgEnd = md.indexOf('```\n\n![') + 3
const imageStart = md.indexOf('![')
const imageEnd = md.length - 1

// 1. Validation: good figures pass (scaled to the side limit), bad ones drop.
const good = [
  { start: mermaidStart, end: mermaidEnd, src: svg, width: 434.6, height: 120 },
  { start: svgStart, end: svgEnd, src: svg, width: 9000, height: 100 },
  { start: imageStart, end: imageEnd, src: svg, width: 260, height: 120, alt: '图 [1]', title: '说 "明"' }
]
const valid = validFigures(good, md.length)
assert.equal(valid.length, 3)
assert.deepEqual([valid[0].width, valid[0].height], [435, 120])
assert.deepEqual([valid[1].width, valid[1].height], [MAX_FIGURE_SIDE, 44], 'scaled down to the side limit, ratio kept')
assert.equal(validFigures([
  { start: 5, end: 3, src: svg, width: 1, height: 1 }, // reversed
  { start: 0, end: md.length + 1, src: svg, width: 1, height: 1 }, // out of range
  { start: 1.5, end: 3, src: svg, width: 1, height: 1 }, // not integer
  { start: 0, end: 3, src: 'data:text/html,<script>', width: 1, height: 1 }, // not an SVG image
  { start: 0, end: 3, src: 'https://x/y.svg', width: 1, height: 1 }, // not a data URL
  { start: 0, end: 3, src: svg, width: 0, height: 1 } // no size
], md.length).length, 0)
// Overlapping or out-of-order figures: the later one is dropped.
assert.equal(validFigures([good[1], good[0]], md.length).length, 1)
assert.equal(validFigures('x', 10).length, 0)

// 2. Splice: only rendered figures are replaced; alt/title escaped; others keep source.
const rendered = valid.filter((_, index) => index !== 1).map((figure, index) => ({ ...figure, path: `f/${figureName(index)}` }))
const out = spliceFigures(md, rendered)
assert.equal(out, '# T\n\n![](<f/horsemd-figure-001.png>)\n\n- item\n\n  ```svg\n  <svg/>\n  ```\n\n![图 \\[1\\]](<f/horsemd-figure-002.png> "说 \\"明\\"")\n')
// EPUB: a sized <img>, attribute values escaped.
const html = spliceFigures(md, rendered, { html: true })
assert.ok(html.includes('<img src="f/horsemd-figure-001.png" width="435" height="120" alt="">'))
assert.ok(html.includes('<img src="f/horsemd-figure-002.png" width="260" height="120" alt="图 [1]" title="说 &quot;明&quot;">'))
assert.equal(figureName(0), 'horsemd-figure-001.png')
assert.equal(figureName(11), 'horsemd-figure-012.png')

// 3. DPI: a pHYs chunk at the given DPI right after IHDR, an old one replaced,
// the image data untouched, every chunk CRC valid.
const chunk = (type, data) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body))
  return Buffer.concat([length, body, crc])
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2
const oldPhys = Buffer.alloc(9); oldPhys.writeUInt32BE(2835, 0); oldPhys.writeUInt32BE(2835, 4); oldPhys[8] = 1
const idat = chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0])))
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('pHYs', oldPhys), idat, chunk('IEND', Buffer.alloc(0))])
const chunks = (buffer) => {
  const list = []
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    assert.equal(buffer.readUInt32BE(offset + 8 + length), zlib.crc32(buffer.subarray(offset + 4, offset + 8 + length)), `${type} CRC`)
    list.push({ type, data })
    offset += 12 + length
  }
  return list
}
const withDpi = chunks(pngWithDpi(png, 192))
assert.deepEqual(withDpi.map((c) => c.type), ['IHDR', 'pHYs', 'IDAT', 'IEND'])
assert.equal(withDpi[1].data.readUInt32BE(0), Math.round(192 / 0.0254))
assert.equal(withDpi[1].data[8], 1, 'unit: metre')
assert.ok(withDpi[2].data.equals(chunks(png)[2].data), 'image data untouched')
assert.ok(pngWithDpi(Buffer.from('not a png'), 192).equals(Buffer.from('not a png')), 'non-PNG returned as is')

console.log('PASS pandoc figures: validation (ranges, SVG data URL, size limit), splice (Markdown image / EPUB <img>, escaping, unrendered kept), PNG DPI chunk')
