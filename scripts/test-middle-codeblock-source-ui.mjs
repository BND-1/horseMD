import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-middle-codeblock-${process.pid}`
const file = join(root, 'middle-codeblock.md')
const port = Number(process.env.CDP_PORT || 10190)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const marker = `surge_${process.pid}`

const initial = [
  '# code block ownership',
  '',
  '- authored bullet',
  '',
  '1. surrounding text',
  '',
  '```',
  '',
  '```',
  '',
  '- following bullet',
  ''
].join('\n')

const expected = initial.replace('```\n\n```', `\`\`\`\n${marker}\n\`\`\``)

async function waitFor(check, message, attempts = 120) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', button: 'left', clickCount: 1, ...point
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', button: 'left', clickCount: 1, ...point
  })
}

const visibleEditor = () => `(() => [...document.querySelectorAll('.ProseMirror')]
  .find((node) => node.offsetParent))()`

const sourceValue = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, initial, 'utf8')

  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'),
      port,
      appArgs: [file],
      executable: packagedAppPath || undefined,
      entrypoint: packagedAppPath ? null : undefined
    })
    await waitFor(() => app.evaluate(`Boolean(${visibleEditor()})`), 'middle code-block editor did not mount')
    await sleep(700)
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      const editor = ${visibleEditor()}
      const content = editor?.querySelector('.milkdown-code-block .cm-content')
      if (!content) return false
      const rect = content.getBoundingClientRect()
      window.__hmMiddleCodeBlockPoint = {
        x: rect.left + Math.max(8, Math.min(30, rect.width / 2)),
        y: rect.top + Math.max(8, Math.min(18, rect.height / 2))
      }
      return true
    })()`)
    const point = await app.evaluate('window.__hmMiddleCodeBlockPoint')
    assert.ok(point, 'empty middle code block was not rendered')
    await click(app.send, point)
    await typeTextLikeUser(app.send, marker, { delayMs: 70 })
    await sleep(700)

    const state = await app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      const block = editor?.querySelector('.milkdown-code-block .cm-content')
      return {
        code: block?.innerText || '',
        toast: [...document.querySelectorAll('[class*="toast"]')]
          .map((node) => node.textContent || '')
          .join('\\n'),
        reasons: (window.__hmPreserveLog || []).slice(-10).map((entry) => entry.reason)
      }
    })()`)
    assert.ok(state.code.includes(marker), `rich code block does not contain ${marker}`)
    assert.doesNotMatch(state.toast, /保存已暂停|无法安全映射|源码与富文本不一致/,
      `code-block edit raised a source-sync warning: ${state.toast}`)

    assert.equal(await toggleSource(app.evaluate), true, 'source toggle button missing')
    const source = await waitFor(() => sourceValue(app.evaluate), 'source mode stayed locked after code-block edit')
    assert.equal(source, expected, 'code-block text was written outside its fenced source block')
    assert.ok(state.reasons.includes('fenced-code-block-content-change'),
      `fenced ownership path was not used: ${JSON.stringify(state.reasons)}`)

    await evaluateSave(app)
    assert.equal(await readFile(file, 'utf8'), expected, 'saved source moved code text outside the fence')
    console.log('PASS middle code-block source ownership: incremental content stays inside the fence')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

async function evaluateSave(app) {
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate("!document.querySelector('.hm-save-fab')"), 'save did not settle')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
