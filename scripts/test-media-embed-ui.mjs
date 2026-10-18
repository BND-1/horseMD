// Typora-style media embeds: `<video>` / `<audio>` / `<iframe>` raw HTML renders
// as a playable player (relative src resolved against the document folder),
// editing next to it keeps every authored byte, and dropping a video file
// inserts `<video src="…" controls></video>`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const root = await mkdtemp(join(tmpdir(), 'horsemd-media-embed-'))
// Two tiny real files so the players can load metadata.
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '1', '-pix_fmt', 'yuv420p', join(root, 'clip.mp4')])
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', join(root, 'tone.mp3')])
execFileSync('cp', [join(root, 'clip.mp4'), join(root, 'dropped clip.mp4')])
const source = [
  '# 视频', '',
  '第一段文字。', '',
  '<video src="clip.mp4"></video>', '',
  '<audio src="./tone.mp3"></audio>', '',
  '<iframe src="https://player.bilibili.com/player.html?bvid=BV1xx411c7mD" width="560" height="315"></iframe>', '',
  '<iframe src="javascript:alert(1)"></iframe>', '',
  '最后一段。', ''
].join('\n')
const file = join(root, 'doc.md')
await writeFile(file, source)

const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), port: 29810 + process.pid % 40, appArgs: [file, '--horsemd-input-trace']
})
const send = app.send.bind(app)
const waitFor = async (check, message, attempts = 80) => {
  for (let i = 0; i < attempts; i += 1) { const value = await check(); if (value) return value; await sleep(100) }
  throw new Error(message)
}
let failed = false
try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('最后一段')`), 'document did not open')
  await app.evaluate(`(() => {
    window.__toasts = []
    const seen = new WeakSet()
    new MutationObserver(() => {
      for (const node of document.querySelectorAll('.hm-toast-msg')) if (!seen.has(node)) { seen.add(node); window.__toasts.push(node.textContent) }
    }).observe(document.body, { childList: true, subtree: true })
  })()`)

  // 1. Render: a real player with controls, metadata loaded from the relative file.
  const media = await waitFor(() => app.evaluate(`(() => {
    const ed = ${editor}
    const v = ed.querySelector('video'), a = ed.querySelector('audio')
    if (!v || !a || v.readyState < 1 || a.readyState < 1) return null
    return {
      video: { src: v.currentSrc, controls: v.controls, width: v.videoWidth, inBlock: !!v.closest('.hm-html-media-block') },
      audio: { src: a.currentSrc, controls: a.controls },
      iframes: [...ed.querySelectorAll('iframe')].map(f => ({ src: f.getAttribute('src'), sandbox: f.getAttribute('sandbox') })),
      escapedText: ed.textContent.includes('<video')
    }
  })()`), 'video/audio did not load metadata', 120)
  assert.match(media.video.src, /^file:\/\/.*\/clip\.mp4$/)
  assert.equal(media.video.controls, true)
  assert.equal(media.video.width, 160)
  assert.equal(media.video.inBlock, true)
  assert.match(media.audio.src, /^file:\/\/.*\/tone\.mp3$/)
  assert.equal(media.audio.controls, true)
  assert.equal(media.iframes.length, 1, `only the https iframe is kept: ${JSON.stringify(media.iframes)}`)
  assert.match(media.iframes[0].src, /^https:\/\/player\.bilibili\.com\//)
  assert.match(media.iframes[0].sandbox, /allow-scripts/)
  assert.equal(media.escapedText, false, 'video tag shown as text')
  console.log('ok   video/audio/iframe render as players')

  // 2. Playback works from the controls (not swallowed by ProseMirror).
  const played = await app.evaluate(`(async () => {
    const v = (${editor}).querySelector('video'); v.muted = true
    try { await v.play() } catch (e) { return String(e) }
    await new Promise(r => setTimeout(r, 400)); const t = v.currentTime; v.pause(); return t > 0
  })()`)
  assert.equal(played, true, `video did not play: ${played}`)
  const box = await app.evaluate(`(() => { const r = (${editor}).querySelector('video').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...box })
  await sleep(300)
  const pmSelectedVideo = await app.evaluate(`!!(${editor}).querySelector('.ProseMirror-selectednode video')`)
  assert.equal(pmSelectedVideo, false, 'click on the player became a node selection')
  console.log('ok   player controls receive clicks')

  // 3. Edit next to the embeds; every authored byte survives.
  const point = await app.evaluate(`(() => { const p = [...(${editor}).querySelectorAll('p')].find(n => n.textContent.includes('第一段文字')); const r = p.getBoundingClientRect(); return { x: r.right - 2, y: r.top + r.height / 2 } })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
  await sleep(200)
  await pressKey(send, { key: 'End' })
  await typeTextLikeUser(send, '加字')
  await sleep(800)
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  const saved = await waitFor(async () => { const t = await readFile(file, 'utf8'); return t.includes('第一段文字。加字') && t }, 'edit not saved')
  assert.equal(saved, source.replace('第一段文字。', '第一段文字。加字'), `bytes changed: ${JSON.stringify(saved)}`)
  console.log('ok   editing beside embeds keeps their source')

  // 4. Drop a video file at the end of the last paragraph.
  const last = await app.evaluate(`(() => { const p = [...(${editor}).querySelectorAll('p')].find(n => n.textContent.includes('最后一段')); p.scrollIntoView({ block: 'center' }); const r = p.getBoundingClientRect(); return { x: r.right - 2, y: r.top + r.height / 2 } })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...last })
  await sleep(200)
  await pressKey(send, { key: 'End' })
  await pressKey(send, { key: 'Enter', text: '\r' })
  await sleep(400)
  const dropAt = await app.evaluate(`(() => { const sel = getSelection(); const r = sel.getRangeAt(0).getBoundingClientRect(); const p = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement; const b = p.getBoundingClientRect(); return { x: b.left + 4, y: (r.height ? r.top + r.height / 2 : b.top + b.height / 2) } })()`)
  const dragData = { items: [], files: [join(root, 'dropped clip.mp4')], dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await send('Input.dispatchDragEvent', { type, ...dropAt, data: dragData })
    await sleep(120)
  }
  await waitFor(() => app.evaluate(`(${editor}).querySelectorAll('video').length === 2`), 'dropped video not inserted')
  await sleep(800)
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  const afterDrop = await waitFor(async () => { const t = await readFile(file, 'utf8'); return t.includes('dropped clip.mp4') && t }, 'drop not saved')
  assert.equal(afterDrop, saved.replace('最后一段。\n', '最后一段。\n\n<video src="dropped clip.mp4" controls></video>\n'), `drop saved: ${JSON.stringify(afterDrop)}`)
  const droppedLoaded = await waitFor(() => app.evaluate(`(${editor}).querySelectorAll('video')[1].readyState >= 1`), 'dropped video did not load')
  assert.equal(droppedLoaded, true)
  console.log('ok   dropping a video file inserts a <video> tag')

  // 5. Drop onto the middle of a paragraph: the player goes on its own line
  // after that paragraph; the paragraph is not split.
  const mid = await app.evaluate(`(() => { const p = [...(${editor}).querySelectorAll('p')].find(n => n.textContent.includes('第一段文字')); p.scrollIntoView({ block: 'center' }); const r = p.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 } })()`)
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await send('Input.dispatchDragEvent', { type, ...mid, data: { items: [], files: [join(root, 'tone.mp3')], dragOperationsMask: 1 } })
    await sleep(120)
  }
  await waitFor(() => app.evaluate(`(${editor}).querySelectorAll('audio').length === 2`), 'dropped audio not inserted')
  await sleep(800)
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  const afterMid = await waitFor(async () => { const t = await readFile(file, 'utf8'); return t.includes('<audio src="tone.mp3"') && t }, 'mid drop not saved')
  assert.equal(afterMid, afterDrop.replace('第一段文字。加字\n', '第一段文字。加字\n\n<audio src="tone.mp3" controls></audio>\n'), `mid drop saved: ${JSON.stringify(afterMid)}`)
  console.log('ok   dropping onto text inserts the player after the paragraph')

  const toasts = await app.evaluate('window.__toasts.slice()')
  assert.equal(toasts.some((t) => warningPattern.test(t)), false, `warning: ${JSON.stringify(toasts)}`)
  assert.deepEqual(await app.evaluate('(globalThis.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).map(e => e.preservationReason)'), [])
} catch (error) {
  failed = true
  console.log(`FAIL ${String(error?.message || error).slice(0, 1500)}`)
  console.log('DIAGNOSTIC', JSON.stringify(await app.evaluate(`({
    toasts: window.__toasts,
    blocks: [...(${editor}).children].map(n => n.tagName + '.' + n.className + ':' + n.textContent.slice(0, 30)),
    reprint: (globalThis.__hmSourceReprintTrace || []).slice(-3).map(e => JSON.stringify(e).slice(0, 400))
  })`).catch((e) => String(e))).slice(0, 4000))
} finally {
  await stopBuiltElectron(app)
}
console.log(failed ? 'FAIL media embed' : 'PASS media embed: video/audio/iframe render and play, source bytes kept, dropped video inserts a <video> tag')
process.exit(failed ? 1 : 0)
