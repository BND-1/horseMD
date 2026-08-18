// CDP regression for the find/replace match options: matchCase, wholeWord,
// regex (incl. invalid-regex handling), multiline queries, find-in-selection,
// and their integration with the existing highlight/count/replace flow — in
// both the rich editor (CSS Custom Highlight API) and the source textarea.
// Run after `npm run build`: node scripts/test-find-modes-ui.mjs
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const waitFor = async (check, message, attempts = 80) => {
  for (let index = 0; index < attempts; index += 1) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error(message)
}

const openFindBar = async (app) => {
  const commandModifier = await app.evaluate(`navigator.platform?.toLowerCase().includes('mac') ? 4 : 2`)
  await app.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'f', code: 'KeyF', modifiers: commandModifier,
    windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 3
  })
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'f', code: 'KeyF', modifiers: commandModifier,
    windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 3
  })
  await waitFor(() => app.evaluate(`!!document.querySelector('.findbar')`), 'Find bar did not open')
}

// Order matches the FindBar toggle array: matchCase, wholeWord, regex, inSelection.
const TOGGLES = { matchCase: 0, wholeWord: 1, regex: 2, inSelection: 3 }

const clickToggle = async (app, name) => {
  await app.evaluate(`document.querySelectorAll('.findbar-toggle')[${TOGGLES[name]}].click()`)
  await sleep(180)
}

