import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = '/tmp/horsemd-pdf-rendered-formats-ui'
const profileDir = join(root, 'profile')
const fixture = join(root, 'rendered-formats.md')
const port = Number(process.env.CDP_PORT || 9663)

const waitFor = async (evaluate, expression, message, attempts = 140) => {
  for (let index = 0; index < attempts; index += 1) {
    if (await evaluate(expression)) return
    await sleep(200)
  }
  throw new Error(message)
}

const click = async (send, point, button = 'left') => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 })
}

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
await writeFile(fixture, `# PDF rendered format matrix

Paragraph with **bold**, *italic*, \`inline code\`, and inline math $a^2+b^2=c^2$.

> A blockquote must remain a blockquote.

- [x] Completed task
- [ ] Open task

| Name | Value |
| --- | --- |
| Alpha | One |
| Beta | Two |

<div><strong>Raw HTML stays structured</strong></div>

$$
E = mc^2
$$

\`\`\`mermaid
flowchart LR
  FLOW_START[Flow start] --> FLOW_END[Flow end]
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant Alice
  participant Bob
  Alice->>Bob: Sequence hello
\`\`\`

\`\`\`mermaid
pie title Export share
  "Rendered" : 75
  "Source" : 25
\`\`\`

\`\`\`mermaid
classDiagram
  Vehicle <|-- ExportCar
\`\`\`

\`\`\`mermaid
stateDiagram-v2
  [*] --> ExportIdle
  ExportIdle --> ExportRunning
\`\`\`

\`\`\`mermaid
erDiagram
  EXPORT_CUSTOMER ||--o{ EXPORT_ORDER : places
\`\`\`

\`\`\`mermaid
not-a-valid-diagram
\`\`\`

\`\`\`javascript
const ordinaryCode = 'must stay source'
\`\`\`
`, 'utf8')

const app = await launchBuiltElectron({ profileDir, port, appArgs: [fixture] })

