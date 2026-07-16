// CDP drift MEASUREMENT (not pass/fail) for rich↔source mode switch.
// For each scenario: place caret/scroll in RICH → read caret ctx + viewport-top
// text + scrollTop → toggle to source → wait for multi-pass restore → read again
// → toggle back → read again. Prints a drift report so we can SEE what actually
// drifts (caret? viewport? both?) before designing a fix.
import { connectCdp, sleep } from './lib/cdp.mjs'

const evals = (evaluate) => async (expression) => {
  try {
    return await evaluate(expression)
  } catch (error) {
    return { __error: error.message }
  }
}

async function toggleSource(ev) {
  await ev(`(() => { const b=[...document.querySelectorAll('.status-btn')].find(x=>x.title && x.title.includes('Ctrl+/')); if(b)b.click(); return !!b })()`)
}

// Read the current state: mode, caret context (visible text around caret), and
// the text at the top of the viewport + scroll metrics.
async function readState(ev) {
  return ev(`(() => {
    const res = { mode: 'unknown', caretCtx: null, viewTop: null, scroll: null }
    const txtarea = document.querySelector('.source-editor')
    const pm = [...document.querySelectorAll('.ProseMirror')].find(p => p.offsetParent)
    if (txtarea && document.activeElement !== null) {
      // could still be rich; pick whichever is actually visible
    }
    // Detect mode by which surface is visible
    const richVisible = pm && pm.offsetParent !== null
    const srcVisible = txtarea && txtarea.offsetParent !== null
    if (srcVisible && (!richVisible || txtarea.closest('.editor-scroll')?.offsetParent !== null)) {
      res.mode = 'source'
      const ta = txtarea
      const md = ta.value, s = ta.selectionStart, e = ta.selectionEnd
      res.caretCtx = { start: s, end: e, before: md.slice(Math.max(0,s-18), s), after: md.slice(s, s+18) }
      // viewport-top text in source: approximate char at scrollTop, read ~18 chars
      const denom = ta.scrollHeight - ta.clientHeight
      const approx = denom > 0 ? Math.round((ta.scrollTop / denom) * md.length) : 0
      res.viewTop = md.slice(approx, approx + 22).replace(/\\n/g,' ')
      res.scroll = { top: Math.round(ta.scrollTop), h: Math.round(ta.scrollHeight), ch: ta.clientHeight }
      return res
    }
    if (pm) {
      res.mode = 'rich'
      const sel = getSelection()
      let ctx = null
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0)
        const txt = pm.textContent || ''
        // caret offset in visible text: walk to caret
        const beforeR = document.createRange(); beforeR.selectNodeContents(pm); beforeR.setEnd(r.startContainer, r.startOffset)
        const before = beforeR.toString()
        const at = before.length
        ctx = { at, before: before.slice(-18), after: txt.slice(at, at+18) }
      }
      res.caretCtx = ctx
      // viewport-top text: caretPositionFromPoint at scroll container top-center
      const scroller = pm.closest('.editor-scroll') || document.querySelector('.editor-scroll')
      let vt = null
      if (scroller) {
        const r = scroller.getBoundingClientRect()
        const pos = document.caretPositionFromPoint ? document.caretPositionFromPoint(r.left + r.width/2, r.top + 6) : null
        if (pos) {
          const tn = pos.offsetNode, off = pos.offset
          const rr = document.createRange()
          try { rr.selectNodeContents(tn); rr.setStart(tn, off); vt = rr.toString().slice(0, 22).replace(/\\n/g,' ') } catch {}
        }
        res.scroll = { top: Math.round(scroller.scrollTop), h: Math.round(scroller.scrollHeight), ch: scroller.clientHeight }
      }
      res.viewTop = vt
      return res
    }
    return res
  })()`)
}

// Place the caret in RICH mode by finding a marker text node + setting a Range
// at a char offset within it, then focusing so ProseMirror reconciles. `marker`
// is a unique substring; `after` = chars to skip past the marker start.
async function placeRichCaret(ev, marker, after = 0, focus = true) {
  return ev(`(() => {
    const pm = [...document.querySelectorAll('.ProseMirror')].find(p => p.offsetParent)
    if (!pm) return { error: 'no visible ProseMirror' }
    const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const tn = walker.currentNode
      const idx = tn.nodeValue.indexOf(${JSON.stringify(marker)})
      if (idx >= 0) {
        const off = Math.min(idx + ${after}, tn.nodeValue.length)
        const r = document.createRange()
        r.setStart(tn, off); r.collapse(true)
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r)
        if (${focus}) pm.focus({ preventScroll: true })
        return { ok: true, nodeText: tn.nodeValue.slice(0, 30), off }
      }
    }
    return { error: 'marker not found', marker: ${JSON.stringify(marker)} }
  })()`)
}

