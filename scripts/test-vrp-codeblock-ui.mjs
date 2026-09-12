// VRP code-block UI regression (real built app, CDP, background mode).
//
// Verifies the three things the pure Node test cannot:
//   1. a ```vrp fence reaches the code block and the language picker shows it
//   2. the block is really tokenized — VRP keyword / atom / comment / interface
//      tokens get different computed colors (a language that failed to load
//      would paint everything in the default text color). Tokenization is
//      asynchronous (the language support is load()ed), so this waits for the
//      first token spans instead of reading the DOM right after mount.
//   3. typing a command prefix inside the VRP block opens the VRP command
//      completion menu, while the SAME prefix in a javascript block does not
//      (completions are scoped to the vrp language)
//
// Run: node scripts/test-vrp-codeblock-ui.mjs
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

// Workspace-local fixture directory: the shared helpers default to /tmp, which
// resolves outside the project directory on Windows.
const dir = process.env.VRP_UI_DIR || join(process.cwd(), '.tmp-vrp-codeblock-ui')
const file = join(dir, 'vrp-codeblock.md')
const port = Number(process.env.CDP_PORT || 9541)

async function waitFor(check, message, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(120)
  }
  throw new Error(message)
}

// Read both code blocks: the VRP fixture block and the javascript control.
const readCodeBlocks = (app) => app.evaluate(`(() => {
  const visible = (node) => Boolean(node?.offsetParent)
  const editor = [...document.querySelectorAll('.ProseMirror')].find(visible)
  const blocks = [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
  if (blocks.length < 2) return null
  const dump = (block) => {
    const cm = block.querySelector('.cm-editor')
    if (!cm) return null
    const lines = [...cm.querySelectorAll('.cm-line')]
    const spans = lines.flatMap((line) => [...line.querySelectorAll('span')])
    const colorOf = (text) => {
      const span = spans.find((node) => node.textContent.trim() === text)
      return span ? getComputedStyle(span).color : null
    }
    return {
      toolsText: (block.querySelector('.tools')?.textContent || '').trim(),
      lineCount: lines.length,
      spanCount: spans.length,
      codeText: lines.map((line) => line.textContent).join('\\n'),
      keyword: colorOf('system-view'),
      atom: colorOf('192.168.10.1'),
      iface: colorOf('Vlanif10'),
      comment: colorOf('# VLAN 10 网关'),
      plain: colorOf('SW-TEST'),
      firstLineHTML: lines[0]?.innerHTML || ''
    }
  }
  return { vrp: dump(blocks[0]), js: dump(blocks[1]) }
})()`)

