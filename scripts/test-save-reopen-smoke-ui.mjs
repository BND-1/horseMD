// Quick smoke: type into an existing Chinese document, save, fully reopen,
// and verify the typed bytes survived. Run against the default build.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-save-reopen-smoke-${process.pid}`
const file = join(root, 'smoke.md')
const port = Number(process.env.CDP_PORT || 9830)
const initial = '# 测试文档\n\n第一段正文。\n\n- 列表一\n- 列表二\n\n> 引用内容\n\n最后一段。\n'
const expectedTail = '第一段正文。新增内容'
const expected = initial.replace('第一段正文。', expectedTail)

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

async function clickTextEnd(evaluate, send, text) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = [...(editor?.querySelectorAll('p, h1') || [])]
      .find((candidate) => candidate.textContent === ${JSON.stringify(text)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: Math.max(rect.left + 5, rect.right - 3), y: rect.top + Math.min(16, rect.height / 2) }
  })()`)
  assert.ok(point, `missing rich block: ${text}`)
  await click(send, point)
  await pressKey(send, { key: 'End', code: 'End', delayMs: 30 })
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({ profileDir: join(root, profile), port: appPort, appArgs: [file] })
  await waitFor(
    () => app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return !!editor
    })()`),
    'fixture did not mount'
  )
  await sleep(400)
  return app
}

async function saveAndWait(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, initial, 'utf8')
  let app
  try {
    app = await openApp('edit', port)
    const { evaluate, send } = app

    // Paragraph: append Chinese, save, reopen.
    await clickTextEnd(evaluate, send, '第一段正文。')
    await typeTextLikeUser(send, '新增内容', { delayMs: 60 })
    await sleep(400)
    assert.equal(await toggleSource(evaluate), true, 'source toggle failed')
    const source = await waitFor(() => visibleSource(evaluate), 'source textarea missing')
    assert.equal(source, expected, `source mismatch after paragraph append: ${JSON.stringify(source)}`)
    assert.equal(await toggleSource(evaluate), true, 'back to rich failed')
    await saveAndWait(app)
    assert.equal(await readFile(file, 'utf8'), expected, 'disk mismatch after paragraph append')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    assert.equal(await toggleSource(app.evaluate), true, 'reopen source toggle failed')
    assert.equal(
      await waitFor(() => visibleSource(app.evaluate), 'reopen source missing'),
      expected,
      'reopen lost the paragraph append'
    )
    await stopBuiltElectron(app, { removeProfile: true })

    // List intent window: type a dash list item, then immediately type in a
    // paragraph and save within the intent TTL window.
    await writeFile(file, initial, 'utf8')
    app = await openApp('edit2', port + 2)
    const { evaluate: evaluate2, send: send2 } = app
    await clickTextEnd(evaluate2, send2, '列表二')
    await pressKey(send2, { key: 'Enter', code: 'Enter', delayMs: 50 })
    await typeTextLikeUser(send2, '新增项', { delayMs: 50 })
    await sleep(200)
    await clickTextEnd(evaluate2, send2, '最后一段。')
    await typeTextLikeUser(send2, '补充', { delayMs: 50 })
    await sleep(300)
    const listExpected = initial.replace('最后一段。', '最后一段。补充').replace('列表二', '列表二\n- 新增项')
    await saveAndWait(app)
    assert.equal(await readFile(file, 'utf8'), listExpected, 'disk mismatch in intent window')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen2', port + 3)
    assert.equal(await toggleSource(app.evaluate), true, 'reopen2 source toggle failed')
    assert.equal(
      await waitFor(() => visibleSource(app.evaluate), 'reopen2 source missing'),
      listExpected,
      'reopen lost the list-intent window edits'
    )
    await stopBuiltElectron(app, { removeProfile: true })

    // Quote-following empty paragraph: click the trailing blank line after a
    // quote (RS-33 family), type, save, reopen.
    const quoteTail = '# 测试文档\n\n第一段正文。\n\n> 引用内容\n'
    await writeFile(file, quoteTail, 'utf8')
    app = await openApp('edit3', port + 4)
    const { evaluate: evaluate3, send: send3 } = app
    const blankPoint = await evaluate3(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraphs = [...(editor?.querySelectorAll('p') || [])]
        .filter((node) => !node.closest('li') && !node.textContent.trim())
      const last = paragraphs.at(-1)
      if (!last) return null
      const rect = last.getBoundingClientRect()
      return { x: rect.left + Math.max(4, Math.min(16, rect.width / 2)), y: rect.top + rect.height / 2 }
    })()`)
    assert.ok(blankPoint, 'trailing blank paragraph not found')
    await click(send3, blankPoint)
    await sleep(150)
    await pressKey(send3, { key: 'End', code: 'End', delayMs: 50 })
    await typeTextLikeUser(send3, '引用后新增', { delayMs: 60 })
    await sleep(400)
    const quoteExpected = quoteTail + '\n引用后新增\n'
    await saveAndWait(app)
    assert.equal(await readFile(file, 'utf8'), quoteExpected, 'disk mismatch after quote-following append')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen3', port + 5)
    assert.equal(await toggleSource(app.evaluate), true, 'reopen3 source toggle failed')
    assert.equal(
      await waitFor(() => visibleSource(app.evaluate), 'reopen3 source missing'),
      quoteExpected,
      'reopen lost the quote-following append'
    )

    console.log('PASS save/reopen smoke: paragraph append and list-intent window survive save and full reopen')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
