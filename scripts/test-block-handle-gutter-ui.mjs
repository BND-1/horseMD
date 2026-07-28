import assert from 'node:assert/strict'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 9726)
const fixture = join(process.cwd(), 'scripts', 'fixtures', 'block-handle-gutter.md')

async function waitFor(check, message, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const moveTo = async (app, point) => {
  // Targets are scrolled to the same viewport center. Move by one pixel first
  // so Chromium cannot coalesce two consecutive events with identical screen
  // coordinates after the document moved underneath the pointer.
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x + 1,
    y: point.y,
    button: 'none'
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none'
  })
  await sleep(300)
}

const getLayoutMetrics = (evaluate) => evaluate(`(() => {
  const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const scrollPort = pm.closest('.editor-scroll')
  const pmRect = pm.getBoundingClientRect()
  const scrollRect = scrollPort.getBoundingClientRect()
  return {
    pmLeft: pmRect.left,
    scrollLeft: scrollRect.left,
    scrollRight: scrollRect.right
  }
})()`)

const revealTarget = async (app, selector, text, xMode = 'trigger') => {
  const spec = JSON.stringify({ selector, text, xMode })
  const found = await app.evaluate(`(() => {
    const spec = ${spec}
    const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = [...pm.querySelectorAll(spec.selector)]
      .find((candidate) => candidate.textContent.trim() === spec.text)
    if (!node) return false
    node.scrollIntoView({ block: 'center', behavior: 'instant' })
    return true
  })()`)
  assert.ok(found, `missing fixture target: ${selector}/${text}`)
  await sleep(220)

  return app.evaluate(`(() => {
    const spec = ${spec}
    const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = [...pm.querySelectorAll(spec.selector)]
      .find((candidate) => candidate.textContent.trim() === spec.text)
    const pmRect = pm.getBoundingClientRect()
    const rect = node.getBoundingClientRect()
    const marker = spec.xMode === 'marker'
      ? node.closest('li')?.querySelector('.label-wrapper')
      : null
    const markerRect = marker?.getBoundingClientRect()
    const x = spec.xMode === 'trigger'
      ? pmRect.left + 4
      : spec.xMode === 'marker'
        ? markerRect.left + markerRect.width / 2
        : Math.max(pmRect.left + 48, rect.left + rect.width / 2)
    return {
      x,
      y: spec.xMode === 'marker'
        ? markerRect.top + markerRect.height / 2
        : rect.top + Math.min(rect.height / 2, 16)
    }
  })()`)
}

const getVisibleHandle = (evaluate) => evaluate(`(() => {
  const handle = [...document.querySelectorAll('.milkdown-block-handle')]
    .find((node) => node.dataset.show === 'true')
  if (!handle) return null
  const rect = handle.getBoundingClientRect()
  const controls = [...handle.querySelectorAll('.operation-item')]
    .map((node) => {
      const controlRect = node.getBoundingClientRect()
      const hit = document.elementFromPoint(
        controlRect.left + controlRect.width / 2,
        controlRect.top + controlRect.height / 2
      )
      return {
        left: controlRect.left,
        right: controlRect.right,
        x: controlRect.left + controlRect.width / 2,
        y: controlRect.top + controlRect.height / 2,
        receivesPointer: hit === node || node.contains(hit)
      }
    })
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    controls
  }
})()`)

const assertSafeRail = (handle, targets, context) => {
  assert.ok(
    handle.left >= targets.scrollLeft + 1,
    `operation bar is clipped at the scroll edge in ${context}: ${JSON.stringify({ handle, targets })}`
  )
  assert.ok(
    handle.right <= targets.pmLeft + 0.5,
    `operation bar overlaps editor content in ${context}: ${JSON.stringify({ handle, targets })}`
  )
  assert.equal(handle.controls.length, 2, `operation bar lost a control in ${context}`)
  handle.controls.forEach((control, index) => {
    assert.ok(
      control.left >= targets.scrollLeft + 1 &&
        control.right <= targets.scrollRight - 1 &&
        control.receivesPointer,
      `control ${index} is clipped or not clickable in ${context}: ${JSON.stringify({ handle, targets })}`
    )
  })
}

