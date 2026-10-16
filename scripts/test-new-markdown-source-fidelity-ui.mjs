import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const dir = '/tmp/horsemd-new-markdown-source-fidelity'
const port = Number(process.env.CDP_PORT || 9677)

async function waitFor(check, message, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const nativeClick = async (evaluate, send, expression) => {
  const point = await evaluate(`(() => {
    const node = ${expression}
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  assert.ok(point, `native click target missing: ${expression}`)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
}

const toggleSource = (evaluate, send) => nativeClick(
  evaluate,
  send,
  `[...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))`
)

const focusBody = (evaluate, send) => nativeClick(
  evaluate,
  send,
  `[...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.offsetParent)?.querySelector('p')`
)

async function runScenario({ name, initial = '', type, expected, scenarioPort }) {
  const file = join(dir, `${name}.md`)
  await writeFile(file, initial, 'utf8')
  const app = await launchBuiltElectron({
    profileDir: join(dir, `${name}-profile`),
    port: scenarioPort,
    appArgs: [file]
  })
  const { evaluate, send } = app

  try {
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      `${name}: rich editor did not open`
    )
    await focusBody(evaluate, send)
    await type({ send, evaluate })
    await sleep(800)
    await toggleSource(evaluate, send)
    const actual = await waitFor(
      () => visibleSource(evaluate),
      `${name}: source mode did not open`
    )
    assert.equal(actual, expected, `${name}: newly typed Markdown source changed`)

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await toggleSource(evaluate, send)
      await waitFor(
        () => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
        `${name}: rich editor did not return in cycle ${cycle + 1}`
      )
      await toggleSource(evaluate, send)
      assert.equal(
        await waitFor(() => visibleSource(evaluate), `${name}: source mode did not return`),
        expected,
        `${name}: source changed after rich/source cycle ${cycle + 1}`
      )
    }

    await toggleSource(evaluate, send)
    await waitFor(
      () => evaluate(`!!document.querySelector('.hm-save-fab')`),
      `${name}: save button did not appear`
    )
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(
      () => evaluate(`!document.querySelector('.hm-save-fab')`),
      `${name}: save did not finish`
    )
    assert.equal(await readFile(file, 'utf8'), expected, `${name}: saved source changed`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

async function typeBulletList(marker, send) {
  await typeTextLikeUser(send, `${marker} `, { delayMs: 80 })
  await typeTextLikeUser(send, '第一项', { delayMs: 80 })
  await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 80 })
  await typeTextLikeUser(send, '第二项', { delayMs: 80 })
}

async function main() {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  for (const [index, marker] of ['-', '*', '+'].entries()) {
    await runScenario({
      name: `bullet-${index}`,
      scenarioPort: port + index,
      expected: `${marker} 第一项\n${marker} 第二项\n`,
      type: ({ send }) => typeBulletList(marker, send)
    })
  }

  await runScenario({
    name: 'paragraphs',
    scenarioPort: port + 3,
    expected: '第一段\n\n第二段\n',
    type: async ({ send }) => {
      await typeTextLikeUser(send, '第一段', { delayMs: 80 })
      await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 80 })
      await typeTextLikeUser(send, '第二段', { delayMs: 80 })
    }
  })

  await runScenario({
    name: 'empty-paragraph',
    scenarioPort: port + 4,
    expected: '第一段\n\n\n\n第二段\n',
    type: async ({ send }) => {
      await typeTextLikeUser(send, '第一段', { delayMs: 80 })
      await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 80 })
      await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 80 })
      await typeTextLikeUser(send, '第二段', { delayMs: 80 })
    }
  })

  console.log('PASS new Markdown source fidelity UI: typed markers and paragraph boundaries remain authored')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
