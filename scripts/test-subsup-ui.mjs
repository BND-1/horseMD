// Subscript `H~2~O` / superscript `x^2^` (Typora parity, editor-subsup.js).
// Off by default: the same file shows the tildes as text and edits save
// cleanly. With Settings › Markdown syntax on: they render as <sub>/<sup>,
// escaped `\~`, `~~strike~~` and inline code are untouched, typing the closing
// delimiter converts, the authored bytes survive save + reopen, and no
// mismatch warning appears.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-subsup-'))
const file = join(root, 'subsup.md')
const original = [
  '# Sub Sup',
  '',
  '水是 H~2~O，面积 a^2^ 平方米。',
  '',
  '范围 1\\~2 天，删除 ~~del~~，代码 `x~1~`，空格 X~long\\ text~ 尾。',
  '',
  '需要1~2天，费用100~200元。',
  '',
  'end line',
  ''
].join('\n')
await writeFile(file, original)

const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (fn, label, attempts = 150) => {
  for (let i = 0; i < attempts; i++) { const v = await fn(); if (v) return v; await sleep(100) }
  throw new Error(label)
}
const warnings = (app) => app.evaluate(`[...document.querySelectorAll('.toast, [class*=toast], [role=dialog]')].map(n => n.innerText).filter((t) => /不一致|未被覆盖|mismatch|not overwritten/i.test(t))`)
const view = (app) => app.evaluate(`(() => {
  const ed = ${editor}
  return {
    subs: [...ed.querySelectorAll('sub')].map((n) => n.textContent),
    sups: [...ed.querySelectorAll('sup')].map((n) => n.textContent),
    strike: [...ed.querySelectorAll('del, s')].map((n) => n.textContent),
    code: [...ed.querySelectorAll('code')].map((n) => n.textContent),
    text: ed.textContent
  }
})()`)
const clickEnd = (app, needle) => app.evaluate(`(() => {
  const p = [...(${editor}).querySelectorAll('p')].find((n) => n.textContent.includes(${JSON.stringify(needle)}))
  p.scrollIntoView({ block: 'center' })
  const r = document.createRange(); r.selectNodeContents(p); const rects = r.getClientRects(); const last = rects[rects.length - 1]
  return { x: last.right - 1, y: last.top + last.height / 2 }
})()`)
const click = async (app, p) => {
  for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await sleep(300)
}
// Through the real Settings page (the app owns the stored settings).
const enable = async (app) => {
  assert.ok(await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.offsetParent && /settings|设置/i.test(node.title || node.getAttribute('aria-label') || ''))
    button?.click()
    return Boolean(button)
  })()`), 'settings button not found')
  await sleep(400)
  for (const label of ['/^(下标|Subscript)/', '/^(上标|Superscript)/']) {
    assert.ok(await app.evaluate(`(() => {
      const toggle = [...document.querySelectorAll('button[role=switch]')].find((node) => node.offsetParent && ${label}.test(node.getAttribute('aria-label') || ''))
      if (!toggle) return false
      if (toggle.getAttribute('aria-checked') !== 'true') toggle.click()
      return true
    })()`), `toggle ${label} not found`)
    await sleep(200)
  }
  const stored = await app.evaluate(`JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}')`)
  assert.equal(stored.markdownSubscript === true && stored.markdownSuperscript === true, true, 'settings stored')
}
// Relaunches keep the profile (the settings live in it).
const launch = (port, cleanProfile = false) => launchBuiltElectron({ profileDir: join(root, 'profile'), port, cleanProfile, appArgs: [file, '--horsemd-input-trace'] })

