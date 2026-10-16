import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const dir = '/tmp/horsemd-soft-line-breaks'
const file = join(dir, 'soft-line-breaks.md')
const profileDir = join(dir, 'profile')
const port = Number(process.env.CDP_PORT || 9494)
const installedExecutable = process.env.HORSEMD_APP_PATH || ''
const original = [
  '# 单换行显示',
  '',
  '第一字段 alpha',
  '第二字段 beta',
  '第三字段 gamma',
  '',
  '显式硬换行上  ',
  '显式硬换行下'
].join('\n')

async function waitFor(check, message, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const inspectRichLines = (evaluate) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.offsetParent)
  if (!editor) return null
  const topFor = (needle) => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const index = node.nodeValue.indexOf(needle)
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + needle.length)
      return range.getBoundingClientRect().top
    }
    return null
  }
  const inlineBreaks = [...editor.querySelectorAll(
    "span[data-type='hardbreak'][data-is-inline='true']"
  )]
  return {
    firstTop: topFor('第一字段 alpha'),
    secondTop: topFor('第二字段 beta'),
    thirdTop: topFor('第三字段 gamma'),
    hardTop: topFor('显式硬换行上'),
    hardNextTop: topFor('显式硬换行下'),
    inlineBreakCount: inlineBreaks.length,
    inlineBreakAfter: inlineBreaks.map((node) =>
      getComputedStyle(node, '::after').content
    ),
    explicitBreakCount: editor.querySelectorAll(
      "br[data-type='hardbreak'], br[data-is-inline='false']"
    ).length,
    bodyClass: document.body.classList.contains('hm-preserve-soft-breaks')
  }
})()`)

async function main() {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, original, 'utf8')

  const app = await launchBuiltElectron({
    profileDir,
    port,
    appArgs: [file],
    executable: installedExecutable || undefined,
    entrypoint: installedExecutable ? null : undefined
  })

  try {
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent && node.textContent.includes('第三字段 gamma'))`),
      'Rich editor did not load the soft-line-break fixture'
    )

    const initial = await inspectRichLines(app.evaluate)
    assert.equal(initial?.bodyClass, true, 'Soft-line-break display must default to enabled')
    assert.ok(initial.inlineBreakCount >= 2, 'Ordinary source newlines were not preserved as inline break nodes')
    assert.ok(initial.inlineBreakAfter.every((content) => content !== 'none'), 'Inline breaks have no visual line-feed rule')
    assert.ok(initial.secondTop - initial.firstTop > 8, 'First ordinary source newline did not display on a new line')
    assert.ok(initial.thirdTop - initial.secondTop > 8, 'Second ordinary source newline did not display on a new line')
    assert.ok(initial.explicitBreakCount >= 1, 'Explicit Markdown hard break did not remain a real <br>')
    assert.ok(initial.hardNextTop - initial.hardTop > 8, 'Explicit Markdown hard break stopped displaying on a new line')

    assert.equal(await toggleSource(app.evaluate), true, 'Missing source-mode toggle')
    const source = await waitFor(
      () => app.evaluate(`(
        [...document.querySelectorAll('textarea.source-editor')]
          .find((node) => node.offsetParent)?.value ?? null
      )`),
      'Source textarea did not become visible'
    )
    assert.equal(source, original, 'Opening source mode changed ordinary or explicit line breaks')

    assert.equal(await toggleSource(app.evaluate), true, 'Missing rich-mode toggle')
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent && node.textContent.includes('第三字段 gamma'))`),
      'Rich editor did not return after source mode'
    )
    const afterRoundTrip = await inspectRichLines(app.evaluate)
    assert.ok(afterRoundTrip.secondTop - afterRoundTrip.firstTop > 8, 'Source/rich round-trip lost the first visual newline')
    assert.ok(afterRoundTrip.thirdTop - afterRoundTrip.secondTop > 8, 'Source/rich round-trip lost the second visual newline')

    const disk = await readFile(file, 'utf8')
    assert.equal(disk, original, 'Viewing or switching modes changed the source file on disk')

    console.log('soft line breaks UI ok: visual lines, explicit hard break, source round-trip, disk bytes')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