// Scroll the rich editor so a marker text node sits near the top of the viewport.
async function scrollRichToMarker(ev, marker) {
  return ev(`(() => {
    const pm = [...document.querySelectorAll('.ProseMirror')].find(p => p.offsetParent)
    if (!pm) return { error: 'no pm' }
    const scroller = pm.closest('.editor-scroll')
    const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      if (walker.currentNode.nodeValue.includes(${JSON.stringify(marker)})) {
        const r = document.createRange(); r.selectNodeContents(walker.currentNode)
        const top = r.getBoundingClientRect().top
        const sTop = scroller.getBoundingClientRect().top
        scroller.scrollTop += (top - sTop - 10)
        return { ok: true, newTop: Math.round(scroller.scrollTop) }
      }
    }
    return { error: 'marker not found' }
  })()`)
}

const scenarios = [
  { name: 'para-mid (§1 p2 mid)', marker: '文字再多一些', after: 4 },
  { name: 'after-url (§1 p1)', marker: '了解更多详情', after: 4 },
  { name: 'list-item (§2 ul)', marker: '紧跟在这后面', after: 3 },
  { name: 'blockquote (§2)', marker: '引用块里测试', after: 4 },
  { name: 'code-block (§3)', marker: 'return a + b', after: 4 },
  { name: 'table cell (§3)', marker: '九十五', after: 1 },
  { name: 'after-image (§4)', marker: '图片之后的段落', after: 4 },
  { name: 'heading (§5)', marker: '长文本区', after: 1 },
  { name: 'long-para (§5 p1)', marker: '产生明显的高度差', after: 4 },
]

async function runScenario(ev, s) {
  // ensure RICH mode first
  if (await ev(`!!document.querySelector('.source-editor') && document.querySelector('.source-editor').offsetParent !== null`)) {
    await toggleSource(ev); await sleep(800)
  }
  const placed = await placeRichCaret(ev, s.marker, s.after)
  await sleep(120) // let ProseMirror reconcile the selection
  const richBefore = await readState(ev)

  await toggleSource(ev); await sleep(950) // multi-pass restore ≤450ms
  const inSrc = await readState(ev)

  await toggleSource(ev); await sleep(950)
  const richAfter = await readState(ev)

  return { scenario: s.name, placed, richBefore, source: inSrc, richAfter }
}

// The KEY viewing scenario: scroll to §5 (middle), leave the caret up at §1,
// toggle, and check whether the viewport stays at §5 or jumps to the caret (§1).
async function viewingScenario(ev) {
  // ensure rich
  if (await ev(`document.querySelector('.source-editor') && document.querySelector('.source-editor').offsetParent !== null`)) {
    await toggleSource(ev); await sleep(800)
  }
  // place caret up top (§1) — this is where it'll be captured
  await placeRichCaret(ev, '了解更多详情', 4, true)
  await sleep(120)
  // now scroll DOWN to §5 without moving the caret
  await scrollRichToMarker(ev, '产生明显的高度差')
  await sleep(150)
  const richBefore = await readState(ev)

  await toggleSource(ev); await sleep(950)
  const inSrc = await readState(ev)

  await toggleSource(ev); await sleep(950)
  const richAfter = await readState(ev)
  return { scenario: 'VIEWING (scroll §5, caret §1)', richBefore, source: inSrc, richAfter }
}

async function main() {
  const { ws, send, evaluate } = await connectCdp({ intervalMs: 500 })
  await send('Runtime.enable')
  const ev = evals(evaluate)

  // Activate the test tab
  await ev(`(() => { const t=[...document.querySelectorAll('.tab')].find(x=>x.textContent.includes('hmcaret-doc2') || x.textContent.includes('漂移测试')); if(t)t.click(); return true })()`)
  await sleep(800)

  const results = []
  for (const s of scenarios) {
    try { results.push(await runScenario(ev, s)) } catch (e) { results.push({ scenario: s.name, error: e.message }) }
  }
  try { results.push(await viewingScenario(ev)) } catch (e) { results.push({ scenario: 'VIEWING', error: e.message }) }

  console.log(JSON.stringify(results, null, 2))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(3) })
