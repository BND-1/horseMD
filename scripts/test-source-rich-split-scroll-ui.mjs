// Source + preview scroll link on a table- and code-heavy CRLF document
// (user report 2026-11-19, Windows: the panes drifted apart by whole
// sections; rich → source by up to two screens). Every heading put at the
// top of one pane must land at the top of the other (both directions), and
// table rows too; both panes reach the bottom together. The link pairs
// source blocks with rendered elements and interpolates between them
// (lib/split-scroll-map.js).
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const dir = join(tmpdir(), 'horsemd-source-rich-split-scroll')
const file = join(dir, 'split-scroll.md')
const port = Number(process.env.CDP_PORT || 9886)
const TOLERANCE = 40

const table = (n, rows) => [
  `| 名称 | 网络名 | 方向 | 备注 |`,
  `|---|---|---|---|`,
  ...Array.from({ length: rows }, (_, r) => `| 第 ${n}.${r + 1} 项 | \`SIG_${n}_${r + 1}\` | DCB → PRB | 说明文字较长的一格，**加粗**和 \`code\` 混排，${'测试'.repeat(r % 4 + 1)} |`)
].join('\n')
const code = (n, lines) => ['```', ...Array.from({ length: lines }, (_, l) => `UC-${n}-${l}.SchDoc      第 ${l} 页说明`), '```'].join('\n')
const sections = Array.from({ length: 14 }, (_, n) => [
  `## ${n + 1}. 第 ${n + 1} 节`,
  `> 引用说明：这一节有 **${n + 1}** 个要点，混排 \`inline\` 代码。`,
  code(n, 4 + (n % 3) * 6),
  `### ${n + 1}.1 表格`,
  table(n, 4 + (n % 4) * 5),
  `- 列表项一，${'内容'.repeat(n % 5 + 1)}\n- 列表项二\n  - 嵌套项`,
  '---'
].join('\n\n'))
const source = ['# 双栏滚动联动', '', ...sections].join('\n\n').replace(/\n/g, '\r\n') + '\r\n'

async function waitFor(check, message, attempts = 200, delay = 30) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(delay)
  }
  throw new Error(message)
}

// The other pane follows in an animation frame, which a Windows test window
// may get late: poll until the offset is within tolerance (or stops moving).
async function settled(evaluate, expression, attempts = 120) {
  let last = null
  let still = 0
  for (let index = 0; index < attempts; index += 1) {
    await sleep(25)
    const value = await evaluate(expression)
    if (Math.abs(value) <= TOLERANCE) return value
    still = value === last ? still + 1 : 0
    last = value
    if (still >= 60) break
  }
  return last
}

