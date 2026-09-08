// E2E for the plain-text drop fix (trace-61614: dropping a `<br />`
// html-flavored fragment split a list item into [empty paragraph, full-text
// paragraph] + stray empty blocks — a PM shape Markdown can't round-trip,
// tripping the source-sync integrity warning). Locked here:
//   1. the drop inserts literal text INLINE (selection replaced, item intact);
//   2. no source-sync warning toast, source mode shows the literal bytes;
//   3. FAB save persists them and a cold reopen is clean;
//   4. multi-line plain text drops insert hardbreaks, not block splits.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-plain-drop-${process.pid}`
const file = join(root, 'brdrop.md')
const port = Number(process.env.CDP_PORT || 9870)
const SOURCE = '# 投标文件检查报告\n\n**项目名称**: test1\n**生成时间**: 2026-09-04 22:47:01\n\n## 检查概要\n\n- 风险等级: ⚪ unknown\n\n## 详细检查结果\n\n| 检查项 | 要求 | 实际 | 状态 | 说明 |\n|--------|------|------|------|------|\n\n---\n*报告由 BidMaster Pro 自动生成*\n\n/'

async function waitFor(check, message, attempts = 120) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

const visibleEditor = (evaluate, expr) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
  if (!editor) return null
  return (${expr})
})()`)

// DragEvent coordinates: posAtCoords needs real client coords, so the drop is
// dispatched on the element under a known rect with matching clientX/Y.
async function dropAt(evaluate, payload, targetExpr, at = 'end') {
  return evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
    if (!editor) return { error: 'no editor' }
    const target = ${targetExpr}
    if (!target) return { error: 'no target' }
    const rect = target.getBoundingClientRect()
    const x = ${at === 'end'
      ? `Math.max(rect.left + 5, rect.right - 6)`
      : `rect.left + Math.min(rect.width - 2, 60)`}
    const y = rect.top + rect.height / 2
    const dt = new DataTransfer()
    ${payload.flavors.map((f) => `dt.setData(${JSON.stringify(f.type)}, ${JSON.stringify(f.data)})`).join('\n    ')}
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt })
    target.dispatchEvent(event)
    return { defaultPrevented: event.defaultPrevented }
  })()`)
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

let failure = null
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, SOURCE, 'utf8')

  const app = await launchBuiltElectron({
    profileDir: join(root, 'profile'), port,
    appArgs: process.env.DROP_TRACE ? [file, '--horsemd-input-trace'] : [file]
  })
  try {
    const { evaluate, send } = app

    await waitFor(
      () => visibleEditor(evaluate, `'ok'`),
      'editor did not mount'
    )
    await waitFor(
      () => visibleEditor(evaluate, `editor.querySelector('li p') ? 'ok' : null`),
      'list item paragraph did not render'
    )

    // 1) The incident shape: select 2 chars inside the list item text, then
    //    drop the `<br />` fragment (both flavors, exactly like trace-61614).
    const point = await visibleEditor(evaluate, `(() => {
      const p = editor.querySelector('li p')
      const rect = p.getBoundingClientRect()
      return { x: Math.max(rect.left + 5, rect.right - 8), y: rect.top + rect.height / 2 }
    })()`)
    await click(send, point)
    await pressKey(send, { key: 'ArrowLeft', modifiers: 8 })
    await pressKey(send, { key: 'ArrowLeft', modifiers: 8 })

    const dropped = await dropAt(evaluate, {
      flavors: [
        { type: 'text/plain', data: '<br />' },
        { type: 'text/html', data: '<br>' }
      ]
    }, `editor.querySelector('li p')`)
    assert.equal(dropped.defaultPrevented, true, 'plain-text drop was not intercepted')

    await sleep(1000)
    const shape = await visibleEditor(evaluate, `(() => {
      const children = editor.querySelector('li .children') || editor.querySelector('li')
      return {
        paragraphs: children.querySelectorAll('p').length,
        text: children.textContent
      }
    })()`)
    assert.equal(shape.paragraphs, 1, `list item split into ${shape.paragraphs} paragraphs`)
    assert.match(shape.text, /unkno\\?<br/, `unexpected item text: ${JSON.stringify(shape.text)}`)
    assert.ok(shape.text.includes('风险等级'), 'list item text lost')

    // No source-sync warning toast.
    await sleep(400)
    assert.equal(await evaluate(`document.querySelector('.hm-toast')?.textContent ?? null`), null, 'warning toast appeared')

    // 1b) Multi-line plain-text drop into a top-level paragraph: lines join
    //     with hardbreaks INSIDE the paragraph — not block splits.
    const multi = await dropAt(evaluate, {
      flavors: [{ type: 'text/plain', data: '第一行\n第二行' }]
    }, `[...editor.querySelectorAll(':scope > p')].at(-1)`)
    assert.equal(multi.defaultPrevented, true, 'multi-line drop was not intercepted')
    await sleep(1000)
    const paraCount = await visibleEditor(evaluate, `(() => {
      const paras = [...editor.querySelectorAll(':scope > p')]
      const last = paras.at(-1)
      return { total: paras.length, text: last?.textContent ?? '' }
    })()`)
    assert.match(paraCount.text, /第一行第二行/, `multi-line drop text wrong: ${JSON.stringify(paraCount.text)}`)
    await sleep(400)
    assert.equal(await evaluate(`document.querySelector('.hm-toast')?.textContent ?? null`), null, 'warning toast after multi-line drop')

    // 2) Source mode shows the literal inserted bytes.
    assert.equal(await toggleSource(evaluate), true, 'source toggle missing')
    const source = await waitFor(visibleSource.bind(null, evaluate), 'source textarea did not appear')
    assert.match(source, /unkno\\?<br/, `literal drop text missing from source: ${JSON.stringify(source.slice(80, 200))}`)
    assert.ok(source.includes('- 风险等级'), 'list marker line lost')

    // 3) FAB save persists the bytes.
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    const disk = await readFile(file, 'utf8')
    assert.match(disk, /unkno\\?<br/, 'disk bytes missing the dropped text')
    await stopBuiltElectron(app)
  } finally {
    await stopBuiltElectron(app).catch(() => {})
  }

  // 4) Cold reopen: content intact, no warning.
  const reopened = await launchBuiltElectron({ profileDir: join(root, 'profile2'), port: port + 1, appArgs: [file] })
  try {
    const { evaluate } = reopened
    await waitFor(
      () => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
        return editor?.querySelector('li') ? 'ok' : null
      })()`),
      'reopened editor did not mount'
    )
    await sleep(800)
    assert.equal(await evaluate(`document.querySelector('.hm-toast')?.textContent ?? null`), null, 'warning toast after reopen')
    const text = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
      const children = editor.querySelector('li .children') || editor.querySelector('li')
      return children.textContent
    })()`)
    assert.match(text, /unkno/, 'reopened item text lost')
  } finally {
    await stopBuiltElectron(reopened)
  }

  console.log('\nplain-text drop UI: all checks passed')
} catch (err) {
  failure = err
  console.error('\nplain-text drop UI FAILED:')
  console.error(err)
} finally {
  await rm(root, { recursive: true, force: true })
}
process.exit(failure ? 1 : 0)
