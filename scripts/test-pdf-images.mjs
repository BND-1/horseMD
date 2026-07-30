import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { stagePdfImages } from '../src/main/pdf-images.js'

const root = '/tmp/horsemd-test-pdf-images'
const localImage = join(root, 'local image.svg')
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="30"><rect width="80" height="30" fill="#c86b35"/></svg>')

await fs.rm(root, { recursive: true, force: true })
await fs.mkdir(root, { recursive: true })
await fs.writeFile(localImage, svg)

const source = {
  html: '<p>before</p><img src="horsemd-pdf-resource-1"><img src="horsemd-pdf-resource-2"><img src="horsemd-pdf-resource-3">',
  headings: [],
  images: [
    { placeholder: 'horsemd-pdf-resource-1', src: new URL(`file://${localImage.replace(/ /g, '%20')}`).href },
    { placeholder: 'horsemd-pdf-resource-2', src: 'https://example.test/remote.svg?x=1&y=2' },
    { placeholder: 'horsemd-pdf-resource-3', src: 'blob:https://example.test/unavailable' }
  ]
}

const fetchImpl = async (url) => {
  assert.equal(url, 'https://example.test/remote.svg?x=1&y=2')
  return {
    ok: true,
    headers: { get: (name) => name === 'content-length' ? String(svg.length) : 'image/svg+xml' },
    arrayBuffer: async () => svg
  }
}

const result = await stagePdfImages(source, {
  assetsDir: join(root, 'assets'),
  fetchImpl
})

assert.equal(result.stagedImages, 2)
assert.equal(result.unresolvedImages, 1)
assert.equal(result.stagedBytes, svg.length * 2)
assert.ok(result.source.html.includes('src="./image-0001.svg"'))
assert.ok(result.source.html.includes('src="./image-0002.svg"'))
assert.ok(result.source.html.includes('src="blob:https://example.test/unavailable"'))
assert.equal(result.source.images, undefined)
assert.deepEqual(await fs.readFile(join(root, 'assets', 'image-0001.svg')), svg)
assert.deepEqual(await fs.readFile(join(root, 'assets', 'image-0002.svg')), svg)

const limited = await stagePdfImages(source, {
  assetsDir: join(root, 'limited'),
  fetchImpl,
  maximumBytes: 1
})
assert.equal(limited.stagedImages, 0)
assert.equal(limited.unresolvedImages, 3)
assert.ok(limited.source.html.includes('file:'))
assert.ok(limited.source.html.includes('https://example.test/remote.svg?x=1&amp;y=2'))

const totalLimited = await stagePdfImages(source, {
  assetsDir: join(root, 'total-limited'),
  fetchImpl,
  maximumTotalBytes: svg.length
})
assert.equal(totalLimited.stagedImages, 1)
assert.equal(totalLimited.unresolvedImages, 2)
assert.equal(totalLimited.stagedBytes, svg.length)

await fs.rm(root, { recursive: true, force: true })
console.log('PASS PDF images: local and remote resources stage beside the temporary print document')
