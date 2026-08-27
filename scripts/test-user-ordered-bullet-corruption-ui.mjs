import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const sourceFixture = '/Users/yangtingyi/vibe_everything/test/无序列表测试.md'
const root = `/tmp/horsemd-user-ordered-corruption-${process.pid}`
const file = join(root, 'fixture.md')
const port = 10800 + (process.pid % 100)
const delay = 70

const waitFor = async (check, message, attempts = 160) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const rawKey = async (send, key, code, keyCode, text = key) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', {
    type: 'char',
    ...common,
    text,
    unmodifiedText: text
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

const placeCaretAfter = async (app, text) => {
  const placed = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.nodeValue !== ${JSON.stringify(text)}) continue
      const range = document.createRange()
      range.setStart(node, node.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
    return false
  })()`)
  if (!placed) throw new Error(`could not place caret after ${text}`)
  await sleep(200)
}

const forestSnippet = (value) => {
  const text = String(value || '')
  const at = text.indexOf('# 森林')
  return at >= 0 ? text.slice(at, at + 500) : text.slice(-500)
}

const diagnostics = (app) => app.evaluate(`({
  preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
    ...entry,
    source: String(source || '').slice(String(source || '').indexOf('# 森林')),
    previous: String(previous || '').slice(String(previous || '').indexOf('# 森林')),
    next: String(next || '').slice(String(next || '').indexOf('# 森林')),
    markdown: String(markdown || '').slice(String(markdown || '').indexOf('# 森林'))
  })),
  intents: (window.__hmListIntentTrace || []).slice(-20),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
})`)

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, await readFile(sourceFixture, 'utf8'))
  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'),
      port,
      appArgs: [file, '--horsemd-input-trace']
    })
    await waitFor(
      () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`),
      'editor did not mount'
    )
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmListIntentTrace = []
    })()`)

    await placeCaretAfter(app, '了科纳克里；你')
    await rawKey(app.send, 'Enter', 'Enter', 13, '')
    await typeTextLikeUser(app.send, 'i哦吼', { delayMs: delay })
    await rawKey(app.send, 'Enter', 'Enter', 13, '')
    await rawKey(app.send, '1', 'Digit1', 49)
    await rawKey(app.send, '.', 'Period', 190)
    await rawKey(app.send, ' ', 'Space', 32)
    await typeTextLikeUser(app.send, '比你厉害', { delayMs: delay })
    await sleep(900)

    const beforeFollowup = await diagnostics(app)
    console.log('AFTER_ORDERED_ITEM')
    console.log('RICH', forestSnippet(await app.evaluate(`([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent || '')`)))
    console.log('DIAGNOSTICS', JSON.stringify(beforeFollowup, null, 2))

    await rawKey(app.send, 'Enter', 'Enter', 13, '')
    await rawKey(app.send, 'Enter', 'Enter', 13, '')
    await typeTextLikeUser(app.send, '厉害吧你是否i额', { delayMs: delay })
    await sleep(900)

    const final = await diagnostics(app)
    console.log('AFTER_FOLLOWUP')
    console.log('RICH', forestSnippet(await app.evaluate(`([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent || '')`)))
    console.log('DIAGNOSTICS', JSON.stringify(final, null, 2))
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
