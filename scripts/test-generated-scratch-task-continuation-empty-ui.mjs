import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-rs58-task-continuation-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10411)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /源码|source|不一致|保存已暂停|Save paused/i

async function waitFor(check, message, attempts = 140) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function key(app, keyValue, code, keyCode, text = '') {
  const common = {
    key: keyValue,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) {
    await app.send('Input.dispatchKeyEvent', {
      type: 'char',
      ...common,
      text,
      unmodifiedText: text
    })
  }
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(90)
}

const keySpec = (ch) => {
  if (ch === '/') return ['/', 'Slash', 191]
  if (ch === '-') return ['-', 'Minus', 189]
  if (ch === '[') return ['[', 'BracketLeft', 219]
  if (ch === ']') return [']', 'BracketRight', 221]
  if (ch === ' ') return [' ', 'Space', 32]
  const lower = ch.toLowerCase()
  if (/[a-z]/.test(lower)) return [ch, `Key${lower.toUpperCase()}`, lower.charCodeAt(0)]
  return [ch, ch, ch.charCodeAt(0)]
}

async function typePhysical(app, text) {
  for (const ch of text) {
    const [keyValue, code, keyCode] = keySpec(ch)
    await key(app, keyValue, code, keyCode, ch)
  }
}

async function clickNode(app, selector, ordinal = 0, edge = 'start') {
  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const nodes = [...(editor?.querySelectorAll(${JSON.stringify(selector)}) || [])]
    const node = nodes[${ordinal}]
    if (!node) return null
    const rect = node.getBoundingClientRect()
    const x = ${JSON.stringify(edge)} === 'end'
      ? Math.max(rect.left + 4, rect.right - 3)
      : rect.left + 8
    return { x, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`)
  assert.ok(point, `missing node ${selector}[${ordinal}]`)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(140)
}

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const snapshot = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const blocks = [...(editor?.querySelectorAll('.milkdown-list-item-block') || [])]
  const checked = blocks.find((node) => node.querySelector('.label-wrapper .label.checked'))
  const paragraphs = checked
    ? [...checked.querySelectorAll('.children p')].map((node) => node.textContent || '')
    : []
  return {
    checked: !!checked,
    paragraphs,
    listItems: blocks.length,
    items: blocks.map((node) => ({
      label: node.querySelector('.label-wrapper .label')?.className || '',
      paragraphs: [...node.querySelectorAll('.children p')].map((p) => p.textContent || '')
    })),
    htmlTail: String(editor?.innerHTML || '').slice(-2200),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-18).map(({ parsed, expected, ...entry }) => ({
      ...entry,
      candidate: String(entry.candidate || '').slice(-500),
      canonical: String(entry.canonical || '').slice(-500)
    })),
    preserve: (window.__hmPreserveLog || []).slice(-16).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      sourceTail: String(source || '').slice(-400),
      previousTail: String(previous || '').slice(-400),
      nextTail: String(next || '').slice(-400),
      markdownTail: String(markdown || '').slice(-400)
    })),
    flush: (window.__hmFlushTrace || []).slice(-12),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
    'rich editor did not open'
  )
  await sleep(550)
  return app
}

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '')

  let app
  try {
    app = await openApp('edit', port)
    await clickNode(app, 'h1')
    await app.send('Input.insertText', { text: 'RS58' })
    await sleep(250)
    await clickNode(app, 'p')

    await typePhysical(app, '/task')
    await waitFor(
      () => app.evaluate(`document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item.hover')?.textContent || ''`),
      'slash task menu did not open'
    )
    const selected = await app.evaluate(`document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item.hover')?.textContent || ''`)
    assert.match(selected, /Task|任务|待办/i, `slash query did not select task: ${selected}`)
    await key(app, 'Enter', 'Enter', 13)
    await waitFor(
      () => app.evaluate(`!!document.querySelector('.ProseMirror .label-wrapper .label.unchecked')`),
      'slash task did not create unchecked task'
    )
    await app.send('Input.insertText', { text: '前端' })
    await sleep(450)
    const taskTogglePoint = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const item = [...(editor?.querySelectorAll('.milkdown-list-item-block') || [])]
        .find((node) => node.querySelector('.children')?.textContent?.trim() === '前端')
      const label = item?.querySelector('.label-wrapper')
      const rect = label?.getBoundingClientRect()
      return rect
        ? { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) }
        : null
    })()`)
    assert.ok(taskTogglePoint, 'task checkbox was not hit-testable')
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...taskTogglePoint, button: 'left', clickCount: 1 })
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...taskTogglePoint, button: 'left', clickCount: 1 })
    await waitFor(
      () => app.evaluate(`!!document.querySelector('.ProseMirror .label-wrapper .label.checked')`),
      'task did not become checked'
    )

    // One Enter after a checked task reliably creates a second empty checked
    // task item. Use that stable rich-editor state to reach the exact PM shape
    // from the user trace: put `[ ] ` in the second item, then Backspace at that
    // item's paragraph start so ProseMirror joins it into the first checked task
    // as a second paragraph. generatedScratchRef stays active throughout.
    await key(app, 'Enter', 'Enter', 13)
    const secondTaskReady = await waitFor(async () => {
      const s = await snapshot(app)
      const checkedItems = s.items.filter((item) => /\bchecked\b/.test(item.label))
      return checkedItems.length >= 2 && checkedItems.at(-1)?.paragraphs.every((text) => !text) ? s : null
    }, 'Enter did not create a second empty checked task item')
    const secondTaskPoint = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const checkedItems = [...(editor?.querySelectorAll('.milkdown-list-item-block') || [])]
        .filter((node) => node.querySelector('.label-wrapper .label.checked'))
      const item = checkedItems.at(-1)
      const p = [...(item?.querySelectorAll('.children p') || [])].at(-1)
      if (!p) return null
      const r = p.getBoundingClientRect()
      return { x: r.left + 8, y: r.top + Math.max(8, Math.min(16, r.height / 2)) }
    })()`)
    assert.ok(secondTaskPoint, `second checked task was not hit-testable: ${JSON.stringify(secondTaskReady)}`)
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...secondTaskPoint, button: 'left', clickCount: 1 })
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...secondTaskPoint, button: 'left', clickCount: 1 })
    await sleep(120)
    await typePhysical(app, '[ ] ')
    const secondTaskWithLiteral = await waitFor(async () => {
      const s = await snapshot(app)
      const checkedItems = s.items.filter((item) => /\bchecked\b/.test(item.label))
      return checkedItems.length >= 2 && /\[ \]/.test(checkedItems.at(-1)?.paragraphs.at(-1) || '') ? s : null
    }, `second checked task did not receive [ ] literal: ${JSON.stringify(secondTaskReady)}`)
    const secondTaskStart = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const checkedItems = [...(editor?.querySelectorAll('.milkdown-list-item-block') || [])]
        .filter((node) => node.querySelector('.label-wrapper .label.checked'))
      const item = checkedItems.at(-1)
      const p = [...(item?.querySelectorAll('.children p') || [])]
        .find((node) => /\\[ \\]/.test(node.textContent || ''))
      if (!p) return null
      const r = p.getBoundingClientRect()
      return { x: r.left + 2, y: r.top + Math.max(8, Math.min(16, r.height / 2)) }
    })()`)
    assert.ok(secondTaskStart, `second [ ] task was not hit-testable: ${JSON.stringify(secondTaskWithLiteral)}`)
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...secondTaskStart, button: 'left', clickCount: 1 })
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...secondTaskStart, button: 'left', clickCount: 1 })
    await sleep(120)
    await key(app, 'Backspace', 'Backspace', 8)
    const prepared = await waitFor(async () => {
      const s = await snapshot(app)
      return s.checked && s.paragraphs.length >= 2 && /\[ \]/.test(s.paragraphs.at(-1) || '') ? s : null
    }, 'Backspace did not join second task into first checked task continuation')

    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
      window.__hmFlushTrace = []
    })()`)

    // Put the caret at the end of the continuation and delete ` `, `]`, ` `,
    // `[` exactly as the user did. The last key is the RS-58 trigger.
    const continuationPoint = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const checked = [...(editor?.querySelectorAll('.milkdown-list-item-block') || [])]
        .find((node) => node.querySelector('.label-wrapper .label.checked'))
      const p = [...(checked?.querySelectorAll('.children p') || [])].at(-1)
      if (!p) return null
      const r = p.getBoundingClientRect()
      return { x: Math.max(r.left + 4, r.right - 3), y: r.top + Math.max(8, Math.min(16, r.height / 2)) }
    })()`)
    assert.ok(continuationPoint, 'checked task continuation paragraph missing')
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...continuationPoint, button: 'left', clickCount: 1 })
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...continuationPoint, button: 'left', clickCount: 1 })
    await sleep(100)
    for (let index = 0; index < 4; index += 1) await key(app, 'Backspace', 'Backspace', 8)
    await sleep(850)

    const emptied = await snapshot(app)
    console.log('RS58_AFTER_EMPTY:', JSON.stringify(emptied))
    assert.equal(emptied.checked, true, `checked task disappeared: ${JSON.stringify(emptied)}`)
    assert.equal(emptied.paragraphs.length, 2, `task must retain exactly one empty continuation transient: ${JSON.stringify(emptied)}`)
    assert.equal(emptied.paragraphs.at(-1), '', `continuation was not emptied: ${JSON.stringify(emptied)}`)
    assert.equal(emptied.integrity.some((entry) => entry.ok === false), false, `RS-58 integrity failure: ${JSON.stringify(emptied)}`)
    assert.ok(
      emptied.integrity.some((entry) =>
        entry.preservationReason === 'trailing-list-item-paragraph-emptied' &&
        entry.ok === true && entry.semanticOk === true
      ),
      `missing RS-58 dedicated integrity proof: ${JSON.stringify(emptied.integrity)}`
    )
    assert.equal(emptied.toasts.some((text) => warningPattern.test(text)), false, `RS-58 showed source warning: ${JSON.stringify(emptied.toasts)}`)

    // Force flush while the unrepresentable empty continuation still exists.
    assert.equal(await toggleSource(app), true, 'could not switch to source while RS-58 transient exists')
    const source = await waitFor(() => visibleSource(app), 'source textarea missing')
    assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'RS-58 leaked <br /> into authored source')
    assert.doesNotMatch(source, /^\s+\[\s*\]?\s*$/m, 'RS-58 kept deleted literal continuation bytes')
    assert.match(source, /\* \[x\].*前端/i, `checked task source missing after transient flush: ${JSON.stringify(source)}`)

    assert.equal(await toggleSource(app), true, 'could not return to rich mode')
    await save(app)
    assert.equal(await readFile(file, 'utf8'), source, 'saved RS-58 source differs from inspected source')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    const reopened = await snapshot(app)
    assert.equal(reopened.checked, true, `cold reopen lost checked task: ${JSON.stringify(reopened)}`)
    assert.equal(reopened.paragraphs.length, 1, `cold reopen resurrected empty continuation: ${JSON.stringify(reopened)}`)
    assert.match(reopened.paragraphs[0] || '', /前端/, `cold reopen changed task text: ${JSON.stringify(reopened)}`)
    assert.equal(await toggleSource(app), true, 'could not inspect reopened source')
    assert.equal(await waitFor(() => visibleSource(app), 'reopened source missing'), source)

    console.log('PASS RS-58 generated scratch task continuation empty: integrity, flush, save, and reopen stable')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
