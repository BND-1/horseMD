// Real Electron regression for image/Mermaid aspect ratio and lightbox controls.
import { connectCdp, sleep } from './lib/cdp.mjs'

async function clickPoint(send, point, count = 1) {
  for (let i = 0; i < count; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1
    })
    await sleep(90)
  }
}

const near = (a, b, tolerance = 0.035) => Math.abs(a - b) / Math.max(a, b) <= tolerance

async function main() {
  const { ws, send, evaluate } = await connectCdp({ attempts: 50 })
  await send('Runtime.enable')

  // The renderer target is available before launch-path delivery necessarily
  // finishes. Lock the test to the fixture tab so a Mermaid in the onboarding
  // document cannot be clicked just before the fixture becomes active.
  let fixtureReady = false
  for (let i = 0; i < 50 && !fixtureReady; i++) {
    await evaluate(`(() => {
      const tab = [...document.querySelectorAll('.tab')]
        .find((node) => node.textContent.includes('lightbox-aspect'))
      tab?.click()
      return !!tab
    })()`)
    await sleep(200)
    fixtureReady = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.editor-scroll')]
        .find((node) => node.offsetParent && node.querySelector('h1')?.textContent.trim() === 'Lightbox aspect regression')
      return !!editor?.querySelector('.milkdown-code-block .preview svg')
    })()`)
  }
  if (!fixtureReady) throw new Error('Lightbox fixture did not become active')
  await evaluate(`document.querySelector('.hm-lightbox-close')?.click()`)
  await sleep(180)

  let mermaidPoint = null
  for (let i = 0; i < 50; i++) {
    mermaidPoint = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.editor-scroll')]
        .find((node) => node.offsetParent && node.querySelector('h1')?.textContent.trim() === 'Lightbox aspect regression')
      const svg = editor?.querySelector('.milkdown-code-block .preview svg')
      const rect = svg?.getBoundingClientRect()
      return rect?.width ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`)
    if (mermaidPoint) break
    await sleep(200)
  }
  if (!mermaidPoint) throw new Error('Mermaid preview did not render')
  await clickPoint(send, mermaidPoint)
  await sleep(300)

  const mermaid = await evaluate(`(() => {
    const box = document.querySelector('.hm-lightbox-svg')
    const svg = box?.querySelector('svg')
    const boxRect = box?.getBoundingClientRect()
    const svgRect = svg?.getBoundingClientRect()
    const vb = svg?.viewBox?.baseVal
    return {
      open: !!box,
      viewBoxRatio: vb?.width / vb?.height,
      renderedRatio: svgRect?.width / svgRect?.height,
      extraHeight: boxRect?.height - svgRect?.height,
      controls: document.querySelectorAll('.hm-lightbox-controls button').length,
      scale: document.querySelector('.hm-lightbox-scale')?.textContent
    }
  })()`)
  if (!mermaid.open || !near(mermaid.viewBoxRatio, mermaid.renderedRatio) || mermaid.extraHeight > 52 || mermaid.controls !== 4) {
    throw new Error(`Mermaid lightbox geometry failed: ${JSON.stringify(mermaid)}`)
  }

  await evaluate(`document.querySelector('[aria-label="放大"], [aria-label="Zoom in"]')?.click()`)
  await sleep(120)
  const zoomed = await evaluate(`document.querySelector('.hm-lightbox-scale')?.textContent`)
  if (zoomed !== '120%') throw new Error(`Zoom-in control failed: ${zoomed}`)
  await evaluate(`document.querySelector('[aria-label="缩小"], [aria-label="Zoom out"]')?.click()`)
  await sleep(120)
  const restored = await evaluate(`document.querySelector('.hm-lightbox-scale')?.textContent`)
  if (restored !== '100%') throw new Error(`Zoom-out control failed: ${restored}`)
  await evaluate(`document.querySelector('.hm-lightbox-actual')?.click()`)
  await sleep(120)
  const actual = await evaluate(`document.querySelector('.hm-lightbox-scale')?.textContent`)
  await evaluate(`document.querySelector('[aria-label="适应窗口"], [aria-label="Fit to window"]')?.click()`)
  await sleep(120)
  const fitted = await evaluate(`document.querySelector('.hm-lightbox-scale')?.textContent`)
  if (!actual || fitted !== '100%') throw new Error(`Actual/fit controls failed: ${actual}/${fitted}`)

  // A drag installs temporary move/up/click listeners. Closing with Escape
  // before the synthetic follow-up click must remove all of them, otherwise
  // the first click after the lightbox closes is silently swallowed.
  const lifecycle = await evaluate(`(async () => {
    const content = document.querySelector('.hm-lightbox-svg')
    if (!content) return { error: 'lightbox content missing' }
    const rect = content.getBoundingClientRect()
    content.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0,
      clientX: rect.left + 20, clientY: rect.top + 20
    }))
    window.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: rect.left + 50, clientY: rect.top + 45
    }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
    await new Promise((resolve) => setTimeout(resolve, 80))
    const probe = document.createElement('button')
    let clicks = 0
    probe.addEventListener('click', () => { clicks += 1 })
    document.body.appendChild(probe)
    probe.click()
    probe.remove()
    return { closed: !document.querySelector('.hm-image-lightbox'), clicks }
  })()`)
  if (!lifecycle.closed || lifecycle.clicks !== 1) {
    throw new Error(`Lightbox temporary listeners leaked after Escape: ${JSON.stringify(lifecycle)}`)
  }
  await sleep(100)

  const imagePoint = await evaluate(`(() => {
    const image = [...document.querySelectorAll('.ProseMirror img')]
      .find((node) => node.offsetParent && (node.currentSrc || '').includes('lightbox-aspect.svg'))
    image?.scrollIntoView({ block: 'center' })
    const rect = image?.getBoundingClientRect()
    return rect?.width ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  if (!imagePoint) throw new Error('Long image fixture did not render')
  await sleep(200)
  const refreshedImagePoint = await evaluate(`(() => {
    const image = [...document.querySelectorAll('.ProseMirror img')]
      .find((node) => node.offsetParent && (node.currentSrc || '').includes('lightbox-aspect.svg'))
    const rect = image?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  await clickPoint(send, refreshedImagePoint, 2)
  await sleep(300)
  const image = await evaluate(`(() => {
    const media = document.querySelector('.hm-image-lightbox > img')
    const rect = media?.getBoundingClientRect()
    return {
      open: !!media,
      naturalRatio: media?.naturalWidth / media?.naturalHeight,
      renderedRatio: rect?.width / rect?.height,
      controls: document.querySelectorAll('.hm-lightbox-controls button').length
    }
  })()`)
  if (!image.open || !near(image.naturalRatio, image.renderedRatio) || image.controls !== 4) {
    throw new Error(`Image lightbox geometry failed: ${JSON.stringify(image)}`)
  }

  await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    .then((result) => import('node:fs').then(({ writeFileSync }) =>
      writeFileSync('/tmp/horsemd-lightbox-final.png', Buffer.from(result.result.data, 'base64'))))

  console.log(JSON.stringify({ mermaid, zoomed, actual, fitted, lifecycle, image }, null, 2))
  ws.close()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
