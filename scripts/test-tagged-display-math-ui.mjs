import assert from 'node:assert/strict'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = 9480 + (process.pid % 300)

const waitFor = async (evaluate, expression, message, attempts = 50) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await evaluate(expression)) return
    await sleep(100)
  }
  throw new Error(message)
}

const app = await launchBuiltElectron({
  profileDir: `/tmp/horsemd-tagged-display-math-${process.pid}`,
  port,
  appArgs: ['scripts/fixtures/tagged-display-math.md']
})

try {
  const { evaluate } = app
  await waitFor(
    evaluate,
    `Boolean([...document.querySelectorAll('.katex-display')].find((node) => node.offsetParent && node.querySelector('.tag')))` ,
    'Tagged display formula did not render'
  )

  const layout = await evaluate(`(() => {
    const display = [...document.querySelectorAll('.katex-display')]
      .find((node) => node.offsetParent && node.querySelector('.tag'))
    const preview = display?.parentElement
    const html = display?.querySelector('.katex-html')
    const tag = html?.querySelector(':scope > .tag')
    const bases = [...(html?.querySelectorAll(':scope > .base') || [])]
    const rect = (node) => {
      const value = node?.getBoundingClientRect()
      return value && { left: value.left, right: value.right, width: value.width }
    }
    return {
      display: rect(display),
      preview: rect(preview),
      tag: rect(tag),
      formulaRight: Math.max(...bases.map((node) => node.getBoundingClientRect().right)),
      paddingRight: Number.parseFloat(getComputedStyle(html).paddingRight),
      tagText: tag?.textContent
    }
  })()`)

  assert.equal(layout.tagText, '(13-3)', 'Unexpected tagged formula fixture')
  assert.ok(layout.display.width >= layout.preview.width - 10,
    `Tagged formula shrank inside its flex preview: ${JSON.stringify(layout)}`)
  assert.ok(layout.tag.left - layout.formulaRight >= 24,
    `Formula number overlaps the equation: ${JSON.stringify(layout)}`)
  assert.ok(layout.paddingRight >= layout.tag.width,
    `Formula number column was not reserved: ${JSON.stringify(layout)}`)

  console.log(`tagged display math UI ok: ${JSON.stringify(layout)}`)
} finally {
  await stopBuiltElectron(app)
}
