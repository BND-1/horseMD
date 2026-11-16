// Phone PDF post-processing (src/shared/export/pdf-postprocess.js): page
// ranges and the "n / total" page numbers the phone print paths cannot draw.
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { PDFDocument } from 'pdf-lib'
import { pageIndexesForRanges, postprocessPdf } from '../src/shared/export/pdf-postprocess.js'

const MM = 72 / 25.4

// Five pages, each a different width so the kept pages can be identified.
const makePdf = async (count = 5) => {
  const doc = await PDFDocument.create()
  for (let index = 0; index < count; index += 1) doc.addPage([500 + index, 800])
  return doc.save()
}

// Text of every content stream (deflated or not), to find drawn strings.
const contentText = (bytes) => {
  const raw = Buffer.from(bytes)
  const latin = raw.toString('latin1')
  const out = []
  let at = 0
  while (true) {
    const start = latin.indexOf('stream', at)
    if (start < 0) break
    let begin = start + 'stream'.length
    if (latin[begin] === '\r') begin += 1
    if (latin[begin] === '\n') begin += 1
    const end = latin.indexOf('endstream', begin)
    if (end < 0) break
    const chunk = raw.subarray(begin, end)
    try {
      out.push(inflateSync(chunk).toString('latin1'))
    } catch {
      out.push(chunk.toString('latin1'))
    }
    at = end + 'endstream'.length
  }
  return out.join('\n')
}

const hex = (text) => Buffer.from(text, 'latin1').toString('hex')
const hasText = (streams, text) => streams.includes(`(${text})`) || streams.toLowerCase().includes(`<${hex(text)}>`)

// pageIndexesForRanges
assert.deepEqual(pageIndexesForRanges('', 3), [0, 1, 2])
assert.deepEqual(pageIndexesForRanges('2-3, 5', 5), [1, 2, 4])
assert.deepEqual(pageIndexesForRanges('4-9', 5), [3, 4], 'pages past the end are ignored')
assert.deepEqual(pageIndexesForRanges('3, 1-2, 2', 5), [0, 1, 2], 'sorted, unique')
assert.throws(() => pageIndexesForRanges('7-9', 5), /invalid-page-range/)
assert.throws(() => pageIndexesForRanges('x', 5), /invalid-page-range/)
assert.throws(() => pageIndexesForRanges('3-1', 5), /invalid-page-range/)

const source = await makePdf(5)

// Nothing to do → the same bytes.
assert.equal(await postprocessPdf(source, {}), source)

// Ranges "2-3, 5" + page numbers → 3 pages: the original 2, 3, 5, numbered n / 3.
{
  const out = await postprocessPdf(source, { pageRanges: '2-3, 5', pageNumbers: true, marginsPt: { bottom: 20 * MM } })
  assert.ok(out instanceof Uint8Array)
  const doc = await PDFDocument.load(out)
  assert.equal(doc.getPageCount(), 3)
  assert.deepEqual(doc.getPages().map((page) => page.getWidth()), [501, 502, 504])
  const streams = contentText(out)
  for (const label of ['1 / 3', '2 / 3', '3 / 3']) assert.ok(hasText(streams, label), `page number "${label}" drawn`)
  assert.ok(!hasText(streams, '1 / 5'), 'total counts the kept pages only')
  // Helvetica 8 pt, #777777 (0.4667 rg).
  assert.match(streams, /\s8 Tf/)
  assert.match(streams, /0\.46\d* 0\.46\d* 0\.46\d* rg/)
}

// Page numbers only: all five pages, "n / 5".
{
  const out = await postprocessPdf(source, { pageNumbers: true, marginsPt: { bottom: 20 * MM } })
  const doc = await PDFDocument.load(out)
  assert.equal(doc.getPageCount(), 5)
  const streams = contentText(out)
  assert.ok(hasText(streams, '5 / 5'))
}

// Ranges only: no page numbers drawn.
{
  const out = await postprocessPdf(source, { pageRanges: '4-9' })
  const doc = await PDFDocument.load(out)
  assert.equal(doc.getPageCount(), 2)
  assert.deepEqual(doc.getPages().map((page) => page.getWidth()), [503, 504])
  assert.ok(!hasText(contentText(out), '1 / 2'))
}

// A range with no existing page.
await assert.rejects(() => postprocessPdf(source, { pageRanges: '6-8' }), /invalid-page-range/)

console.log('pdf-postprocess: ok')
