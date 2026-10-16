import assert from 'node:assert/strict'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = 9510 + (process.pid % 300)

const waitFor = async (evaluate, expression, message, attempts = 50) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await evaluate(expression)) return
    await sleep(100)
  }
  throw new Error(message)
}

const app = await launchBuiltElectron({
  profileDir: `/tmp/horsemd-display-math-scroll-${process.pid}`,
  port,
  appArgs: ['scripts/fixtures/display-math-scroll.md']
})

try {
  const { evaluate } = app
  await waitFor(
    evaluate,
    `[...document.querySelectorAll('.katex-display')].filter((node) => node.offsetParent && node.dataset.hmMathOverflow).length === 2`,
    'Display math overflow state did not settle'
  )

  const formulas = await evaluate(`(() => [...document.querySelectorAll('.katex-display')]
    .filter((node) => node.offsetParent)
    .map((node) => ({
      overflow: node.dataset.hmMathOverflow,
      overflowX: getComputedStyle(node).overflowX,
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      previewOverflow: getComputedStyle(node.parentElement).overflowX
    })))()`)

  const [shortFormula, longFormula] = formulas
  assert.equal(shortFormula.overflow, 'false', `Short formula unexpectedly scrolls: ${JSON.stringify(shortFormula)}`)
  assert.equal(shortFormula.overflowX, 'hidden', `Short formula exposes a scrollbar: ${JSON.stringify(shortFormula)}`)
  assert.equal(shortFormula.clientWidth, shortFormula.scrollWidth,
    `Short formula has unexpected horizontal overflow: ${JSON.stringify(shortFormula)}`)
  assert.equal(shortFormula.previewOverflow, 'hidden',
    `Short formula preview remains a scroll container: ${JSON.stringify(shortFormula)}`)

  assert.equal(longFormula.overflow, 'true', `Long formula cannot scroll: ${JSON.stringify(longFormula)}`)
  assert.equal(longFormula.overflowX, 'auto', `Long formula scroll is disabled: ${JSON.stringify(longFormula)}`)
  assert.ok(longFormula.scrollWidth > longFormula.clientWidth,
    `Long formula does not overflow its own scroll surface: ${JSON.stringify(longFormula)}`)
  assert.equal(longFormula.previewOverflow, 'hidden',
    `Long formula has a duplicate outer scrollbar: ${JSON.stringify(longFormula)}`)

  console.log(`display math scroll UI ok: ${JSON.stringify({ shortFormula, longFormula })}`)
} finally {
  await stopBuiltElectron(app)
}