const toggleSourceIn = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')].find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click(); return Boolean(button)
})()`)
const visibleSourceIn = (app) => app.evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null`)
const port = 29800 + process.pid % 50
let app = await launch(port, true)
try {
  // 1. Default off: tildes and carets are text.
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('end line')`), 'fixture did not open')
  await sleep(800)
  let state = await view(app)
  assert.deepEqual([state.subs, state.sups], [[], []], `off by default: ${JSON.stringify(state)}`)
  assert.ok(state.text.includes('H~2~O') && state.text.includes('a^2^'), 'off: delimiters shown as text')
  await click(app, await clickEnd(app, 'end line'))
  await typeTextLikeUser(app.send, ' x~1~ y^2^', { delayMs: 90 })
  await sleep(900)
  state = await view(app)
  assert.deepEqual([state.subs, state.sups], [[], []], 'off: typing the delimiters does not convert')
  assert.deepEqual(await warnings(app), [], 'off: no warning')
  // Pasted plain text in a new paragraph (user report: saved as
  // `H\\~2\\~O`, so turning subscript on later showed literal tildes).
  await pressKey(app.send, { key: 'Enter', code: 'Enter' })
  await sleep(300)
  await app.evaluate(`(() => {
    const data = new DataTransfer()
    data.setData('text/plain', 'P~2~Q、b^3^ 约 1~2 天')
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
    document.activeElement.dispatchEvent(event)
    return true
  })()`)
  await sleep(900)
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(async () => (await readFile(file, 'utf8')).includes('end line x~1~ y^2^'), 'off: save did not write')
  await waitFor(async () => (await readFile(file, 'utf8')).includes('P~2~Q'), 'off: pasted line not saved')
  const offSaved = await readFile(file, 'utf8')
  assert.ok(offSaved.includes('P~2~Q、b^3^ 约 1~2 天') && !/\\[~^]/.test(offSaved.replace('1\\~2 天，删除', '')), `off: pasted text saved without added backslashes:\n${offSaved}`)
  // 1b. Turning it on applies to the document that is already open.
  await enable(app)
  assert.ok(await app.evaluate(`(() => { const tab = [...document.querySelectorAll('.tab')].find((n) => /subsup\\.md/.test(n.textContent)); tab?.click(); return Boolean(tab) })()`), 'document tab not found')
  await sleep(1200)
  state = await view(app)
  assert.ok(state.subs.filter((x) => x === '2').length >= 2 && state.sups.includes('3'), `pasted text renders once turned on: ${JSON.stringify(state)}`)
  assert.ok(state.subs.includes('2') && state.subs.includes('1') && state.sups.includes('2'), `on applies to the open document without reopening: ${JSON.stringify(state)}`)
  assert.equal(await app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), false, 're-rendering does not mark the document unsaved')
  assert.ok(!(await readFile(file, 'utf8')).includes('\\^'), 'toggling never escapes the authored carets')
  // ...and the document still edits and saves in this session.
  await click(app, await clickEnd(app, 'end line'))
  await typeTextLikeUser(app.send, ' z^9^', { delayMs: 90 })
  await sleep(900)
  assert.ok((await view(app)).sups.includes('9'), 'typing converts right after turning it on')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(async () => (await readFile(file, 'utf8')).includes('y^2^ z^9^'), 'save after toggling did not write')
  const toggledSave = await readFile(file, 'utf8')
  assert.ok(toggledSave.includes('水是 H~2~O，面积 a^2^ 平方米。') && !toggledSave.includes('\\^'), `save after toggling keeps the authored bytes:\n${toggledSave}`)
  assert.deepEqual(await warnings(app), [], 'save after toggling: no warning')
  // Mode round trip right after turning it on in this session.
  assert.ok(await toggleSourceIn(app), 'source toggle (live)')
  const liveSource = await waitFor(() => visibleSourceIn(app), 'source textarea did not open (live)')
  assert.ok(!/\\[~^]/.test(liveSource.replace('1\\~2', '')) && liveSource.includes('水是 H~2~O，面积 a^2^ 平方米。'), `live: source mode adds no escapes:\n${liveSource}`)
  assert.ok(await toggleSourceIn(app), 'rich toggle (live)')
  await sleep(1200)
  state = await view(app)
  assert.ok(state.subs.includes('2') && state.sups.includes('2') && !/\\/.test(state.text.replace('1~2', '')), `live: back in rich mode: ${JSON.stringify(state)}`)
  assert.deepEqual(await warnings(app), [], 'toggle: no warning')
  await sleep(1500)
  await stopBuiltElectron(app, { removeProfile: false })
  await writeFile(file, original)

  // 2. On: rendering.
  app = await launch(port + 1)
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('end line')`), 'fixture did not reopen')
  await sleep(1000)
  state = await view(app)
  assert.deepEqual(state.subs, ['2', 'long text', '2天，费用100'], `subscripts: ${JSON.stringify(state)}`)
  assert.deepEqual(state.sups, ['2'], `superscripts: ${JSON.stringify(state)}`)
  assert.deepEqual(state.strike, ['del'], '~~del~~ stays strikethrough')
  assert.ok(state.code.includes('x~1~'), 'inline code untouched')
  assert.ok(state.text.includes('范围 1~2 天'), 'escaped \\~ stays text')

  // 3. Typing the closing delimiter converts (input rules).
  await click(app, await clickEnd(app, 'end line'))
  await typeTextLikeUser(app.send, ' CO~2~ 与 x^3^ 后', { delayMs: 90 })
  await sleep(900)
  state = await view(app)
  assert.ok(state.subs.includes('2') && state.subs.filter((s) => s === '2').length === 2, `typed subscript: ${JSON.stringify(state.subs)}`)
  assert.ok(state.sups.includes('3'), `typed superscript: ${JSON.stringify(state.sups)}`)
  // ...and typing inside an existing subscript extends it (byte-exact).
  const inSub = await app.evaluate(`(() => {
    const sub = [...(${editor}).querySelectorAll('sub')].find((n) => n.textContent === 'long text')
    sub.scrollIntoView({ block: 'center' })
    const r = document.createRange(); r.setStart(sub.firstChild, 2); r.setEnd(sub.firstChild, 3)
    const b = r.getBoundingClientRect(); return { x: b.left - 1, y: b.top + b.height / 2 }
  })()`)
  await click(app, inSub)
  await typeTextLikeUser(app.send, 'X', { delayMs: 90 })
  await sleep(900)
  assert.ok((await view(app)).subs.includes('loXng text'), 'typing inside a subscript extends it')
  assert.deepEqual(await warnings(app), [], 'no warning while editing')

  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(async () => (await readFile(file, 'utf8')) !== original, 'save did not write')
  await sleep(400)
  const saved = await readFile(file, 'utf8')
  assert.ok(saved.includes('end line CO~2~ 与 x^3^ 后'), `typed syntax saved:\n${saved}`)
  assert.ok(saved.includes('空格 X~loXng\\ text~ 尾'), `edit inside the subscript is byte-exact:\n${saved}`)
  for (const line of [0, 2, 6].map((i) => original.split('\n')[i])) assert.ok(saved.includes(line), `authored line kept: ${line}\n${saved}`)
  assert.deepEqual(await warnings(app), [], 'save raised no warning')
  await stopBuiltElectron(app, { removeProfile: false })

  // 4. Reopen.
  app = await launch(port + 2)
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('end line')`), 'saved file did not reopen')
  await sleep(800)
  state = await view(app)
  assert.ok(state.subs.filter((s) => s === '2').length === 2 && state.sups.includes('3'), `after reopen: ${JSON.stringify(state)}`)
  assert.deepEqual(await warnings(app), [], 'no warning after reopen')

  // 5. Rich -> source -> rich keeps the syntax and adds no escapes (user
  // report: `H~2~O` came back as `H\~2\~O` after a mode round trip).
  const toggleSource = () => app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')].find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    button?.click(); return Boolean(button)
  })()`)
  const visibleSource = () => app.evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null`)
  await click(app, await clickEnd(app, 'end line'))
  await typeTextLikeUser(app.send, ' H~5~O、b^3^', { delayMs: 90 })
  await sleep(900)
  assert.ok(await toggleSource(), 'source toggle')
  const source = await waitFor(() => visibleSource(), 'source textarea did not open')
  assert.ok(source.includes('H~5~O、b^3^') && source.includes('水是 H~2~O，面积 a^2^ 平方米。'), `source mode shows the syntax as written:\n${source}`)
  assert.ok(!/\\[~^]/.test(source.replace('1\\~2', '')), `no escapes added in source mode:\n${source}`)
  assert.ok(await toggleSource(), 'rich toggle')
  await sleep(1200)
  state = await view(app)
  assert.ok(state.subs.includes('5') && state.sups.includes('3') && state.subs.includes('2') && state.sups.includes('2'), `back in rich mode the syntax renders: ${JSON.stringify(state)}`)
  assert.ok(!/\\/.test(state.text.replace('1~2', '')), `no backslash shown in rich mode: ${state.text}`)
  // A second round trip, after typing in source mode too.
  assert.ok(await toggleSource(), 'source toggle 2')
  const source2 = await waitFor(() => visibleSource(), 'source textarea did not reopen')
  assert.ok(!/\\[~^]/.test(source2.replace('1\\~2', '')), `still no escapes:\n${source2}`)
  assert.ok(await toggleSource(), 'rich toggle 2')
  await sleep(1000)
  assert.deepEqual(await warnings(app), [], 'mode round trips: no warning')
  console.log('PASS sub/sup: off by default; on renders ~x~/^x^, keeps \\~, ~~strike~~, inline code; typing converts; bytes kept through save + reopen')
} finally {
  await stopBuiltElectron(app)
}
