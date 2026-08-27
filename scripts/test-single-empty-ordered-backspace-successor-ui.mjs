import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-rs72-single-empty-ordered-backspace-${process.pid}`
const file = join(root, 'rs-72.md')
const port = Number(process.env.CDP_PORT || 11458)
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const fixture = [
  '# RS72',
  '',
  '1. 吗。不开机；口红',
  '',
  '2. ',
  '',
  '3. 露娜了',
  '',
  '啊额绿化',
  '',
  '1',
  '',
  '-   1. 二哥你来拿如果',
  '  - \u200B     就了解了呢',
  '  * 如果可能老顾客',
  '',
  '后文',
  ''
].join('\n')

async function waitFor(check, message, attempts = 150) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function backspace(app) {
  const common = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await sleep(70)
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(70)
}

const focusEmptyBeforeSuccessor = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  if (!editor) return { ok: false, reason: 'no-editor' }
  for (const list of editor.querySelectorAll('ol')) {
    const items = [...list.querySelectorAll(':scope > .milkdown-list-item-block > li')]
    const successorIndex = items.findIndex((item) => {
      const p = item.querySelector(':scope > .children > .content-dom > p') || item.querySelector('p')
      return (p?.textContent || '').includes('露娜了')
    })
    if (successorIndex <= 0) continue
    const item = items[successorIndex - 1]
    const p = item.querySelector(':scope > .children > .content-dom > p') || item.querySelector('p')
    if (!p || (p.textContent || '').replace(/\\u200B/g, '').trim()) continue
    editor.focus()
    const range = document.createRange()
    range.setStart(p, 0)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return { ok: true, itemCount: items.length, html: list.outerHTML.slice(0, 2400) }
  }
  return { ok: false, reason: 'empty-before-successor-not-found', html: editor.innerHTML.slice(0, 3000) }
})()`)

const state = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  let target = null
  for (const list of editor?.querySelectorAll('ol') || []) {
    if ((list.textContent || '').includes('吗。不开机；口红') && (list.textContent || '').includes('露娜了')) {
      target = list
      break
    }
  }
  const items = target ? [...target.querySelectorAll(':scope > .milkdown-list-item-block > li')] : []
  const texts = items.map((item) => {
    const p = item.querySelector(':scope > .children > .content-dom > p') || item.querySelector('p')
    return (p?.textContent || '').replace(/\\u200B/g, '')
  })
  return {
    itemCount: items.length,
    texts,
    preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      markdown: String(markdown || '').slice(0, 900)
    })),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map(({ parsed, expected, ...entry }) => ({
      ...entry,
      candidate: String(entry.candidate || '').slice(0, 900),
      canonical: String(entry.canonical || '').slice(0, 900)
    })),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent && (node.textContent || '').includes('露娜了')))`),
    'RS-72 fixture did not mount'
  )
  await sleep(500)
  return app
}

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'RS-72 save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'RS-72 save did not finish')
}

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await openApp('edit', port)

  const focused = await focusEmptyBeforeSuccessor(app)
  assert.equal(focused.ok, true, `could not focus RS-72 empty ordered item: ${JSON.stringify(focused)}`)
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)

  await backspace(app)
  await sleep(950)

  const after = await state(app)
  console.log('RS72_AFTER_BACKSPACE:', JSON.stringify(after))
  assert.equal(after.itemCount, 2, `RS-72 ordered list did not compact to two items: ${JSON.stringify(after)}`)
  assert.deepEqual(after.texts, ['吗。不开机；口红', '露娜了'], `RS-72 successor disappeared or changed: ${JSON.stringify(after.texts)}`)
  assert.equal(after.integrity.some((entry) => entry.ok === false), false, `RS-72 produced transient integrity failure: ${JSON.stringify(after.integrity)}`)
  assert.equal(after.toasts.some((text) => warningPattern.test(text)), false, `RS-72 showed source warning: ${JSON.stringify(after.toasts)}`)
  assert.equal(
    after.preserve.some((entry) => entry.reason === 'diverged-empty-ordered-backspace-lift' && entry.preserved !== false),
    true,
    `RS-72 structural Backspace was not owned by the dedicated transient lift proof: ${JSON.stringify(after.preserve)}`
  )
  assert.equal(
    after.preserve.some((entry) => entry.reason === 'empty-list-item-filled'),
    false,
    `RS-72 structural Backspace was still claimed by empty-list-item-filled: ${JSON.stringify(after.preserve)}`
  )
  assert.equal(
    after.integrity.some((entry) => entry.ok === true && entry.semanticOk === true && entry.listSlotsMatch === true),
    true,
    `RS-72 did not publish a strict list-equivalent candidate: ${JSON.stringify(after.integrity)}`
  )

  assert.equal(await toggleSource(app), true, 'could not inspect RS-72 source')
  const source = await waitFor(() => visibleSource(app), 'RS-72 source textarea missing')
  console.log('RS72_SOURCE:', JSON.stringify(source))
  assert.match(source, /1\. 吗。不开机；口红[\s\S]*2\. 露娜了/, 'RS-72 source did not retain successor at ordinal 2')
  assert.doesNotMatch(source, /3\. 露娜了/, 'RS-72 source kept stale successor ordinal 3')
  assert.doesNotMatch(source, /(?:^|\n)2\.\s*(?:\n|$)[\s\S]*3\. 露娜了/, 'RS-72 source retained the deleted empty row')
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'RS-72 source leaked Crepe placeholder')
  assert.ok(
    source.includes('-   1. 二哥你来拿如果\n  - \u200B     就了解了呢\n  * 如果可能老顾客'),
    'RS-72 changed unrelated authored diverged-list spelling'
  )

  assert.equal(await toggleSource(app), true, 'could not return RS-72 to rich mode')
  await save(app)
  const disk = await readFile(file, 'utf8')
  assert.equal(disk, source, 'RS-72 disk bytes differ from inspected source')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen', port + 1)
  const reopened = await state(app)
  assert.equal(reopened.itemCount, 2, `RS-72 cold reopen changed ordered item count: ${JSON.stringify(reopened)}`)
  assert.deepEqual(reopened.texts, ['吗。不开机；口红', '露娜了'], `RS-72 cold reopen lost successor: ${JSON.stringify(reopened.texts)}`)
  assert.equal(await toggleSource(app), true, 'could not inspect RS-72 cold-reopen source')
  assert.equal(await waitFor(() => visibleSource(app), 'RS-72 cold-reopen source missing'), disk)

  console.log('PASS RS-72 single empty ordered Backspace: successor, integrity, source, save, and reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