async function main() {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, source, 'utf8')
  const app = await launchBuiltElectron({ profileDir: join(dir, 'profile'), port, appArgs: [file] })
  try {
    const { evaluate, send } = app
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent && node.dataset.horsemdReady === 'true')`),
      'Rich editor did not become ready'
    )
    try {
      const { windowId } = await send('Browser.getWindowForTarget')
      await send('Browser.setWindowBounds', { windowId, bounds: { width: 1280, height: 760 } })
    } catch {}
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const target = editor.querySelector('h1, p')
      const rect = target.getBoundingClientRect()
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 8 }))
    })()`)
    await waitFor(() => evaluate(`!!document.querySelector('[data-source-rich-toggle]')`), 'Source + preview missing from the context menu')
    await evaluate(`document.querySelector('[data-source-rich-toggle]').click()`)
    await waitFor(() => evaluate(`!!document.querySelector('textarea.source-editor.hm-source-rich-left')?.offsetParent`), 'Split did not open')
    await sleep(600)

    // Test-side source geometry: a mirror of the textarea (span offsetTop).
    await evaluate(`(() => {
      const ta = () => document.querySelector('textarea.source-editor.hm-source-rich-left')
      const rs = () => document.querySelector('.editor-scroll.hm-source-rich-right')
      let mirror
      window.__srcTop = (offset) => {
        const t = ta(); const cs = getComputedStyle(t)
        if (!mirror) { mirror = document.createElement('div'); document.body.appendChild(mirror) }
        for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'tabSize', 'wordBreak', 'overflowWrap', 'boxSizing']) mirror.style[p] = cs[p]
        Object.assign(mirror.style, { position: 'absolute', left: '-9999px', top: '0', visibility: 'hidden', whiteSpace: 'pre-wrap', width: t.clientWidth + 'px' })
        mirror.textContent = t.value.slice(0, offset)
        const s = document.createElement('span'); s.textContent = '\\u200b'; mirror.appendChild(s)
        return s.offsetTop - parseFloat(cs.paddingTop)
      }
      window.__lines = (re) => { const v = ta().value; const out = []; let m; const rx = new RegExp(re, 'gm'); while ((m = rx.exec(v))) out.push(m.index); return out }
      window.__scrollSource = (top) => { const t = ta(); t.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); t.scrollTop = top; t.dispatchEvent(new Event('scroll')) }
      window.__scrollRich = (top) => { const r = rs(); r.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); r.scrollTop = top; r.dispatchEvent(new Event('scroll')) }
      window.__richTop = (el) => el.getBoundingClientRect().top - rs().getBoundingClientRect().top
      window.__ta = ta; window.__rs = rs
    })()`)

    const headings = await evaluate(`__lines('^#{1,6} ')`)
    const richHeadings = await evaluate(`__rs().querySelectorAll('.ProseMirror > :is(h1,h2,h3,h4,h5,h6)').length`)
    assert.equal(richHeadings, headings.length, 'Heading count differs between panes')
    const failures = []
    let checked = 0
    for (let i = 0; i < headings.length; i++) {
      // Headings in the last screen cannot reach the top of the preview.
      const reachable = await evaluate(`(() => { const h = __rs().querySelectorAll('.ProseMirror > :is(h1,h2,h3,h4,h5,h6)')[${i}]; const r = __rs(); return h.getBoundingClientRect().top - r.getBoundingClientRect().top + r.scrollTop < r.scrollHeight - r.clientHeight - 20 && __srcTop(${headings[i]}) < __ta().scrollHeight - __ta().clientHeight - 20 })()`)
      if (!reachable) continue
      checked++
      await evaluate(`__scrollSource(__srcTop(${headings[i]}))`)
      const sourceToRich = await settled(evaluate, `Math.round(__richTop(__rs().querySelectorAll('.ProseMirror > :is(h1,h2,h3,h4,h5,h6)')[${i}]))`)
      await evaluate(`(() => { const h = __rs().querySelectorAll('.ProseMirror > :is(h1,h2,h3,h4,h5,h6)')[${i}]; __scrollRich(__rs().scrollTop + __richTop(h)) })()`)
      const richToSource = await settled(evaluate, `Math.round(__srcTop(${headings[i]}) - __ta().scrollTop)`)
      if (Math.abs(sourceToRich) > TOLERANCE || Math.abs(richToSource) > TOLERANCE) failures.push({ heading: i, sourceToRich, richToSource })
    }
    assert.ok(checked >= 20, `Too few headings checked: ${checked}`)
    assert.deepEqual(failures, [], `Headings out of line between panes (px): ${JSON.stringify(failures)}`)

    const rows = await evaluate(`__lines('^\\\\|(?![\\\\s:|-]+\\\\|?\\\\s*$).*$')`)
    assert.equal(rows.length, await evaluate(`__rs().querySelectorAll('.ProseMirror tr').length`), 'Table row count differs')
    const rowFailures = []
    for (let k = 3; k < rows.length; k += 7) {
      const reachable = await evaluate(`__srcTop(${rows[k]}) < __ta().scrollHeight - __ta().clientHeight - 20`)
      if (!reachable) continue
      await evaluate(`__scrollSource(__srcTop(${rows[k]}))`)
      const offset = await settled(evaluate, `Math.round(__richTop(__rs().querySelectorAll('.ProseMirror tr')[${k}]))`)
      if (Math.abs(offset) > TOLERANCE) rowFailures.push({ row: k, offset })
    }
    assert.deepEqual(rowFailures, [], `Table rows out of line (px): ${JSON.stringify(rowFailures)}`)

    await evaluate(`__scrollSource(__ta().scrollHeight)`)
    const richLeft = await settled(evaluate, `Math.round(__rs().scrollHeight - __rs().clientHeight - __rs().scrollTop)`)
    assert.ok(richLeft <= 2, `Preview did not reach the bottom with the source: ${richLeft}px left`)
    await evaluate(`__scrollRich(0)`)
    assert.equal(await settled(evaluate, `Math.round(__ta().scrollTop) && __ta().scrollTop + ${TOLERANCE + 1}`), 0, 'Source did not return to the top with the preview')
    assert.equal(await evaluate(`!!document.querySelector('.tab-close.dirty')`), false, 'Scrolling marked the document dirty')
    console.log(`PASS source + preview scroll link: ${checked} headings both ways, table rows, bottom and top`)
  } finally {
    await stopBuiltElectron(app)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