const setQuery = async (app, query) => {
  await app.evaluate(`(() => {
    const input = document.querySelector('.findbar textarea')
    if (!input) return false
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(query)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(260)
}

const setReplace = async (app, text) => {
  await app.evaluate(`(() => {
    const inputs = document.querySelectorAll('.findbar textarea')
    const input = inputs[inputs.length - 1]
    if (!input) return false
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(180)
}

const state = (app) => app.evaluate(`(() => ({
  count: document.querySelector('.findbar-count')?.textContent || '',
  invalid: !!document.querySelector('.findbar textarea.findbar-input-invalid'),
  pressed: [...document.querySelectorAll('.findbar-toggle')].map((button) => button.getAttribute('aria-pressed')),
  richMatches: CSS.highlights?.get('hm-find')?.size || 0,
  richCurrent: CSS.highlights?.get('hm-find-current')?.size || 0,
  sourceValue: [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
}))()`)

const closeFindBar = async (app) => {
  await app.evaluate(`document.querySelector('.findbar textarea')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(200)
}

// ── Rich editor (CSS Custom Highlight API) ───────────────────────────────────
async function richMode() {
  const app = await launchBuiltElectron({
    profileDir: '/tmp/horsemd-find-modes-rich',
    port: 9701,
    appArgs: [join(process.cwd(), 'scripts', 'fixtures', 'find-modes-rich.md')]
  })
  try {
    await waitFor(
      () => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent && node.textContent.includes('alphabet'))`),
      'Rich fixture did not load'
    )
    await openFindBar(app)

    // Default: case-insensitive plain substring, highlights painted for every match.
    await setQuery(app, 'alpha')
    let s = await state(app)
    assert.equal(s.count, '1/6', `default search count: ${s.count}`)
    assert.equal(s.richMatches, 6, `highlight ranges: ${s.richMatches}`)
    assert.equal(s.richCurrent, 1, 'active highlight missing')

    // Match case: only lowercase "alpha" (incl. the prefix of "alphabet").
    await clickToggle(app, 'matchCase')
    s = await state(app)
    assert.equal(s.count.split('/')[1], '3', `matchCase count: ${s.count}`)
    assert.equal(s.pressed[TOGGLES.matchCase], 'true', 'matchCase not pressed')

    await clickToggle(app, 'matchCase')
    s = await state(app)
    assert.equal(s.count.split('/')[1], '6', `matchCase off count: ${s.count}`)

    // Whole word: drops the "alphabet" hit, keeps "Alpha-case" (hyphen boundary).
    await clickToggle(app, 'wholeWord')
    s = await state(app)
    assert.equal(s.count.split('/')[1], '5', `wholeWord count: ${s.count}`)
    assert.equal(s.richMatches, 5, `wholeWord highlight ranges: ${s.richMatches}`)

    // Regex takes over from wholeWord (mutually exclusive).
    await clickToggle(app, 'regex')
    s = await state(app)
    assert.equal(s.pressed[TOGGLES.regex], 'true', 'regex not pressed')
    assert.equal(s.pressed[TOGGLES.wholeWord], 'false', 'wholeWord should release when regex enables')
    assert.equal(s.count.split('/')[1], '6', `regex literal count: ${s.count}`)

    await setQuery(app, '\\b[Aa]lpha\\b')
    s = await state(app)
    assert.equal(s.count.split('/')[1], '5', `regex word-boundary count: ${s.count}`)

    // Multiline regex across paragraphs: block boundaries contribute a single
    // \n to the concatenated scan text, and ^/$ anchor per line.
    await setQuery(app, 'alpha\\.\\nThe')
    s = await state(app)
    assert.equal(s.count.split('/')[1], '1', `multiline regex count: ${s.count}`)
    assert.equal(s.richMatches, 1, `multiline highlight ranges: ${s.richMatches}`)

    // Invalid regex: error styling, zero matches, no crash.
    await setQuery(app, '[')
    s = await state(app)
    assert.equal(s.invalid, true, 'invalid regex not flagged')
    assert.equal(s.count.split('/')[1], '0', `invalid regex count: ${s.count}`)
    await setQuery(app, '\\b[Aa]lpha\\b')
    s = await state(app)
    assert.equal(s.invalid, false, 'error state stuck after fixing the regex')

    // Find in selection: type the query first, then select the middle
    // paragraph in the editor (the real user order — focusing the find input
    // first would clobber an earlier DOM selection), then scope to it.
    await clickToggle(app, 'regex')
    s = await state(app)
    assert.equal(s.pressed[TOGGLES.regex], 'false', 'regex should be off for the plain in-selection query')
    await setQuery(app, 'alpha')
    s = await state(app)
    assert.equal(s.count.split('/')[1], '6', `plain query after regex off: ${s.count}`)
    await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraphs = editor.querySelectorAll('p')
      const target = paragraphs[1]
      const range = document.createRange()
      range.setStart(target.firstChild, 0)
      range.setEnd(target.lastChild, target.lastChild.length)
      const sel = getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      editor.focus()
      return true
    })()`)
    await sleep(300)
    await clickToggle(app, 'inSelection')
    s = await state(app)
    assert.equal(s.count.split('/')[1], '2', `in-selection count: ${s.count}`)
    await clickToggle(app, 'inSelection')
    s = await state(app)
    assert.equal(s.count.split('/')[1], '6', `in-selection off count: ${s.count}`)

    await closeFindBar(app)
    s = await state(app)
    assert.equal(s.richMatches, 0, 'highlights survived find-bar close')
    console.log('PASS find-modes-ui rich: case/word/regex/multiline/invalid/in-selection + highlight integration')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

// ── Source textarea (overlay + offsets) ─────────────────────────────────────
async function sourceMode() {
  const app = await launchBuiltElectron({
    profileDir: '/tmp/horsemd-find-modes-source',
    port: 9702,
    appArgs: [join(process.cwd(), 'scripts', 'fixtures', 'find-modes-source.txt')]
  })
  try {
    await waitFor(
      () => app.evaluate(`(() => {
        const ta = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
        return !!ta && ta.value.startsWith('cat catfish')
      })()`),
      'Source fixture did not load'
    )
    await openFindBar(app)

    await setQuery(app, 'cat')
    let s = await state(app)
    assert.equal(s.count.split('/')[1], '4', `default source count: ${s.count}`)

    await clickToggle(app, 'wholeWord')
    s = await state(app)
    assert.equal(s.count.split('/')[1], '2', `source wholeWord count: ${s.count}`)

    await clickToggle(app, 'wholeWord')
    // Regex with capture-group replace-all: 10x/25x/3x → "$1 times".
    await clickToggle(app, 'regex')
    await setQuery(app, '(\\d+)x')
    s = await state(app)
    assert.equal(s.count.split('/')[1], '3', `source regex count: ${s.count}`)

    // Find in selection scoped to the "numbers:" line only.
    await app.evaluate(`(() => {
      const ta = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
      ta.setSelectionRange(30, 40)
      return true
    })()`)
    await clickToggle(app, 'inSelection')
    s = await state(app)
    assert.equal(s.count.split('/')[1], '2', `source in-selection count: ${s.count}`)

    await clickToggle(app, 'inSelection')
    await setReplace(app, '$1 times')
    await app.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.findbar-textbtn')]
      buttons[buttons.length - 1].click()
      return true
    })()`)
    await waitFor(
      () => app.evaluate(`(() => {
        const ta = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
        return ta.value.includes('10 times 25 times 3 times') && !/\\dx/.test(ta.value)
      })()`),
      'Regex replace-all did not rewrite the source textarea'
    )
    s = await state(app)
    assert.equal(s.count.split('/')[1], '0', `count after replace-all: ${s.count}`)

    // Multiline plain query across adjacent lines.
    await setQuery(app, 'line1\nline2')
    s = await state(app)
    assert.equal(s.count.split('/')[1], '1', `multiline plain count: ${s.count}`)

    await closeFindBar(app)
    console.log('PASS find-modes-ui source: word/regex/in-selection/replace-template/multiline in textarea')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

await richMode()
await sourceMode()
console.log('PASS find-modes-ui: all match-option regressions green')