try {
  const { send, evaluate } = app
  await waitFor(
    evaluate,
    `[...document.querySelectorAll('.tab')].some((tab) => /rendered-formats\\.md/.test(tab.textContent || ''))`,
    'Rendered-format fixture tab did not open'
  )
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.tab')]
      .find((node) => /rendered-formats\\.md/.test(node.textContent || ''))
    tab?.click()
    window.__HORSEMD_TEST_CAPTURE_PDF__ = true
    return !!tab
  })()`)
  await waitFor(
    evaluate,
    `!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.querySelector('.milkdown-code-block')`,
    'Rendered-format editor did not finish mounting'
  )

  // Deliberately do not wait for live Mermaid SVGs. PDF export must resolve
  // preview-backed blocks itself instead of depending on viewport timing.
  const tabPoint = await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.tab')]
      .find((node) => node.offsetParent && /rendered-formats\\.md/.test(node.textContent || ''))
    const rect = tab?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  if (!tabPoint) throw new Error('Rendered-format tab point is unavailable')
  await click(send, tabPoint, 'right')
  await waitFor(
    evaluate,
    `[...document.querySelectorAll('button')].some((node) => /PDF/i.test(node.textContent || ''))`,
    'PDF export command did not open'
  )
  await evaluate(`([...document.querySelectorAll('button')].find((node) => /PDF/i.test(node.textContent || ''))?.click(), true)`)
  await waitFor(evaluate, `!!document.querySelector('.hm-pdf-studio')`, 'PDF studio did not open')
  await waitFor(evaluate, `window.__horsemdLastPdfPreview?.result?.ok === true`, 'Rendered-format PDF preview did not complete')
  await waitFor(evaluate, `(() => {
    for (const canvas of document.querySelectorAll('.hm-pdf-page canvas')) {
      if (canvas.width <= 100 || canvas.height <= 100) continue
      const context = canvas.getContext('2d')
      const stepX = Math.max(1, Math.floor(canvas.width / 20))
      const stepY = Math.max(1, Math.floor(canvas.height / 20))
      for (let y = 0; y < canvas.height; y += stepY) {
        for (let x = 0; x < canvas.width; x += stepX) {
          const pixel = context.getImageData(x, y, 1, 1).data
          if (pixel[3] > 0 && (pixel[0] < 245 || pixel[1] < 245 || pixel[2] < 245)) return true
        }
      }
    }
    return false
  })()`, 'Rendered-format PDF canvas did not paint')

  const snapshot = await evaluate(`(() => {
    const capture = window.__horsemdLastPdfPreview
    const template = document.createElement('template')
    template.innerHTML = capture?.source?.html || ''
    const root = template.content
    const diagrams = [...root.querySelectorAll('figure.hm-pdf-mermaid')]
    const svgs = diagrams.map((figure) => figure.querySelector('svg')).filter(Boolean)
    const labelRoot = root.cloneNode(true)
    labelRoot.querySelectorAll('style').forEach((node) => node.remove())
    let paintedSamples = 0
    for (const canvas of document.querySelectorAll('.hm-pdf-page canvas')) {
      if (canvas.width <= 100 || canvas.height <= 100) continue
      const context = canvas.getContext('2d')
      const stepX = Math.max(1, Math.floor(canvas.width / 30))
      const stepY = Math.max(1, Math.floor(canvas.height / 30))
      for (let y = 0; y < canvas.height; y += stepY) {
        for (let x = 0; x < canvas.width; x += stepX) {
          const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data
          if (alpha > 0 && (red < 245 || green < 245 || blue < 245)) paintedSamples += 1
        }
      }
    }
    return {
      diagrams: diagrams.length,
      svgs: svgs.length,
      styledSvgs: svgs.filter((svg) => svg.querySelector('style') && svg.querySelector('[class]')).length,
      dimensionedSvgs: svgs.filter((svg) =>
        Number(svg.getAttribute('width')) > 0 &&
        Number(svg.getAttribute('height')) > 0 &&
        !!svg.getAttribute('viewBox')
      ).length,
      labels: labelRoot.textContent || '',
      hasMermaidSource:
        /flowchart LR|sequenceDiagram|pie title Export share|classDiagram|stateDiagram-v2|erDiagram/
          .test(root.textContent || ''),
      ordinaryCode: [...root.querySelectorAll('pre code')].some((code) =>
        /ordinaryCode/.test(code.textContent || '')
      ),
      invalidMermaidFallback: [...root.querySelectorAll('pre code')].some((code) =>
        /not-a-valid-diagram/.test(code.textContent || '')
      ),
      hasMath: !!root.querySelector('math[display="block"]'),
      hasTable: !!root.querySelector('table th') && root.querySelectorAll('table td').length >= 4,
      hasQuote: !!root.querySelector('blockquote'),
      hasTasks: root.querySelectorAll('input[type="checkbox"]').length,
      hasStrong: [...root.querySelectorAll('strong')].some((node) =>
        /Raw HTML stays structured/.test(node.textContent || '')
      ),
      hasEditorControls: !!root.querySelector(
        '.tools, .preview-panel, .cm-editor, button, .language-picker'
      ),
      images: [...root.querySelectorAll('img')].map((image) => image.outerHTML),
      bytes: capture?.result?.bytes || 0,
      warnings: capture?.result?.warnings || null,
      paintedSamples
    }
  })()`)

  if (snapshot.diagrams !== 6 ||
      snapshot.svgs !== 6 ||
      snapshot.styledSvgs !== 6 ||
      snapshot.dimensionedSvgs !== 6 ||
      snapshot.hasMermaidSource ||
      !snapshot.ordinaryCode ||
      !snapshot.invalidMermaidFallback ||
      !snapshot.hasMath ||
      !snapshot.hasTable ||
      !snapshot.hasQuote ||
      snapshot.hasTasks !== 2 ||
      !snapshot.hasStrong ||
      snapshot.hasEditorControls ||
      snapshot.images.length ||
      snapshot.warnings?.failedImages ||
      snapshot.warnings?.pendingImages ||
      snapshot.bytes < 50000 ||
      snapshot.paintedSamples < 5) {
    throw new Error(`PDF rendered-format matrix failed: ${JSON.stringify(snapshot)}`)
  }

  for (const label of [
    'Flow start',
    'Flow end',
    'Alice',
    'Bob',
    'Rendered',
    'Source',
    'Vehicle',
    'ExportCar',
    'ExportIdle',
    'ExportRunning',
    'EXPORT_CUSTOMER',
    'EXPORT_ORDER'
  ]) {
    if (!snapshot.labels.includes(label)) {
      throw new Error(`PDF Mermaid export lost label ${label}: ${JSON.stringify(snapshot)}`)
    }
  }
  console.log(`PASS PDF rendered formats: ${JSON.stringify(snapshot)}`)
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
}
