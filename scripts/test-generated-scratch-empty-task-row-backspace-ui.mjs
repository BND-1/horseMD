import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-rs60-empty-task-row-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10601)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /源码|source|不一致|保存已暂停|Save paused/i

async function waitFor(check, message, attempts = 150) {
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
  await sleep(95)
}

const keySpec = (ch) => {
  if (ch === '/') return ['/', 'Slash', 191]
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

async function clickPoint(app, expression, message) {
  const point = await app.evaluate(expression)
  assert.ok(point, message)
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
  const tasks = blocks.filter((node) => node.querySelector('.label-wrapper .label'))
  return {
    tasks: tasks.map((node) => ({
      label: node.querySelector('.label-wrapper .label')?.className || '',
      paragraphs: [...node.querySelectorAll('.children p')].map((p) => p.textContent || '')
    })),
    topParagraphs: [...(editor?.querySelectorAll(':scope > p') || [])].map((p) => p.textContent || ''),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-24).map(({ parsed, expected, ...entry }) => ({
      ...entry,
      candidate: String(entry.candidate || '').slice(-600),
      canonical: String(entry.canonical || '').slice(-600)
    })),
    preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      sourceTail: String(source || '').slice(-500),
      previousTail: String(previous || '').slice(-500),
      nextTail: String(next || '').slice(-500),
      markdownTail: String(markdown || '').slice(-500)
    })),
    flush: (window.__hmFlushTrace || []).slice(-16),
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

    // Keep the document generated from an empty source so this exercises the
    // exact generatedScratchRef path from PID 11970.
    await clickPoint(app, `(() => {
      const h1 = [...document.querySelectorAll('.ProseMirror h1')].find((node) => node.offsetParent)
      const r = h1?.getBoundingClientRect()
      return r ? { x: r.left + 8, y: r.top + 12 } : null
    })()`, 'initial heading was not hit-testable')
    await app.send('Input.insertText', { text: 'RS60' })
    await sleep(220)
    await clickPoint(app, `(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const p = [...(editor?.querySelectorAll(':scope > p') || [])].at(-1)
      const r = p?.getBoundingClientRect()
      return r ? { x: r.left + 8, y: r.top + 12 } : null
    })()`, 'initial paragraph was not hit-testable')

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
      'slash task did not create task item'
    )

    await app.send('Input.insertText', { text: '3日未日' })
    await key(app, 'Enter', 'Enter', 13)
    await waitFor(async () => {
      const s = await snapshot(app)
      return s.tasks.length >= 2 && !s.tasks.at(-1)?.paragraphs.join('').trim() ? s : null
    }, 'Enter did not create second empty task item')
    await app.send('Input.insertText', { text: '23日' })
    await sleep(300)

    // Exit the task list through a third empty item, then leave a following
    // top-level paragraph. This makes the regression sensitive to accidental
    // deletion/merging of content after the task list too.
    await key(app, 'Enter', 'Enter', 13)
    await key(app, 'Enter', 'Enter', 13)
    await app.send('Input.insertText', { text: '后文' })
    await waitFor(async () => {
      const s = await snapshot(app)
      return s.tasks.length === 2 && s.tasks[1]?.paragraphs.join('').includes('23日') &&
        s.topParagraphs.some((text) => text.includes('后文')) ? s : null
    }, 'could not establish two task items followed by top-level content')

    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
      window.__hmFlushTrace = []
    })()`)

    // Delete the second task body down to empty, exactly like the user trace.
    await clickPoint(app, `(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const tasks = [...(editor?.querySelectorAll('.milkdown-list-item-block') || [])]
        .filter((node) => node.querySelector('.label-wrapper .label'))
      const p = [...(tasks[1]?.querySelectorAll('.children p') || [])].at(-1)
      const r = p?.getBoundingClientRect()
      return r ? { x: Math.max(r.left + 4, r.right - 3), y: r.top + Math.max(8, Math.min(16, r.height / 2)) } : null
    })()`, 'second task paragraph was not hit-testable')
    for (let index = 0; index < 3; index += 1) await key(app, 'Backspace', 'Backspace', 8)
    await sleep(650)

    const emptyRow = await snapshot(app)
    assert.equal(emptyRow.tasks.length, 2, `second task row disappeared too early: ${JSON.stringify(emptyRow)}`)
    assert.equal(emptyRow.tasks[1]?.paragraphs.join(''), '', `second task row was not empty: ${JSON.stringify(emptyRow)}`)
    assert.equal(emptyRow.integrity.some((entry) => entry.ok === false), false, `emptying task body already failed integrity: ${JSON.stringify(emptyRow)}`)

    // One more Backspace removes the empty task row. PM keeps one empty
    // paragraph inside the preceding task item; authored Markdown cannot encode
    // that transient and should simply drop the second task source row.
    await key(app, 'Backspace', 'Backspace', 8)
    await sleep(900)

    const merged = await snapshot(app)
    console.log('RS60_AFTER_MERGE:', JSON.stringify(merged))
    assert.equal(merged.tasks.length, 1, `empty second task was not removed: ${JSON.stringify(merged)}`)
    assert.equal(merged.tasks[0]?.paragraphs[0], '3日未日', `surviving task text changed: ${JSON.stringify(merged)}`)
    assert.equal(merged.tasks[0]?.paragraphs.length, 2, `surviving task must own one trailing empty paragraph transient: ${JSON.stringify(merged)}`)
    assert.equal(merged.tasks[0]?.paragraphs.at(-1), '', `task continuation was not empty: ${JSON.stringify(merged)}`)
    assert.equal(merged.topParagraphs.some((text) => text.includes('后文')), true, `following paragraph disappeared: ${JSON.stringify(merged)}`)
    assert.equal(merged.integrity.some((entry) => entry.ok === false), false, `RS-60 integrity failure: ${JSON.stringify(merged)}`)
    assert.ok(
      merged.integrity.some((entry) =>
        entry.preservationReason === 'empty-task-item-merged-to-continuation' &&
        entry.ok === true && entry.semanticOk === true
      ),
      `missing RS-60 dedicated integrity proof: ${JSON.stringify(merged.integrity)}`
    )
    assert.equal(merged.toasts.some((text) => warningPattern.test(text)), false, `RS-60 showed source warning: ${JSON.stringify(merged.toasts)}`)

    // Force the generated-scratch flush while the editor-owned continuation is
    // still present. It must reuse the same proof and never leak <br />/U+200B.
    assert.equal(await toggleSource(app), true, 'could not switch to source during RS-60 transient')
    const source = await waitFor(() => visibleSource(app), 'source textarea missing')
    console.log('RS60_SOURCE:', JSON.stringify(source))
    assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'RS-60 leaked <br /> into source')
    assert.equal((source.match(/^[*+-] \[[ xX]\]/gm) || []).length, 1, `deleted task row remained in source: ${JSON.stringify(source)}`)
    assert.match(source, /^[*+-] \[ \] 3日未日$/m, `surviving task source changed: ${JSON.stringify(source)}`)
    assert.match(source, /^后文$/m, `following paragraph missing from source: ${JSON.stringify(source)}`)

    assert.equal(await toggleSource(app), true, 'could not return to rich mode')
    await save(app)
    assert.equal(await readFile(file, 'utf8'), source, 'saved RS-60 source differs from inspected source')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    const reopened = await snapshot(app)
    assert.equal(reopened.tasks.length, 1, `cold reopen resurrected deleted task row: ${JSON.stringify(reopened)}`)
    assert.equal(reopened.tasks[0]?.paragraphs.length, 1, `cold reopen retained editor-only empty continuation: ${JSON.stringify(reopened)}`)
    assert.equal(reopened.tasks[0]?.paragraphs[0], '3日未日', `cold reopen changed surviving task: ${JSON.stringify(reopened)}`)
    assert.equal(reopened.topParagraphs.some((text) => text.includes('后文')), true, `cold reopen lost following content: ${JSON.stringify(reopened)}`)
    assert.equal(await toggleSource(app), true, 'could not inspect reopened source')
    assert.equal(await waitFor(() => visibleSource(app), 'reopened source missing'), source)

    console.log('PASS RS-60 generated scratch empty task row Backspace: integrity, source, flush, save, and reopen stable')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
