import { createServer } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = '/tmp/horsemd-pdf-images-ui'
const profileDir = join(root, 'profile')
const fixture = join(root, 'pdf-images.md')
const localImage = join(root, 'local image.svg')
const port = 9353
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="60"><rect width="180" height="60" fill="#c86b35"/><circle cx="145" cy="30" r="18" fill="#fff"/></svg>'

const waitFor = async (evaluate, expression, message, attempts = 120) => {
  for (let index = 0; index < attempts; index += 1) {
    if (await evaluate(expression)) return
    await sleep(200)
  }
  throw new Error(message)
}

const click = async (send, point, button = 'left') => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount: 1 })
}

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
await writeFile(localImage, svg, 'utf8')

let remoteRequests = 0
const server = createServer((request, response) => {
  remoteRequests += 1
  if (!request.url?.startsWith('/remote.svg')) {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, {
    'Content-Type': 'image/svg+xml',
    'Content-Length': Buffer.byteLength(svg)
  })
  response.end(svg)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const remotePort = server.address().port
await writeFile(fixture, `# PDF image resources

Local image:

![Local](./local%20image.svg)

Remote image:

![Remote](http://127.0.0.1:${remotePort}/remote.svg?token=a&size=large)
`, 'utf8')

const app = await launchBuiltElectron({ profileDir, port, appArgs: [fixture] })

try {
  const { send, evaluate } = app
  await waitFor(
    evaluate,
    `(() => {
      const root = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const images = [...(root?.querySelectorAll('img') || [])]
      return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0)
    })()`,
    'Editor images did not load'
  )
  await evaluate(`window.__HORSEMD_TEST_CAPTURE_PDF__ = true`)
  const tabPoint = await evaluate(`(() => {
    const rect = (document.querySelector('.tab.active') || document.querySelector('.tab'))?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  if (!tabPoint) throw new Error('Active tab not found')
  await click(send, tabPoint, 'right')
  await waitFor(
    evaluate,
    `[...document.querySelectorAll('button')].some((node) => /PDF/i.test(node.textContent || ''))`,
    'PDF export command not found'
  )
  await evaluate(`([...document.querySelectorAll('button')].find((node) => /PDF/i.test(node.textContent || ''))?.click(), true)`)
  await waitFor(evaluate, `window.__horsemdLastPdfPreview?.result?.ok === true`, 'PDF preview did not complete')

  const snapshot = await evaluate(`(() => {
    const capture = window.__horsemdLastPdfPreview
    return {
      sourceImages: capture?.source?.images?.length || 0,
      placeholders: (capture?.source?.html?.match(/horsemd-pdf-resource-/g) || []).length,
      warnings: capture?.result?.warnings || null,
      warningVisible: !!document.querySelector('.hm-pdf-preview-warning'),
      bytes: capture?.result?.bytes || 0
    }
  })()`)
  if (
    snapshot.sourceImages !== 2 ||
    snapshot.placeholders !== 2 ||
    snapshot.warnings?.stagedImages !== 2 ||
    snapshot.warnings?.unresolvedImages !== 0 ||
    snapshot.warnings?.failedImages !== 0 ||
    snapshot.warnings?.pendingImages !== 0 ||
    snapshot.warningVisible ||
    snapshot.bytes <= 0 ||
    remoteRequests < 2
  ) {
    throw new Error(`PDF image resources were not staged correctly: ${JSON.stringify({ snapshot, remoteRequests })}`)
  }
  console.log(`PASS PDF image UI: ${JSON.stringify({ snapshot, remoteRequests })}`)
} finally {
  await stopBuiltElectron(app)
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
