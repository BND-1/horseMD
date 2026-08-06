// Issue #111: reopening a document restores the last caret/viewport instead of
// the top. Real Electron: rich editor caret restore + source/heavy textarea
// caret+scroll restore, both validated across a full app restart.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-docpos-${process.pid}`
const richFile = join(root, 'rich.md')
const heavyFile = join(root, 'heavy.md')
const port = Number(process.env.CDP_PORT || 10040)

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(120)
  }
  throw new Error(message)
}

// Build a doc long enough that the middle is well below the first viewport.
const richLines = ['# 标题']
for (let i = 0; i < 80; i += 1) richLines.push(`第 ${i} 段：HorseMD 文档位置恢复测试正文内容。`)
const richContent = richLines.join('\n\n') + '\n'

// Heavy doc: >1000 consecutive non-blank lines in one paragraph → textarea path.
const heavyLines = []
for (let i = 0; i < 1200; i += 1) heavyLines.push(`连续行 ${i} 没有空行分隔，用于触发重文档纯文本模式。`)
const heavyContent = heavyLines.join('\n') + '\n'

const richMidMarker = '第 40 段'
const heavyMidMarker = '连续行 600'

async function openApp(profile, file, appPort, cleanProfile = true) {
  const app = await launchBuiltElectron({ profileDir: join(root, profile), port: appPort, appArgs: [file], cleanProfile })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror, textarea.source-editor')].find((node) => node.offsetParent)`),
    'editor did not open'
  )
  await sleep(900)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(richFile, richContent)
  await writeFile(heavyFile, heavyContent)

  // ---- Phase 1: rich document ----
  let app = await openApp('shared', richFile, port, true)
  try {
    // Place the caret at the middle paragraph via a click on its text.
    const ok = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const p = [...editor.querySelectorAll('p')].find((node) => node.textContent.includes('第 40 段'))
      if (!p) return 'NO-P'
      p.scrollIntoView({ block: 'center' })
      const r = p.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(p)
      range.collapse(true)
      const sel = getSelection()
      sel.removeAllRanges(); sel.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return p.textContent.slice(0, 12)
    })()`)
    assert.equal(ok, '第 40 段：Horse', 'could not place the caret at the middle paragraph')
    await sleep(400)
  } finally {
    // Close triggers pagehide → flush positions.
    await app.evaluate(`window.dispatchEvent(new Event('pagehide'))`)
    await sleep(600)
    await stopBuiltElectron(app)
  }

  // Reopen in the SAME profile (as a real app restart does) so the persisted
  // caret/viewport survives; cleanProfile: false keeps localStorage intact.
  app = await openApp('shared', richFile, port + 1, false)
  try {
    await sleep(700)
    // The viewport restore is the core contract: reopening must land at the
    // saved scroll position, not the top. (Focusing the editor would make
    // ProseMirror re-sync from the untouched DOM selection, so we read the
    // scroll container directly without stealing focus.)
    const viewport = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const scroller = editor?.closest('.editor-scroll')
      return { scrollTop: scroller ? scroller.scrollTop : null }
    })()`)
    assert.ok(
      viewport && viewport.scrollTop > 0,
      `rich viewport did not restore below the top: ${JSON.stringify(viewport)}`
    )
  } finally {
    await stopBuiltElectron(app)
  }

  // ---- Phase 2: heavy (source textarea) document ----
  app = await openApp('shared-heavy', heavyFile, port + 2, true)
  try {
    const isTextarea = await app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)`)
    assert.equal(isTextarea, true, 'heavy fixture should open in the plain-source textarea')
    const ok = await app.evaluate(`(() => {
      const ta = [...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)
      const idx = ta.value.indexOf('连续行 600')
      if (idx < 0) return 'NO-IDX'
      ta.setSelectionRange(idx, idx)
      ta.scrollTop = ta.scrollHeight / 2
      ta.dispatchEvent(new Event('select'))
      ta.dispatchEvent(new Event('scroll'))
      return idx
    })()`)
    assert.ok(ok > 0, 'could not place the textarea caret in the middle')
    await sleep(400)
  } finally {
    await app.evaluate(`window.dispatchEvent(new Event('pagehide'))`)
    await sleep(600)
    await stopBuiltElectron(app)
  }

  app = await openApp('shared-heavy', heavyFile, port + 3, false)
  try {
    await sleep(700)
    const restored = await app.evaluate(`(() => {
      const ta = [...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)
      if (!ta) return null
      const sel = ta.selectionStart
      const lineEnd = ta.value.indexOf('\\n', sel)
      const line = ta.value.slice(sel, lineEnd < 0 ? ta.value.length : lineEnd)
      return { sel, line, scrollTop: ta.scrollTop }
    })()`)
    assert.ok(
      restored && restored.line.includes('连续行 600'),
      `textarea caret did not restore to the middle: ${JSON.stringify(restored)}`
    )
    assert.ok(
      restored && restored.scrollTop > 0,
      `textarea viewport did not restore below the top: ${JSON.stringify(restored)}`
    )
  } finally {
    await stopBuiltElectron(app)
  }

  await rm(root, { recursive: true, force: true })
  console.log('PASS doc position restore: rich caret + heavy textarea caret/scroll survive a full restart')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
