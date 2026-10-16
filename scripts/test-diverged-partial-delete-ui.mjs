import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-partial-delete-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10010)
const sleepMs = (ms) => sleep(ms)

async function waitFor(check, message, attempts = 150) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleepMs(100)
  }
  throw new Error(message)
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

// Select from `needle` to the END of the document and delete — the shape of a
// user clearing the whole tail of a file in one drag.
async function deleteTailFrom(evaluate, send, needle) {
  const selected = await evaluate(`(() => {
    const editors = [...document.querySelectorAll('.ProseMirror')].filter((n) => n.offsetParent)
    const editor = editors.find((ed) => ed.textContent.includes(${JSON.stringify(needle)}))
    if (!editor) return false
    editor.focus()
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    const nodes = []
    let node
    while ((node = walker.nextNode())) nodes.push(node)
    let startNode = null
    let startOff = 0
    for (const n of nodes) {
      const i = n.nodeValue.indexOf(${JSON.stringify(needle)})
      if (i >= 0) { startNode = n; startOff = i; break }
    }
    if (!startNode) return false
    const last = nodes[nodes.length - 1]
    const range = document.createRange()
    range.setStart(startNode, startOff)
    range.setEnd(last, last.nodeValue.length)
    const sel = getSelection()
    sel.removeAllRanges(); sel.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return sel.toString().length > 0
  })()`)
  if (!selected) return false
  await sleepMs(300)
  await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
  await sleepMs(1200)
  return true
}

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file]
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`),
    'editor did not open'
  )
  await sleepMs(1200)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  // The real 反馈.md shape: `- 1. 管理层` rows make remark parse the doc as
  // nested ordered lists, so the whole canonical visible stream diverges from
  // the authored source. Deleting the document TAIL (several list trees) used
  // to roll back silently; saving then resurrected the content.
  const authored = [
    '# 检查',
    '',
    '>',
    '',
    '> 本检查表自动生成；检索阶段对各范围沿 `refers_to` 做了 2 跳多跳召回。',
    '',
    '## 目录',
    '',
    '- 1. 管理层（总经理）',
    '- 2. 综合行政部',
    '',
    '## 使用说明',
    '',
    '- 适用标准：**ISO 9001:2015**（覆盖主要章节）。',
    '- 本表为 AI 生成草稿，正式发布前需经体系负责人 / 质量部门复核。',
    '- ce'
  ].join('\n') + '\n'
  await writeFile(file, authored)
  let app
  try {
    app = await openApp('edit', port)

    // Delete everything from 「复核」 to the end (two list items + blank lines).
    assert.equal(await deleteTailFrom(app.evaluate, app.send, '复核'), true, 'could not select the tail')
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch to source mode')
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)`), 'source textarea did not appear')
    const raw = await visibleSource(app.evaluate)
    assert.ok(
      !raw.includes('复核') && !raw.includes('- ce'),
      `the deleted tail must vanish from source (got ${JSON.stringify(raw.split('\n').slice(-3))})`
    )
    assert.ok(
      raw.includes('- 本表为 AI 生成草稿，正式发布前需经体系负责人 / 质量部门') &&
        !raw.includes('复核。'),
      'the surviving row must keep the authored `- ` spelling and stop before 复核'
    )

    // Save and reopen: the deletion must be durable, not resurrected.
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch back to rich mode')
    await sleepMs(600)
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    const saved = await readFile(file, 'utf8')
    assert.ok(!saved.includes('复核'), 'the saved file must not resurrect the deleted tail')
    assert.ok(saved.includes('- 1. 管理层（总经理）'), 'the untouched numbered rows must survive')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    const rich = await app.evaluate(`(() => {
      const editors = [...document.querySelectorAll('.ProseMirror')].filter((n) => n.offsetParent)
      const editor = editors.find((ed) => ed.textContent.includes('使用说明'))
      return editor ? editor.textContent : 'NO-EDITOR'
    })()`)
    assert.ok(
      rich && !rich.includes('复核') && !rich.includes('ce'),
      `the reopened document must not show the deleted content (got ${JSON.stringify(rich?.slice(-40))})`
    )

    console.log('PASS diverged partial delete: tail deletion survives mode switch, save, and full reopen')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
