import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 9842)
const profileDir = process.env.HORSEMD_DROP_PROFILE || '/tmp/horsemd-drop-open-ui'

async function waitFor(app, expression, label, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    if (await app.evaluate(expression)) return
    await sleep(125)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function dropPaths(app, paths, targetSelector = '.pane-center') {
  const point = await app.evaluate(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(targetSelector)})]
      .find((node) => node.offsetParent) || document.body
    const rect = target.getBoundingClientRect()
    return {
      x: Math.round(rect.left + Math.max(12, rect.width / 2)),
      y: Math.round(rect.top + Math.max(12, rect.height / 2))
    }
  })()`)
  const data = {
    items: [],
    files: paths,
    dragOperationsMask: 1
  }
  await app.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data })
  await app.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data })
  return { point, data }
}

async function finishDrop(app, drag) {
  await app.send('Input.dispatchDragEvent', { type: 'drop', ...drag.point, data: drag.data })
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'horsemd-drop-open-'))
  const first = join(root, 'dragged-first.md')
  const second = join(root, 'dragged-second.md')
  const mixedDocument = join(root, 'dragged-with-image.md')
  const folder = join(root, 'dragged-folder')
  const nativeImage = join(root, 'native-drop-image.png')
  await writeFile(first, '# Dropped first\n\nUnique drop-open body.\n')
  await writeFile(second, '# Dropped second\n\nSecond file body.\n')
  await writeFile(mixedDocument, '# Dropped beside image\n')
  await mkdir(folder)
  await writeFile(join(folder, 'inside.md'), '# Inside dropped folder\n')
  await writeFile(nativeImage, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  ))

  const executable = process.env.HORSEMD_APP_PATH
  const app = await launchBuiltElectron({
    profileDir,
    port,
    executable,
    entrypoint: executable ? null : 'out/main/index.cjs'
  })

  try {
    await waitFor(app, `!!document.querySelector('.pane-center')`, 'application shell')

    const cancelledDrag = await dropPaths(app, [first])
    await waitFor(app, `!!document.querySelector('.hm-drop-open-overlay')`, 'drop-open overlay')
    await app.send('Input.dispatchDragEvent', { type: 'dragCancel', ...cancelledDrag.point, data: cancelledDrag.data })
    // CDP dragCancel stops its synthetic drag source but does not emit the
    // target window's native dragleave. Dispatch the browser event that Finder
    // / Explorer produces when the pointer leaves or the operation is cancelled.
    await app.evaluate(`window.dispatchEvent(new DragEvent('dragleave', { bubbles: true }))`)
    await waitFor(app, `!document.querySelector('.hm-drop-open-overlay')`, 'drop-open overlay cancellation')

    const firstDrag = await dropPaths(app, [first])
    await waitFor(app, `!!document.querySelector('.hm-drop-open-overlay')`, 'drop-open overlay before drop')
    await finishDrop(app, firstDrag)
    await waitFor(
      app,
      `(() => [...document.querySelectorAll('.tab')].some((node) => node.title === ${JSON.stringify(first)}))()`,
      'first dropped file tab'
    )
    await waitFor(
      app,
      `(() => [...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent && node.textContent.includes('Unique drop-open body.')))()`,
      'first dropped file content'
    )
    if (await app.evaluate(`!!document.querySelector('.hm-drop-open-overlay')`)) {
      throw new Error('Drop-open overlay remained visible after the drop completed')
    }

    await app.evaluate(`(() => {
      window.__hmLastDroppedNativePaths = null
      window.addEventListener('drop', (event) => {
        window.__hmLastDroppedNativePaths = [...(event.dataTransfer?.files || [])]
          .map((file) => window.api.getPathForDroppedFile(file))
      }, { capture: true, once: true })
    })()`)
    const mixedDrag = await dropPaths(app, [second, folder])
    await finishDrop(app, mixedDrag)
    await waitFor(
      app,
      `(() => [...document.querySelectorAll('.tab')].some((node) => node.title === ${JSON.stringify(second)}))()`,
      'second dropped file tab'
    )
    try {
      await waitFor(
        app,
        `(() => [...document.querySelectorAll('.tree-row')].some((node) => node.title === ${JSON.stringify(folder)}))()`,
        'dropped folder workspace root'
      )
    } catch (error) {
      const diagnostic = await app.evaluate(`(() => ({
        droppedPaths: window.__hmLastDroppedNativePaths,
        rows: [...document.querySelectorAll('.tree-row')].map((node) => node.title),
        sidebar: document.querySelector('.sidebar')?.textContent || ''
      }))()`)
      throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`)
    }

    const imageDropState = await app.evaluate(`(async () => {
      const target = [...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent)
      if (!target) return { error: 'missing-editor' }
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (char) => char.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], 'drop-image.png', { type: 'image/png' }))
      const rect = target.getBoundingClientRect()
      const eventOptions = {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
        clientX: rect.left + Math.min(80, rect.width / 2),
        clientY: rect.top + Math.min(80, rect.height / 2)
      }
      target.dispatchEvent(new DragEvent('dragover', eventOptions))
      const overlayDuringDrag = !!document.querySelector('.hm-drop-open-overlay')
      target.dispatchEvent(new DragEvent('drop', eventOptions))
      return { overlayDuringDrag }
    })()`)
    if (imageDropState?.error) throw new Error(imageDropState.error)
    if (imageDropState.overlayDuringDrag) {
      throw new Error('An image dragged inside the editor incorrectly activated the shell drop overlay')
    }
    await waitFor(
      app,
      `(() => [...document.querySelectorAll('.ProseMirror img')].some((node) => node.offsetParent))()`,
      'editor image insertion after image drop'
    )
    const imageTabOpened = await app.evaluate(
      `(() => [...document.querySelectorAll('.tab-title')].some((node) => node.textContent === 'drop-image.png'))()`
    )
    if (imageTabOpened) throw new Error('Editor image drop was incorrectly opened as a document tab')

    // CDP supplies real native paths but leaves the injected image MIME empty.
    // This still exercises the shell's extension fallback and proves that a
    // document beside an editor-owned image is not silently discarded.
    await app.evaluate(`(() => {
      window.__hmMixedDropProbe = null
      window.addEventListener('dragover', (event) => {
        window.__hmMixedDropProbe = [...(event.dataTransfer?.files || [])].map((file) => ({
          name: file.name,
          type: file.type,
          path: window.api.getPathForDroppedFile(file)
        }))
      }, { capture: true, once: true })
    })()`)
    const mixedEditorDrag = await dropPaths(app, [nativeImage, mixedDocument], '.ProseMirror')
    await finishDrop(app, mixedEditorDrag)
    await waitFor(
      app,
      `(() => [...document.querySelectorAll('.tab')].some((node) => node.title === ${JSON.stringify(mixedDocument)}))()`,
      'document mixed with an editor image'
    )
    const nativeImageTabOpened = await app.evaluate(
      `(() => [...document.querySelectorAll('.tab-title')].some((node) => node.textContent === 'native-drop-image.png'))()`
    )
    if (nativeImageTabOpened) {
      const probe = await app.evaluate('window.__hmMixedDropProbe')
      throw new Error(`Native image from a mixed editor drop was opened as a document tab: ${JSON.stringify(probe)}`)
    }

    console.log('PASS drop-open UI: file tabs, folder workspace root, overlay lifecycle, editor image and mixed-payload boundaries')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