// Click a real mouse event into the block's CodeMirror line (mid-line, so CM's
// own click handler places the caret), go to the line start, then type committed
// characters (repo convention: no bulk DOM writes). Returns whether the text
// actually reached that block — a missed click would send it to the ProseMirror
// document instead, which must fail the test rather than look like "no menu".
async function typeIntoBlock(app, blockIndex, lineMatch, text) {
  const point = await app.evaluate(`(() => {
    const visible = (node) => Boolean(node?.offsetParent)
    const editor = [...document.querySelectorAll('.ProseMirror')].find(visible)
    const blocks = [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
    const cm = blocks[${blockIndex}]?.querySelector('.cm-editor')
    const line = [...(cm?.querySelectorAll('.cm-line') || [])]
      .find((node) => node.textContent.includes(${JSON.stringify(lineMatch)}))
    if (!line) return null
    const rect = line.getBoundingClientRect()
    return { x: Math.round(rect.left + 40), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  if (!point) return { ok: false, reason: `line not found: ${lineMatch}` }
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: point.x, y: point.y })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x, y: point.y })
  await sleep(150)
  await pressKey(app.send, { key: 'Home' })
  await sleep(80)
  await typeTextLikeUser(app.send, text)
  await sleep(150)
  const after = await app.evaluate(`(() => {
    const visible = (node) => Boolean(node?.offsetParent)
    const editor = [...document.querySelectorAll('.ProseMirror')].find(visible)
    const blocks = [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
    return blocks[${blockIndex}]?.querySelector('.cm-editor')?.textContent || ''
  })()`)
  return { ok: String(after).includes(text), after }
}

async function main() {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, [
    '# VRP code block',
    '',
    '```vrp',
    '# VLAN 10 网关',
    'system-view',
    'sysname SW-TEST',
    'interface Vlanif10',
    ' ip address 192.168.10.1 255.255.255.0',
    '```',
    '',
    '```javascript',
    'const total = 1 + 2',
    '```'
  ].join('\n'), 'utf8')

  const app = await launchBuiltElectron({
    profileDir: join(dir, 'profile'),
    port,
    appArgs: [file]
  })

  try {
    // ---- 1: mounted fixture ----
    const initial = await waitFor(() => readCodeBlocks(app), 'VRP code block did not render in rich mode')
    assert.ok(initial.vrp.codeText.includes('system-view'), `VRP code text missing: ${initial.vrp.codeText}`)
    assert.ok(/vrp/i.test(initial.vrp.toolsText), `language picker does not show vrp: "${initial.vrp.toolsText}"`)

    // ---- 2: tokenization (async — wait for the first token spans) ----
    let info = initial
    for (let attempt = 0; attempt < 60 && info.vrp.spanCount < 3; attempt += 1) {
      await sleep(120)
      info = (await readCodeBlocks(app)) || info
    }
    assert.ok(
      info.vrp.spanCount >= 3,
      `VRP block produced ${info.vrp.spanCount} token spans (javascript control: ${info.js?.spanCount}) — ` +
        `first line HTML: ${info.vrp.firstLineHTML}`
    )
    const colors = [info.vrp.keyword, info.vrp.atom, info.vrp.iface, info.vrp.comment].filter(Boolean)
    assert.equal(colors.length, 4, `VRP tokens not found among ${info.vrp.spanCount} spans`)
    assert.ok(
      new Set(colors).size >= 3,
      `VRP tokens share colors — language likely not applied: ${JSON.stringify({
        keyword: info.vrp.keyword,
        atom: info.vrp.atom,
        iface: info.vrp.iface,
        comment: info.vrp.comment
      })}`
    )
    assert.notEqual(info.vrp.keyword, info.vrp.plain, 'keyword and identifier rendered the same color')

    // ---- 3: completion in VRP, not in javascript ----
    const typedVrp = await typeIntoBlock(app, 0, 'system-view', 'sys')
    assert.equal(typedVrp.ok, true, `typing did not reach the VRP code block: ${JSON.stringify(typedVrp)}`)
    const menu = await waitFor(() => app.evaluate(`(() => {
      // CM tooltips can be position:fixed, where offsetParent is null — use the
      // client rect instead of the offsetParent visibility trick.
      const tooltip = [...document.querySelectorAll('.cm-tooltip-autocomplete')]
        .find((node) => node.getBoundingClientRect().width > 0)
      if (!tooltip) return null
      return { options: [...tooltip.querySelectorAll('li')].map((node) => node.textContent) }
    })()`), 'VRP command completion did not open after typing "sys"')
    assert.ok(
      menu.options.some((option) => option.includes('system-view')),
      `completion menu lacks system-view: ${JSON.stringify(menu.options.slice(0, 6))}`
    )
    await pressKey(app.send, { key: 'Escape' })
    await sleep(200)

    const typedJs = await typeIntoBlock(app, 1, 'const total', 'sys')
    assert.equal(typedJs.ok, true, `typing did not reach the javascript code block: ${JSON.stringify(typedJs)}`)
    await sleep(900)
    const leaked = await app.evaluate(`(() => [...document.querySelectorAll('.cm-tooltip-autocomplete')]
      .some((node) => node.getBoundingClientRect().width > 0))()`)
    assert.equal(leaked, false, 'VRP completions leaked into a javascript code block')

    console.log('PASS vrp code block UI: fence labelled, tokens colored, completions scoped to vrp')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
