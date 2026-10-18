// Mac mini 0.13.248 trace (2026-10-17): Enter at the start of a paragraph, Up
// into the new empty line, paste an image. Two faults:
// - the paragraph preservation layer compared only visible text, and an image
//   has none, so the paste looked like a "middle empty block boundary only"
//   change and kept the old source (without the image);
// - Milkdown's remark-image-block drops the source position of a standalone
//   image, so the reprint engine could not place the next edit beside it.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const source = [
  '# 标题', '', '在相册里打开一张照片，往上滑能看到小地图。', '',
  '![](a.png)', '', '如果显示的是“添加位置”，就是以前没开定位。', '',
  '我这条开头的路线地图，是根据定位画的。', ''
].join('\n')
const root = await mkdtemp(join(tmpdir(), 'horsemd-image-empty-line-'))
await writeFile(join(root, 'a.png'), Buffer.from(png, 'base64'))
const cases = [
  { label: 'Enter at paragraph start, Up, paste', target: '如果显示的是', at: 'start', after: 'up' },
  { label: 'Enter at paragraph end, paste', target: '往上滑能看到小地图', at: 'end', after: 'none' },
  { label: 'Enter at paragraph start, Up, paste, keep typing', target: '如果显示的是', at: 'start', after: 'up', type: '图注' }
]
let failures = 0
for (const [index, testCase] of cases.entries()) {
  const file = join(root, `doc-${index}.md`)
  await writeFile(file, source)
  const app = await launchBuiltElectron({
    profileDir: join(root, `profile-${index}`), cleanProfile: false,
    port: 29760 + index + process.pid % 30, appArgs: [file, '--horsemd-input-trace']
  })
  const send = app.send.bind(app)
  const waitFor = async (check, message, attempts = 80) => {
    for (let i = 0; i < attempts; i += 1) { const value = await check(); if (value) return value; await sleep(100) }
    throw new Error(message)
  }
  try {
    await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('路线地图')`), 'document did not open')
    await sleep(1200)
    await app.evaluate(`(() => {
      globalThis.__hmSourceReprintTrace = []; globalThis.__hmParagraphTrace = []
      window.__toasts = []
      const seen = new WeakSet()
      new MutationObserver(() => {
        for (const node of document.querySelectorAll('.hm-toast-msg')) if (!seen.has(node)) { seen.add(node); window.__toasts.push(node.textContent) }
      }).observe(document.body, { childList: true, subtree: true })
    })()`)
    const point = await app.evaluate(`(() => {
      const p = [...(${editor}).querySelectorAll('p')].find(n => n.textContent.includes(${JSON.stringify(testCase.target)}))
      const r = p.getBoundingClientRect(); return {x: r.left + 4, y: r.top + 10}
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
    await sleep(200)
    await pressKey(send, { key: testCase.at === 'start' ? 'Home' : 'End' })
    await pressKey(send, { key: 'Enter', text: '\r' })
    await sleep(600)
    if (testCase.after === 'up') { await pressKey(send, { key: 'ArrowUp' }); await sleep(300) }
    await app.evaluate(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(png)}), c => c.charCodeAt(0))
      const data = new DataTransfer(); data.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
      ;(document.activeElement || ${editor}).dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    })()`)
    await waitFor(() => app.evaluate(`Boolean((${editor}).querySelector('p img'))`), 'pasted image did not appear')
    await sleep(1200)
    if (testCase.type) { await typeTextLikeUser(send, testCase.type); await sleep(1000) }
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button not shown')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    const saved = await waitFor(async () => {
      const text = await readFile(file, 'utf8')
      return /!\[image\.png\]/.test(text) && text
    }, `image not saved: ${JSON.stringify(await readFile(file, 'utf8'))}`, 40)
    const toasts = await app.evaluate('window.__toasts.slice()')
    assert.equal(toasts.some((text) => warningPattern.test(text)), false, `warning: ${JSON.stringify(toasts)}`)
    assert.deepEqual(await app.evaluate('(globalThis.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).map(e => e.preservationReason)'), [])
    const image = `!\\[image\\.png\\]\\([^)\\n]+\\)${testCase.type ? testCase.type : ''}`
    const expected = testCase.at === 'start'
      ? new RegExp(`\\n\\n!\\[\\]\\(a\\.png\\)\\n\\n${image}\\n\\n如果显示的是`)
      : new RegExp(`往上滑能看到小地图。\\n\\n${image}\\n\\n!\\[\\]\\(a\\.png\\)`)
    assert.match(saved, expected, `saved: ${JSON.stringify(saved)}`)
    // Everything except the new image paragraph keeps its bytes.
    const withoutNew = saved.replace(new RegExp(`${image}\\n\\n`), '')
    assert.equal(withoutNew, source, `other bytes changed: ${JSON.stringify(saved)}`)
    console.log(`ok   ${testCase.label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${testCase.label}: ${String(error?.message || error).slice(0, 600)}`)
    console.log('DIAGNOSTIC', JSON.stringify(await app.evaluate(`({
      toasts: window.__toasts,
      bad: (globalThis.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).slice(-3).map(e => ({ reason: e.preservationReason, site: e.validationSite })),
      reprint: (globalThis.__hmSourceReprintTrace || []).slice(-4).map(e => JSON.stringify(e).slice(0, 400)),
      paragraph: (globalThis.__hmParagraphTrace || []).slice(-4).map(e => JSON.stringify(e).slice(0, 400)),
      harness: (() => { const h = globalThis.__hmSourceReprintHarness; if (!h) return null; const doc = h.liveDoc(); const canon = h.serialize(doc)
        const para = (d) => { const out = []; d.forEach(n => { if (n.type.name === 'paragraph' && n.textContent.includes('图注')) out.push(n.toJSON()) }); return out }
        const r = h.reprint(h.liveSource(), doc); return { reprintOut: r.markdown, reprintReason: r.reason, liveSource: h.liveSource(), canon, canonEquivalent: h.equivalent(canon, doc), livePara: para(doc), canonPara: para(h.parse(canon)) } })(),
      paragraphs: [...(${editor}).children].map(n => n.tagName + ':' + (n.querySelector('img') ? '[img]' : '') + n.textContent.slice(0, 20))
    })`)).slice(0, 6000))
  } finally {
    await stopBuiltElectron(app)
  }
}
console.log(failures ? `FAIL image paste on an empty line: ${failures}/${cases.length} failed` : 'PASS image paste on an empty line: Enter then paste an image saves the new image paragraph without a warning, other bytes unchanged')
process.exit(failures ? 1 : 0)
