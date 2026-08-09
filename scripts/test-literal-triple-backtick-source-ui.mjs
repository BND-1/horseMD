import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-literal-triple-backtick-${process.pid}`
const file = join(root, 'literal-triple-backtick.md')
const port = Number(process.env.CDP_PORT || 10059)
let compositionId = 1

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function openApp(profile, appPort) {
  const executable = process.env.HORSEMD_APP_PATH || process.env.HORSEMD_EXECUTABLE || ''
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file],
    executable: executable || undefined,
    entrypoint: executable ? null : undefined
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
    'literal triple-backtick editor did not open'
  )
  await sleep(500)
  return app
}

async function typeBacktick(send) {
  const common = {
    key: '`',
    code: 'Backquote',
    windowsVirtualKeyCode: 192,
    nativeVirtualKeyCode: 192
  }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', {
    type: 'char',
    ...common,
    text: '`',
    unmodifiedText: '`'
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(70)
}

async function imeType(send, pinyin, committedText) {
  const replacementId = `literal-triple-backtick-${compositionId++}`
  for (let index = 0; index < pinyin.length; index += 1) {
    const character = pinyin[index]
    const code = `Key${character.toUpperCase()}`
    const virtualKeyCode = character.toUpperCase().charCodeAt(0)
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: character,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: character,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode
    })
    const composing = pinyin.slice(0, index + 1)
    await send('Input.imeSetComposition', {
      text: composing,
      selectionStart: composing.length,
      selectionEnd: composing.length,
      replacementId,
      location: 0
    })
    await sleep(45)
  }
  await send('Input.insertText', { text: committedText })
  await sleep(120)
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

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '')
  let app
  try {
    app = await openApp('first-open', port)
    assert.equal(await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      editor?.focus()
      return !!editor
    })()`), true, 'could not focus the empty document')

    for (let index = 0; index < 3; index += 1) await typeBacktick(app.send)
    await imeType(app.send, 'nihao', '你好')
    for (let index = 0; index < 3; index += 1) await typeBacktick(app.send)
    await sleep(500)

    const richState = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const block = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6') || [])]
        .find((node) => node.textContent.includes('\`\`\`你好\`\`\`'))
      return {
        text: block?.textContent || '',
        codeCount: block?.querySelectorAll('code').length ?? -1
      }
    })()`)
    assert.equal(richState.text, '```你好```', 'rich text changed the literal triple-backtick text')
    assert.equal(richState.codeCount, 0, 'same-line triple-backtick text became inline code')

    assert.equal(await toggleSource(app.evaluate), true, 'could not switch the empty document to source mode')
    const source = await waitFor(
      () => visibleSource(app.evaluate),
      'source mode did not open for literal triple-backtick text'
    )
    assert.ok(source.includes('```你好```'), `source lost literal triple backticks: ${JSON.stringify(source)}`)
    assert.ok(!source.includes('\\`'), `source leaked serializer backtick escapes: ${JSON.stringify(source)}`)

    assert.equal(await app.evaluate(`(() => {
      const save = document.querySelector('.hm-save-fab')
      save?.click()
      return !!save
    })()`), true, 'save control was unavailable')
    await waitFor(async () => (await readFile(file, 'utf8')) === source, 'literal triple-backtick source was not saved exactly')

    await stopBuiltElectron(app, { removeProfile: true })
    app = null
    app = await openApp('reopen', port + 1)
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch reopened document to source mode')
    const reopened = await waitFor(
      () => visibleSource(app.evaluate),
      'source mode did not open after full reopen'
    )
    assert.equal(reopened, source, 'full reopen changed the literal triple-backtick source')
    console.log('PASS literal triple-backtick source: per-key delimiters + real IME stay exact through source, save, and reopen')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
