import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-literal-marker-${process.pid}`
const file = join(root, 'literal-marker.md')
const port = Number(process.env.CDP_PORT || 10040)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const keyDelay = Number(process.env.LIST_LITERAL_KEY_DELAY || 55)

const initial = [
  '1. 有序数字点占位',
  '2. 有序短横占位',
  '3. 有序加号占位',
  '4. 有序星号占位',
  '5. 有序数字括号占位',
  '',
  '- 无序数字点占位',
  '- 无序短横占位',
  '- 无序加号占位',
  '- 无序星号占位',
  '- 无序数字括号占位',
  ''
].join('\n')

const expected = [
  '1. 2. 测试',
  '2. - 测试',
  '3. + 测试',
  '4. * 测试',
  '5. 2) 测试',
  '',
  '- 1. 测试',
  '- - 测试',
  '- + 测试',
  '- * 测试',
  '- 1) 测试',
  ''
].join('\n')

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...point,
    button: 'left',
    clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...point,
    button: 'left',
    clickCount: 1
  })
}

async function clickTextEnd(evaluate, send, text) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    const node = [...(editor?.querySelectorAll('li p') || [])]
      .find((candidate) => candidate.textContent === ${JSON.stringify(text)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return {
      x: Math.max(rect.left + 5, rect.right - 3),
      y: rect.top + Math.max(3, Math.min(12, rect.height / 2))
    }
  })()`)
  assert.ok(point, `missing list item text: ${text}`)
  await click(send, point)
  await pressKey(send, { key: 'End', code: 'End', delayMs: keyDelay })
}

async function typeRawDelimiter(send, { key, code, keyCode }) {
  const common = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers: ['+', '*', ')'].includes(key) ? 8 : 0
  }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', {
    type: 'char',
    ...common,
    text: key,
    unmodifiedText: key
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(keyDelay)
}

const delimiterKey = (character) => ({
  '-': { key: '-', code: 'Minus', keyCode: 189 },
  '+': { key: '+', code: 'Equal', keyCode: 187 },
  '*': { key: '*', code: 'Digit8', keyCode: 56 },
  '.': { key: '.', code: 'Period', keyCode: 190 },
  ')': { key: ')', code: 'Digit0', keyCode: 48 },
  ' ': { key: ' ', code: 'Space', keyCode: 32 }
})[character]

async function replaceWithLiteralMarker(evaluate, send, oldText, marker) {
  await clickTextEnd(evaluate, send, oldText)
  for (const _character of [...oldText]) {
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: keyDelay })
  }
  for (const character of marker) {
    const delimiter = delimiterKey(character)
    if (delimiter) await typeRawDelimiter(send, delimiter)
    else await typeTextLikeUser(send, character, { delayMs: keyDelay })
  }
  await typeRawDelimiter(send, delimiterKey(' '))
  await typeTextLikeUser(send, '测试', { delayMs: keyDelay })
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

async function openApp(profile, appPort, reopened = false) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(
    () => app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent)
      return ${JSON.stringify(reopened)}
        ? (editor?.textContent.match(/测试/g) || []).length >= 10 &&
          !editor?.textContent.includes('占位')
        : editor?.textContent.includes('有序数字点占位') &&
          editor?.textContent.includes('无序数字括号占位')
    })()`),
    'literal-number fixture did not mount'
  )
  await sleep(400)
  return app
}

async function assertSource(evaluate, stage) {
  const source = await waitFor(() => visibleSource(evaluate), `${stage}: source textarea did not appear`)
  if (source !== expected) {
    console.error(`--- ${stage} actual ---\n${source}--- expected ---\n${expected}`)
  }
  assert.equal(source, expected, `${stage}: literal marker text or outer list formatting drifted`)
  assert.doesNotMatch(
    source,
    /(?:\\[-+*]|\d+\\[.)])[ \t]/,
    `${stage}: serializer list-marker backslash leaked into source`
  )
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, initial)

  let app
  try {
    app = await openApp('edit', port)
    const cases = [
      ['有序数字点占位', '2.'],
      ['有序短横占位', '-'],
      ['有序加号占位', '+'],
      ['有序星号占位', '*'],
      ['有序数字括号占位', '2)'],
      ['无序数字点占位', '1.'],
      ['无序短横占位', '-'],
      ['无序加号占位', '+'],
      ['无序星号占位', '*'],
      ['无序数字括号占位', '1)']
    ]
    for (const [placeholder, marker] of cases) {
      await replaceWithLiteralMarker(app.evaluate, app.send, placeholder, marker)
    }

    // Switch immediately after the final character to cover the pending flush.
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch to source mode')
    await assertSource(app.evaluate, 'first source switch')
    assert.equal(await toggleSource(app.evaluate), true, 'could not return to rich mode')
    assert.equal(await toggleSource(app.evaluate), true, 'could not inspect source twice')
    await assertSource(app.evaluate, 'second source switch')
    assert.equal(await toggleSource(app.evaluate), true, 'could not return to rich before save')

    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    assert.equal(await readFile(file, 'utf8'), expected, 'disk file contains a serializer list-marker escape or outer marker drift')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1, true)
    assert.equal(await toggleSource(app.evaluate), true, 'could not inspect reopened source')
    await assertSource(app.evaluate, 'full reopen')

    console.log('PASS list-item literal markers: ordered and bullet item bodies keep visible `-`, `+`, `*`, `1.`, and `1)` text without serializer backslashes')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