async function main() {
  const app = await launchBuiltElectron({
    profileDir: `/tmp/horsemd-block-handle-gutter-${process.pid}`,
    port,
    appArgs: [fixture]
  })

  try {
    await waitFor(
      () => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent)`),
      'block-handle fixture did not open'
    )

    const layouts = [
      { name: 'narrow', width: 760, paneWidth: 260, pageWidth: 560 },
      { name: 'compressed', width: 720, paneWidth: 420, pageWidth: 'full' },
      { name: 'wide', width: 1249, paneWidth: 260, pageWidth: 800 },
      { name: 'full-width', width: 1249, paneWidth: 260, pageWidth: 'full' }
    ]

    for (const layout of layouts) {
      await app.evaluate(`(() => {
        window.resizeTo(${layout.width}, 900)
        document.querySelector('.pane-left')?.style.setProperty('--pane-left-w', '${layout.paneWidth}px')
        document.body.classList.toggle('hm-full-width', ${layout.pageWidth === 'full'})
        if (${layout.pageWidth === 'full'}) return
        document.documentElement.style.setProperty('--editor-max-width', '${layout.pageWidth}px')
      })()`)
      await sleep(500)

      const blockTargets = [
        ['h1', 'Block handle gutter'],
        ['li p', 'List item with ordinary text.'],
        ['li p', 'Nested list item stays on the same operation rail.'],
        ['li p', 'Deep nested list item stays on the same operation rail.'],
        ['p', 'An ordinary paragraph stays editable.'],
        ['h2', 'Secondary heading'],
        ['li p', 'Ordered list item stays aligned.'],
        ['li p', 'Task list item stays aligned.']
      ]
      const rails = []
      for (const [selector, text] of blockTargets) {
        const point = await revealTarget(app, selector, text)
        await moveTo(app, point)
        const handle = await waitFor(
          () => getVisibleHandle(app.evaluate),
          `${text} did not reveal a handle in ${layout.name}`
        )
        const metrics = await getLayoutMetrics(app.evaluate)
        assertSafeRail(handle, metrics, `${layout.name}/${text}`)
        rails.push(handle)
      }

      const [reference] = rails
      rails.forEach((handle, index) => {
        assert.ok(
          Math.abs(handle.left - reference.left) <= 0.5 &&
            Math.abs(handle.right - reference.right) <= 0.5,
          `block ${index} uses a second horizontal rail in ${layout.name}: ${JSON.stringify(rails)}`
        )
      })

      const markerTargets = [
        'List item with ordinary text.',
        'Nested list item stays on the same operation rail.',
        'Deep nested list item stays on the same operation rail.',
        'Ordered list item stays aligned.',
        'Task list item stays aligned.'
      ]
      let markerHandle = null
      for (const text of markerTargets) {
        const marker = await revealTarget(app, 'li p', text, 'marker')
        await moveTo(app, marker)
        markerHandle = await waitFor(
          () => getVisibleHandle(app.evaluate),
          `${text} marker did not reveal a handle in ${layout.name}`
        )
        const markerMetrics = await getLayoutMetrics(app.evaluate)
        assertSafeRail(markerHandle, markerMetrics, `${layout.name}/${text}/marker`)
        assert.ok(
          Math.abs(markerHandle.left - reference.left) <= 0.5 &&
            Math.abs(markerHandle.right - reference.right) <= 0.5,
          `${text} marker uses a second horizontal rail in ${layout.name}`
        )
      }

      for (const control of markerHandle.controls) {
        await moveTo(app, control)
        assert.ok(
          await getVisibleHandle(app.evaluate),
          `operation bar disappeared before a control could be used in ${layout.name}`
        )
      }

      const inlineText = await revealTarget(
        app,
        '.hm-html-inline',
        'highlighted inline HTML text',
        'text'
      )
      await moveTo(app, inlineText)
      assert.equal(
        await getVisibleHandle(app.evaluate),
        null,
        `inline HTML text revealed the block operation bar in ${layout.name}`
      )
      const ordinaryText = await revealTarget(
        app,
        'p',
        'An ordinary paragraph stays editable.',
        'text'
      )
      await moveTo(app, ordinaryText)
      assert.equal(
        await getVisibleHandle(app.evaluate),
        null,
        `ordinary text revealed the block operation bar in ${layout.name}`
      )
    }

    console.log('PASS block-handle UI: one stable, visible and clickable rail across block types/layouts')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
