import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

// Issues #105 and #106 regressed when a rich ProseMirror transaction was
// visible before its delayed markdownUpdated callback had updated tab.content.
// This stays intentionally user-like: each edit is committed one character at
// a time, followed immediately by the same Save + Source workflow a person
// uses.  The image assertions count occurrences (rather than merely checking
// they exist) so duplicate serialization cannot hide behind a passing test.
const dir = '/tmp/horsemd-issues-105-106-save-fidelity'
const file = join(dir, 'save-fidelity.md')
const firstPort = Number(process.env.CDP_PORT || 9855)
const source = [
  '# 保存保真回归',
  '',
  '正文尾部',
  '',
  '![image1](assets/one.png)',
  '![image2](assets/two.png)'
].join('\n')

function count(markdown, fragment) {
  return String(markdown).split(fragment).length - 1
}

function assertImageLinksExactlyOnce(markdown, stage) {
  assert.equal(count(markdown, '![image1](assets/one.png)'), 1, `${stage}: image1 was lost or duplicated`)
  assert.equal(count(markdown, '![image2](assets/two.png)'), 1, `${stage}: image2 was lost or duplicated`)
}

async function waitFor(check, message, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const visibleSource = (evaluate) => evaluate(`(() =>
  [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
)()`)

async function toggleSource(evaluate) {
  const changed = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    button?.click()
    return Boolean(button)
  })()`)
  assert.equal(changed, true, 'Could not find the rich/source toggle')
}

async function save(evaluate) {
  await waitFor(() => evaluate(`(() => {
    const button = document.querySelector('.hm-save-fab')
    if (!button) return false
    button.click()
    return true
  })()`), 'Save control did not become available')
}

async function putCaretAfter(evaluate, text) {
  const needle = JSON.stringify(text)
  const placed = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const index = node.nodeValue.indexOf(${needle})
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index + ${needle}.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      return true
    }
    return false
  })()`)
  assert.equal(placed, true, `Could not place the rich-text caret after ${text}`)
}

async function assertSavedAndSource({ evaluate, expectedSuffix, stage }) {
  await waitFor(async () => {
    const markdown = await readFile(file, 'utf8')
    return markdown.includes(`正文尾部${expectedSuffix}`)
  }, `${stage}: the rich edit was not written to disk`)

  const disk = await readFile(file, 'utf8')
  assertImageLinksExactlyOnce(disk, `${stage} disk`)

  await toggleSource(evaluate)
  const sourceValue = await waitFor(
    () => visibleSource(evaluate),
    `${stage}: source mode did not open`
  )
  assert.ok(sourceValue.includes(`正文尾部${expectedSuffix}`), `${stage}: source view omitted the rich edit`)
  assertImageLinksExactlyOnce(sourceValue, `${stage} source`)
  await toggleSource(evaluate)
  await waitFor(
    () => evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent)`),
    `${stage}: rich mode did not return`
  )
}

async function launch(profileDir, port) {
  return launchBuiltElectron({
    profileDir,
    port,
    appArgs: [file],
    executable: process.env.HORSEMD_APP_PATH || undefined,
    entrypoint: process.env.HORSEMD_APP_PATH ? null : undefined
  })
}

async function main() {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, source, 'utf8')

  let app = await launch(join(dir, 'profile-first'), firstPort)
  try {
    const { evaluate, send } = app
    await waitFor(
      () => evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent)`),
      'Rich editor did not become visible'
    )

    let suffix = ''
    for (let index = 1; index <= 8; index += 1) {
      await putCaretAfter(evaluate, `正文尾部${suffix}`)
      const addition = `-${index}`
      await typeTextLikeUser(send, addition)
      suffix += addition
      // Deliberately do not wait for React/Milkdown to publish its callback:
      // immediate Save is the stale-state boundary reported by #105.
      await save(evaluate)
      await assertSavedAndSource({ evaluate, expectedSuffix: suffix, stage: `round ${index}` })
    }
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  app = await launch(join(dir, 'profile-reopen'), firstPort + 1)
  try {
    const { evaluate } = app
    await waitFor(
      () => evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent)`),
      'Reopened rich editor did not become visible'
    )
    await toggleSource(evaluate)
    const sourceValue = await waitFor(() => visibleSource(evaluate), 'Reopened source mode did not open')
    assert.ok(sourceValue.includes('正文尾部-1-2-3-4-5-6-7-8'), 'Reopened document reverted the rich edits')
    assertImageLinksExactlyOnce(sourceValue, 'reopened source')
    assertImageLinksExactlyOnce(await readFile(file, 'utf8'), 'reopened disk')
    console.log('PASS issues 105/106 UI: eight immediate rich-save-source rounds and a fresh reopen preserve edits and exactly one copy of each image link')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
